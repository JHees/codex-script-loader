using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed record PluginReleaseInfo(string Repository, string TagName, string HtmlUrl)
{
    public string Version => TagName.StartsWith('v') ? TagName[1..] : string.Empty;
}

internal interface IPluginUpdateTransport
{
    Task<PluginReleaseInfo> ResolveLatestReleaseAsync(string repository, CancellationToken cancellationToken);

    Task<UpdateDownloadResult> DownloadAsync(
        Uri uri,
        string destination,
        long maximumBytes,
        Action<long, long> progress,
        CancellationToken cancellationToken);
}

internal sealed class GitHubPluginUpdateTransport : IPluginUpdateTransport
{
    private readonly Lazy<CurlUpdateTransport> transport = new(() => new CurlUpdateTransport());

    public async Task<PluginReleaseInfo> ResolveLatestReleaseAsync(string repository, CancellationToken cancellationToken)
    {
        var release = await transport.Value.ResolveLatestReleaseAsync(repository, cancellationToken).ConfigureAwait(false);
        return new PluginReleaseInfo(repository, release.TagName, release.HtmlUrl);
    }

    public Task<UpdateDownloadResult> DownloadAsync(
        Uri uri,
        string destination,
        long maximumBytes,
        Action<long, long> progress,
        CancellationToken cancellationToken) => transport.Value.DownloadAsync(uri, destination, maximumBytes, progress, cancellationToken);
}

internal sealed class PluginUpdateManager : IAsyncDisposable
{
    private readonly LoaderPaths paths;
    private readonly ScriptRegistry registry;
    private readonly JsonlLogger logger;
    private readonly Func<string, CancellationToken, Task> reloadPlugin;
    private readonly Func<bool> hasRenderer;
    private readonly IPluginUpdateTransport transport;
    private readonly SemaphoreSlim preferencesGate = new(1, 1);
    private readonly ConcurrentDictionary<string, PluginUpdateSnapshot> snapshots = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PluginReleaseInfo> releases = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PendingConfirmation> pendingConfirmations = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, CancellationTokenSource> downloads = new(StringComparer.Ordinal);
    private PluginUpdatePreferenceDocument preferences = new(1, new Dictionary<string, PluginUpdatePreference>(StringComparer.Ordinal));
    private int checkedThisLaunch;

    public PluginUpdateManager(
        LoaderPaths paths,
        ScriptRegistry registry,
        JsonlLogger logger,
        Func<string, CancellationToken, Task> reloadPlugin,
        Func<bool> hasRenderer,
        IPluginUpdateTransport? transport = null)
    {
        this.paths = paths;
        this.registry = registry;
        this.logger = logger;
        this.reloadPlugin = reloadPlugin;
        this.hasRenderer = hasRenderer;
        this.transport = transport ?? new GitHubPluginUpdateTransport();
    }

    public PluginUpdateSnapshot SnapshotFor(string id) => snapshots.TryGetValue(id, out var snapshot)
        ? snapshot
        : new PluginUpdateSnapshot(id, false, false, PluginUpdateStage.Unsupported);

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        TryDeleteDirectory(paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "plugin-update-cache"), "Plugin update cache"));
        try
        {
            preferences = await AtomicJsonFile.ReadAsync<PluginUpdatePreferenceDocument>(paths.PluginUpdatePreferencesPath, cancellationToken).ConfigureAwait(false)
                ?? new(1, new Dictionary<string, PluginUpdatePreference>(StringComparer.Ordinal));
            if (preferences.SchemaVersion != 1) throw new InvalidDataException("Plugin update preferences schema is unsupported.");
            if (preferences.Plugins is null || preferences.Plugins.Any(item =>
                    !IsValidFingerprint(item.Value?.Fingerprint) ||
                    item.Value!.LastState is PluginUpdateStage.Checking or PluginUpdateStage.Downloading or PluginUpdateStage.Verifying or PluginUpdateStage.AwaitingConfirmation or PluginUpdateStage.Installing or PluginUpdateStage.Reloading))
            {
                throw new InvalidDataException("Plugin update preferences are invalid.");
            }
            preferences = preferences with { Plugins = new Dictionary<string, PluginUpdatePreference>(preferences.Plugins, StringComparer.Ordinal) };
        }
        catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException)
        {
            logger.Warn("plugin-update-preferences-reset", new { message = JsonlLogger.Redact(exception.Message) });
            preferences = new(1, new Dictionary<string, PluginUpdatePreference>(StringComparer.Ordinal));
        }

        var changed = false;
        foreach (var plugin in await registry.ListPluginsAsync(cancellationToken: cancellationToken).ConfigureAwait(false))
        {
            if (plugin.Bundled || plugin.Status == "invalid") continue;
            var descriptor = await ScriptRegistry.LoadDescriptorAsync(Path.Combine(paths.ScriptsRoot, plugin.Id), cancellationToken).ConfigureAwait(false);
            if (descriptor.Update is null) continue;
            if (!preferences.Plugins.ContainsKey(plugin.Id))
            {
                preferences.Plugins[plugin.Id] = new PluginUpdatePreference(false, await registry.ComputePackageFingerprintAsync(plugin.Id, cancellationToken).ConfigureAwait(false));
                changed = true;
            }
            var preference = preferences.Plugins[plugin.Id];
            snapshots[plugin.Id] = new PluginUpdateSnapshot(
                plugin.Id,
                true,
                preference.Automatic,
                preference.LastState,
                preference.AvailableVersion,
                preference.LastCheckedAt,
                preference.ReleaseUrl,
                ErrorCode: preference.ErrorCode,
                Error: preference.Error);
        }
        if (changed || !File.Exists(paths.PluginUpdatePreferencesPath)) await SavePreferencesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<PluginUpdateSnapshot>> CheckAsync(IReadOnlySet<string>? ids, CancellationToken cancellationToken)
    {
        var plugins = await registry.ListPluginsAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        var candidates = plugins.Where(plugin => !plugin.Bundled && plugin.Status != "invalid" && (ids is null || ids.Contains(plugin.Id))).ToArray();
        using var concurrency = new SemaphoreSlim(3, 3);
        var tasks = candidates.Select(async plugin =>
        {
            await concurrency.WaitAsync(cancellationToken).ConfigureAwait(false);
            try { return await CheckOneAsync(plugin, cancellationToken).ConfigureAwait(false); }
            finally { concurrency.Release(); }
        }).ToArray();
        return (await Task.WhenAll(tasks).ConfigureAwait(false)).Where(snapshot => snapshot.Supported).OrderBy(snapshot => snapshot.Id, StringComparer.Ordinal).ToArray();
    }

    public async Task StartAfterHealthyAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref checkedThisLaunch, 1) != 0) return;
        var results = await CheckAsync(null, cancellationToken).ConfigureAwait(false);
        foreach (var snapshot in results.Where(item => item.Automatic && item.State == PluginUpdateStage.Available))
        {
            try { await StartUpdateAsync(snapshot.Id, cancellationToken).ConfigureAwait(false); }
            catch (PluginUpdateRollbackException) { throw; }
            catch (Exception exception) { logger.Warn("automatic-plugin-update-failed", new { pluginId = snapshot.Id, message = JsonlLogger.Redact(exception.Message) }); }
        }
    }

    public async Task<PluginUpdateSnapshot> SetAutomaticAsync(string id, bool enabled, CancellationToken cancellationToken)
    {
        await preferencesGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var current = SnapshotFor(id);
            if (!current.Supported || !preferences.Plugins.TryGetValue(id, out var preference)) throw new InvalidOperationException("Plugin does not declare a supported update source.");
            preferences.Plugins[id] = preference with { Automatic = enabled };
            await SavePreferencesAsync(cancellationToken).ConfigureAwait(false);
            return SetSnapshot(current with { Automatic = enabled });
        }
        finally { preferencesGate.Release(); }
    }

    public async Task<PluginUpdateSnapshot> StartUpdateAsync(string id, CancellationToken cancellationToken)
    {
        if (IsActiveOrPending(SnapshotFor(id).State)) throw new InvalidOperationException("A plugin update is already active or awaiting confirmation.");
        var plugin = (await registry.ListPluginsAsync(cancellationToken: cancellationToken).ConfigureAwait(false)).SingleOrDefault(item => item.Id == id)
            ?? throw new InvalidOperationException($"Unknown plugin: {id}.");
        if (!plugin.Enabled) return SetSnapshot(SnapshotFor(id) with { State = PluginUpdateStage.WaitingForEnable });
        if (!hasRenderer()) return SetSnapshot(SnapshotFor(id) with { State = PluginUpdateStage.WaitingForRenderer });
        if (!releases.TryGetValue(id, out var release))
        {
            await CheckAsync(new HashSet<string>(StringComparer.Ordinal) { id }, cancellationToken).ConfigureAwait(false);
            if (!releases.TryGetValue(id, out release)) throw new InvalidOperationException("No newer plugin release is available.");
        }

        var descriptor = await ScriptRegistry.LoadDescriptorAsync(Path.Combine(paths.ScriptsRoot, id), cancellationToken).ConfigureAwait(false);
        var update = descriptor.Update ?? throw new InvalidOperationException("Plugin does not declare a supported update source.");
        var assetName = update.Asset.Replace("{version}", release.Version, StringComparison.Ordinal);
        var checksumName = assetName + ".sha256";
        var cacheRoot = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "plugin-update-cache", id), "Plugin update cache");
        Directory.CreateDirectory(cacheRoot);
        var archivePath = Path.Combine(cacheRoot, assetName);
        var checksumPath = Path.Combine(cacheRoot, checksumName);
        using var download = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (!downloads.TryAdd(id, download)) throw new InvalidOperationException("A plugin update is already active.");
        PluginUpdatePreview? readyToApply = null;
        try
        {
            SetSnapshot(SnapshotFor(id) with { State = PluginUpdateStage.Downloading, Progress = 0, Error = null, ErrorCode = null });
            await transport.DownloadAsync(ReleaseAssetUri(update.Repository, release.Version, checksumName), checksumPath, 1024 * 1024, (_, _) => { }, download.Token).ConfigureAwait(false);
            await transport.DownloadAsync(ReleaseAssetUri(update.Repository, release.Version, assetName), archivePath, 8L * 1024 * 1024,
                (written, total) => SetSnapshot(SnapshotFor(id) with { State = PluginUpdateStage.Downloading, Progress = total <= 0 ? 0 : (double)written / total }), download.Token).ConfigureAwait(false);
            SetSnapshot(SnapshotFor(id) with { State = PluginUpdateStage.Verifying, Progress = 1 });
            var checksumText = await File.ReadAllTextAsync(checksumPath, download.Token).ConfigureAwait(false);
            var expectedHash = UpdatePackageVerifier.ReadUniqueSha256(checksumText, assetName);
            var preview = await registry.StageUpdatePackageAsync(archivePath, id, release.Version, update, expectedHash, download.Token).ConfigureAwait(false);
            var preference = await ReadPreferenceAsync(id, download.Token).ConfigureAwait(false);
            var localChanges = !string.Equals(preference.Fingerprint, preview.CurrentFingerprint, StringComparison.Ordinal);
            if (localChanges || preview.NewPermissions.Count > 0)
            {
                pendingConfirmations[id] = new PendingConfirmation(preview, DateTimeOffset.UtcNow);
                return SetSnapshot(SnapshotFor(id) with
                {
                    State = PluginUpdateStage.AwaitingConfirmation,
                    NewPermissions = preview.NewPermissions,
                    LocalChanges = localChanges,
                    RequiresConfirmation = true,
                    ConfirmationToken = preview.Token,
                    Progress = null,
                });
            }
            readyToApply = preview;
        }
        catch (OperationCanceledException) when (download.IsCancellationRequested)
        {
            return SetSnapshot(SnapshotFor(id) with { State = PluginUpdateStage.Available, Progress = null, Error = null, ErrorCode = null });
        }
        catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException or InvalidOperationException or HttpRequestException or UnauthorizedAccessException)
        {
            var failed = SetSnapshot(SnapshotFor(id) with { State = PluginUpdateStage.Failed, Progress = null, ErrorCode = "networkOrPackage", Error = JsonlLogger.Redact(exception.Message) });
            await PersistResultBestEffortAsync(failed).ConfigureAwait(false);
            throw;
        }
        finally
        {
            downloads.TryRemove(id, out _);
            if (!pendingConfirmations.ContainsKey(id)) TryDeleteDirectory(cacheRoot);
        }
        return await ApplyAsync(readyToApply ?? throw new InvalidOperationException("Plugin update package was not prepared."), cancellationToken).ConfigureAwait(false);
    }

    public async Task<PluginUpdateSnapshot> ConfirmAsync(string id, string token, CancellationToken cancellationToken)
    {
        if (!pendingConfirmations.TryGetValue(id, out var pending) || pending.Preview.Token != token)
        {
            throw new InvalidOperationException("Plugin update confirmation expired.");
        }
        if (DateTimeOffset.UtcNow - pending.CreatedAt > TimeSpan.FromMinutes(10))
        {
            pendingConfirmations.TryRemove(new KeyValuePair<string, PendingConfirmation>(id, pending));
            await registry.CancelPendingUpdateAsync(pending.Preview.Token, cancellationToken).ConfigureAwait(false);
            TryDeleteDirectory(CacheRoot(id));
            var expired = SetSnapshot(SnapshotFor(id) with
            {
                State = PluginUpdateStage.Available,
                RequiresConfirmation = false,
                ConfirmationToken = null,
                NewPermissions = null,
                LocalChanges = false,
                ErrorCode = "confirmationExpired",
                Error = "Plugin update confirmation expired.",
            });
            await PersistResultBestEffortAsync(expired).ConfigureAwait(false);
            throw new InvalidOperationException("Plugin update confirmation expired.");
        }
        if (!pendingConfirmations.TryRemove(new KeyValuePair<string, PendingConfirmation>(id, pending)))
        {
            throw new InvalidOperationException("Plugin update confirmation changed.");
        }
        try { return await ApplyAsync(pending.Preview, cancellationToken).ConfigureAwait(false); }
        finally { TryDeleteDirectory(CacheRoot(id)); }
    }

    public PluginUpdateSnapshot Cancel(string id)
    {
        if (SnapshotFor(id).State != PluginUpdateStage.Downloading) throw new InvalidOperationException("Plugin update cancellation is available only while downloading.");
        if (!downloads.TryGetValue(id, out var cancellation)) throw new InvalidOperationException("Plugin update cancellation is available only while downloading.");
        cancellation.Cancel();
        return SnapshotFor(id);
    }

    private async Task<PluginUpdateSnapshot> CheckOneAsync(PluginSnapshot plugin, CancellationToken cancellationToken)
    {
        var current = SnapshotFor(plugin.Id);
        if (IsActiveOrPending(current.State)) return current;
        try
        {
            var descriptor = await ScriptRegistry.LoadDescriptorAsync(Path.Combine(paths.ScriptsRoot, plugin.Id), cancellationToken).ConfigureAwait(false);
            if (descriptor.Update is null) return SetSnapshot(new PluginUpdateSnapshot(plugin.Id, false, false, PluginUpdateStage.Unsupported));
            var preference = await EnsurePreferenceAsync(plugin.Id, cancellationToken).ConfigureAwait(false);
            SetSnapshot(new PluginUpdateSnapshot(plugin.Id, true, preference.Automatic, PluginUpdateStage.Checking));
            var release = await transport.ResolveLatestReleaseAsync(descriptor.Update.Repository, cancellationToken).ConfigureAwait(false);
            ValidateRelease(descriptor.Update.Repository, release);
            var checkedAt = DateTimeOffset.UtcNow;
            if (VersionedInstallLayout.CompareVersions(release.Version, descriptor.Version) <= 0)
            {
                releases.TryRemove(plugin.Id, out _);
                return await PersistResultAsync(SnapshotFor(plugin.Id) with { State = PluginUpdateStage.UpToDate, AvailableVersion = null, LastCheckedAt = checkedAt, ReleaseUrl = null, ErrorCode = null, Error = null }, cancellationToken).ConfigureAwait(false);
            }
            releases[plugin.Id] = release;
            return await PersistResultAsync(SnapshotFor(plugin.Id) with { State = plugin.Enabled ? PluginUpdateStage.Available : PluginUpdateStage.WaitingForEnable, AvailableVersion = release.Version, LastCheckedAt = checkedAt, ReleaseUrl = release.HtmlUrl, ErrorCode = null, Error = null }, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException or InvalidOperationException or HttpRequestException or TaskCanceledException or UnauthorizedAccessException)
        {
            return await PersistResultAsync(SnapshotFor(plugin.Id) with { Supported = true, State = PluginUpdateStage.Failed, ErrorCode = "networkOrPackage", Error = JsonlLogger.Redact(exception.Message), LastCheckedAt = DateTimeOffset.UtcNow }, CancellationToken.None).ConfigureAwait(false);
        }
    }

    private async Task<PluginUpdateSnapshot> ApplyAsync(PluginUpdatePreview preview, CancellationToken cancellationToken)
    {
        SetSnapshot(SnapshotFor(preview.Id) with { State = PluginUpdateStage.Installing, Progress = null });
        try
        {
            await registry.ApplyPendingUpdateAsync(
                preview.Token,
                preview.CurrentFingerprint,
                async token => { SetSnapshot(SnapshotFor(preview.Id) with { State = PluginUpdateStage.Reloading }); await reloadPlugin(preview.Id, token).ConfigureAwait(false); },
                token => reloadPlugin(preview.Id, token),
                cancellationToken).ConfigureAwait(false);
        }
        catch (PluginUpdateStateChangedException exception)
        {
            var failed = SetSnapshot(SnapshotFor(preview.Id) with { State = PluginUpdateStage.Failed, Progress = null, ErrorCode = "stateChanged", Error = JsonlLogger.Redact(exception.Message), RequiresConfirmation = false, ConfirmationToken = null });
            await PersistResultBestEffortAsync(failed).ConfigureAwait(false);
            throw;
        }
        catch (PluginUpdateRollbackException exception)
        {
            var failed = SetSnapshot(SnapshotFor(preview.Id) with { State = PluginUpdateStage.Failed, Progress = null, ErrorCode = "rollbackFailed", Error = JsonlLogger.Redact(exception.Message) });
            await PersistResultBestEffortAsync(failed).ConfigureAwait(false);
            throw;
        }
        catch (Exception exception)
        {
            var rolledBack = SetSnapshot(SnapshotFor(preview.Id) with { State = PluginUpdateStage.RolledBack, Progress = null, ErrorCode = "lifecycleRolledBack", Error = JsonlLogger.Redact(exception.Message) });
            await PersistResultBestEffortAsync(rolledBack).ConfigureAwait(false);
            throw;
        }
        releases.TryRemove(preview.Id, out _);
        var succeeded = SetSnapshot(SnapshotFor(preview.Id) with { State = PluginUpdateStage.Succeeded, AvailableVersion = null, RequiresConfirmation = false, ConfirmationToken = null, NewPermissions = [], LocalChanges = false, Progress = 1, Error = null, ErrorCode = null });
        try
        {
            var fingerprint = await registry.ComputePackageFingerprintAsync(preview.Id, CancellationToken.None).ConfigureAwait(false);
            await preferencesGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                var preference = preferences.Plugins[preview.Id];
                preferences.Plugins[preview.Id] = preference with
                {
                    Fingerprint = fingerprint,
                    LastState = succeeded.State,
                    AvailableVersion = succeeded.AvailableVersion,
                    LastCheckedAt = succeeded.LastCheckedAt,
                    ReleaseUrl = succeeded.ReleaseUrl,
                    ErrorCode = null,
                    Error = null,
                };
                await SavePreferencesAsync(CancellationToken.None).ConfigureAwait(false);
            }
            finally { preferencesGate.Release(); }
        }
        catch (Exception exception)
        {
            logger.Warn("plugin-update-state-save-failed", new { pluginId = preview.Id, message = JsonlLogger.Redact(exception.Message) });
        }
        return succeeded;
    }

    private static void ValidateRelease(string repository, PluginReleaseInfo release)
    {
        if (!string.Equals(release.Repository, repository, StringComparison.Ordinal) || string.IsNullOrWhiteSpace(release.Version) ||
            !string.Equals(release.TagName, $"v{release.Version}", StringComparison.Ordinal) ||
            !string.Equals(release.HtmlUrl, $"https://github.com/{repository}/releases/tag/{release.TagName}", StringComparison.Ordinal))
        {
            throw new InvalidDataException("GitHub plugin release identity is invalid.");
        }
        VersionedInstallLayout.ValidateVersionAndRid(release.Version, "win-x64");
    }

    private static Uri ReleaseAssetUri(string repository, string version, string assetName)
    {
        if (Path.GetFileName(assetName) != assetName) throw new InvalidDataException("Plugin release asset name is invalid.");
        var uri = new Uri($"https://github.com/{repository}/releases/download/v{version}/{Uri.EscapeDataString(assetName)}");
        UpdatePackageVerifier.ValidateDownloadUri(uri);
        return uri;
    }

    private static bool IsActiveOrPending(PluginUpdateStage state) => state is
        PluginUpdateStage.Checking or
        PluginUpdateStage.Downloading or
        PluginUpdateStage.Verifying or
        PluginUpdateStage.AwaitingConfirmation or
        PluginUpdateStage.Installing or
        PluginUpdateStage.Reloading;

    private string CacheRoot(string id) => paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "plugin-update-cache", id), "Plugin update cache");

    private PluginUpdateSnapshot SetSnapshot(PluginUpdateSnapshot snapshot)
    {
        snapshots[snapshot.Id] = snapshot;
        return snapshot;
    }

    private async Task<PluginUpdateSnapshot> PersistResultAsync(PluginUpdateSnapshot snapshot, CancellationToken cancellationToken)
    {
        SetSnapshot(snapshot);
        await preferencesGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (preferences.Plugins.TryGetValue(snapshot.Id, out var preference))
            {
                preferences.Plugins[snapshot.Id] = preference with
                {
                    LastState = snapshot.State,
                    AvailableVersion = snapshot.AvailableVersion,
                    LastCheckedAt = snapshot.LastCheckedAt,
                    ReleaseUrl = snapshot.ReleaseUrl,
                    ErrorCode = snapshot.ErrorCode,
                    Error = snapshot.Error,
                };
                await SavePreferencesAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        finally { preferencesGate.Release(); }
        return snapshot;
    }

    private async Task PersistResultBestEffortAsync(PluginUpdateSnapshot snapshot)
    {
        try { await PersistResultAsync(snapshot, CancellationToken.None).ConfigureAwait(false); }
        catch (Exception exception)
        {
            logger.Warn("plugin-update-state-save-failed", new { pluginId = snapshot.Id, message = JsonlLogger.Redact(exception.Message) });
        }
    }

    private async Task<PluginUpdatePreference> ReadPreferenceAsync(string id, CancellationToken cancellationToken)
    {
        await preferencesGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return preferences.Plugins.TryGetValue(id, out var preference)
                ? preference
                : throw new InvalidOperationException("Plugin update preference is unavailable.");
        }
        finally { preferencesGate.Release(); }
    }

    private async Task<PluginUpdatePreference> EnsurePreferenceAsync(string id, CancellationToken cancellationToken)
    {
        await preferencesGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (preferences.Plugins.TryGetValue(id, out var existing)) return existing;
        }
        finally { preferencesGate.Release(); }

        var created = new PluginUpdatePreference(false, await registry.ComputePackageFingerprintAsync(id, cancellationToken).ConfigureAwait(false));
        await preferencesGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (preferences.Plugins.TryGetValue(id, out var existing)) return existing;
            preferences.Plugins[id] = created;
            await SavePreferencesAsync(cancellationToken).ConfigureAwait(false);
            return created;
        }
        finally { preferencesGate.Release(); }
    }

    private Task SavePreferencesAsync(CancellationToken cancellationToken) => AtomicJsonFile.WriteAsync(paths.PluginUpdatePreferencesPath, preferences, cancellationToken);

    private static bool IsValidFingerprint(string? value) => value is { Length: 64 } && value.All(character => character is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    private static void TryDeleteDirectory(string directory)
    {
        try { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    public ValueTask DisposeAsync()
    {
        foreach (var cancellation in downloads.Values) cancellation.Cancel();
        foreach (var cancellation in downloads.Values) cancellation.Dispose();
        return ValueTask.CompletedTask;
    }

    private sealed record PendingConfirmation(PluginUpdatePreview Preview, DateTimeOffset CreatedAt);
    private sealed record PluginUpdatePreference(
        bool Automatic,
        string Fingerprint,
        DateTimeOffset? LastCheckedAt = null,
        PluginUpdateStage LastState = PluginUpdateStage.Idle,
        string? AvailableVersion = null,
        string? ReleaseUrl = null,
        string? ErrorCode = null,
        string? Error = null);
    private sealed record PluginUpdatePreferenceDocument(int SchemaVersion, Dictionary<string, PluginUpdatePreference> Plugins);
}
