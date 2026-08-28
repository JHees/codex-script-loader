using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text.Json;
using System.Runtime.InteropServices;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed record StagedUpdate(
    UpdateManifest Manifest,
    VersionedInstallLayout Layout,
    string VersionDirectory,
    InstallPointer Pointer,
    GitHubReleaseInfo Release);

internal sealed class OnlineUpdateManager : IAsyncDisposable
{
    public const int LauncherProtocol = 1;
    public const int HandoffProtocol = 1;
    private const string Repository = "JHees/codex-script-loader";
    private readonly LoaderPaths paths;
    private readonly JsonlLogger logger;
    private readonly SemaphoreSlim operation = new(1, 1);
    private readonly Func<StagedUpdate, CancellationToken, Task> switchHost;
    private readonly string hostBaseDirectory;
    private readonly IUpdateTransport updateTransport;
    private UpdatePreferences preferences = new();
    private UpdateSnapshot snapshot = new(LiveSupervisor.Version, null, UpdateStage.Idle, null, null, null, null, false, true, "stable");
    private GitHubReleaseInfo? availableRelease;
    private CancellationTokenSource? downloadCancellation;
    private bool checkedThisLaunch;

    public OnlineUpdateManager(
        LoaderPaths paths,
        JsonlLogger logger,
        Func<StagedUpdate, CancellationToken, Task> switchHost,
        string? hostBaseDirectory = null,
        IUpdateTransport? updateTransport = null)
    {
        this.paths = paths;
        this.logger = logger;
        this.switchHost = switchHost;
        this.hostBaseDirectory = hostBaseDirectory ?? AppContext.BaseDirectory;
        this.updateTransport = updateTransport ?? new CurlUpdateTransport();
    }

    public UpdateSnapshot Snapshot => snapshot;

    public event Action<UpdateSnapshot>? SnapshotChanged;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        try
        {
            preferences = await AtomicJsonFile.ReadAsync<UpdatePreferences>(paths.UpdatePreferencesPath, cancellationToken).ConfigureAwait(false) ?? new();
            if (preferences.SchemaVersion != 1 || preferences.Channel != "stable") throw new InvalidDataException("Update preferences schema is unsupported.");
        }
        catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException)
        {
            logger.Warn("update-preferences-reset", new { message = JsonlLogger.Redact(exception.Message) });
            preferences = new();
        }

        await AtomicJsonFile.WriteAsync(paths.UpdatePreferencesPath, preferences, cancellationToken).ConfigureAwait(false);
        try { await RefreshTransactionStateAsync(cancellationToken, preserveTerminalState: false).ConfigureAwait(false); }
        catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException)
        {
            logger.Warn("update-transaction-ignored", new { message = JsonlLogger.Redact(exception.Message) });
            SetSnapshot(snapshot with { AutoUpdate = preferences.AutoUpdate, Channel = preferences.Channel, State = UpdateStage.Idle, Error = null });
        }
        try { await CleanupOldVersionsAsync(cancellationToken).ConfigureAwait(false); }
        catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException or UnauthorizedAccessException)
        {
            logger.Warn("old-version-cleanup-skipped", new { message = JsonlLogger.Redact(exception.Message) });
        }
    }

    public async Task RefreshTransactionStateAsync(CancellationToken cancellationToken, bool preserveTerminalState)
    {
        var transaction = await AtomicJsonFile.ReadAsync<UpdateTransaction>(paths.UpdateTransactionPath, cancellationToken).ConfigureAwait(false);
        var terminalForCurrent = transaction is { TargetVersion: LiveSupervisor.Version, State: UpdateStage.Succeeded } or
            { CurrentVersion: LiveSupervisor.Version, State: UpdateStage.RolledBack };
        var restoredState = terminalForCurrent && !preserveTerminalState
            ? UpdateStage.Idle
            : transaction is { TargetVersion: LiveSupervisor.Version, State: UpdateStage.Switching }
            ? UpdateStage.Switching
            : transaction is { TargetVersion: LiveSupervisor.Version, State: UpdateStage.Succeeded }
                ? UpdateStage.Succeeded
            : transaction is { CurrentVersion: LiveSupervisor.Version, State: UpdateStage.RolledBack }
                ? UpdateStage.RolledBack
                : UpdateStage.Idle;
        SetSnapshot(snapshot with { AutoUpdate = preferences.AutoUpdate, Channel = preferences.Channel, State = restoredState,
            Error = restoredState == UpdateStage.RolledBack ? transaction?.Error : null });
        if (terminalForCurrent && !preserveTerminalState && File.Exists(paths.UpdateTransactionPath)) File.Delete(paths.UpdateTransactionPath);
    }

    public async Task StartAfterHealthyAsync(CancellationToken cancellationToken)
    {
        if (checkedThisLaunch) return;
        checkedThisLaunch = true;
        if (snapshot.State is UpdateStage.Succeeded or UpdateStage.RolledBack) return;
        var installedLayout = VersionedInstallLayout.TryFromHostBaseDirectory(hostBaseDirectory);
        if (installedLayout is null || !installedLayout.IsStandardInstallation)
        {
            SetSnapshot(snapshot with { RequiresInstaller = true });
            return;
        }
        try
        {
            var result = await CheckForUpdatesAsync(cancellationToken).ConfigureAwait(false);
            if (preferences.AutoUpdate && result.State == UpdateStage.Available && !result.RequiresInstaller)
            {
                await StartUpdateAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException or InvalidDataException or TaskCanceledException or InvalidOperationException or UnauthorizedAccessException or HandoffRolledBackException)
        {
            logger.Warn("automatic-update-check-failed", new { message = JsonlLogger.Redact(exception.Message) });
        }
    }

    public async Task<UpdateSnapshot> SetAutoUpdateAsync(bool enabled, CancellationToken cancellationToken)
    {
        preferences = preferences with { AutoUpdate = enabled };
        await AtomicJsonFile.WriteAsync(paths.UpdatePreferencesPath, preferences, cancellationToken).ConfigureAwait(false);
        SetSnapshot(snapshot with { AutoUpdate = enabled });
        return snapshot;
    }

    public async Task<UpdateSnapshot> CheckForUpdatesAsync(CancellationToken cancellationToken)
    {
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            SetSnapshot(snapshot with { State = UpdateStage.Checking, Progress = null, Error = null, ErrorCode = null });
            var release = await updateTransport.ResolveLatestReleaseAsync(cancellationToken).ConfigureAwait(false);
            ValidateRelease(release);
            var checkedAt = DateTimeOffset.UtcNow;
            if (VersionedInstallLayout.CompareVersions(release.Version, LiveSupervisor.Version) <= 0)
            {
                availableRelease = null;
                SetSnapshot(snapshot with { State = UpdateStage.Idle, AvailableVersion = null, LastCheckedAt = checkedAt, ReleaseUrl = null, RequiresInstaller = false });
                return snapshot;
            }

            availableRelease = release;
            var layout = VersionedInstallLayout.TryFromHostBaseDirectory(hostBaseDirectory);
            var requiresInstaller = layout is null || !layout.IsStandardInstallation || release.LauncherProtocolHint is > LauncherProtocol;
            SetSnapshot(snapshot with
            {
                State = UpdateStage.Available,
                AvailableVersion = release.Version,
                LastCheckedAt = checkedAt,
                ReleaseUrl = release.HtmlUrl,
                RequiresInstaller = requiresInstaller,
            });
            logger.Info("update-available", new { version = release.Version, requiresInstaller });
            return snapshot;
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException or InvalidDataException or TaskCanceledException)
        {
            SetSnapshot(snapshot with { State = UpdateStage.Failed, Error = DescribeNetworkError(exception), ErrorCode = ClassifyError(exception), Progress = null });
            throw;
        }
        finally
        {
            operation.Release();
        }
    }

    public async Task<UpdateSnapshot> StartUpdateAsync(CancellationToken cancellationToken)
    {
        if (availableRelease is null)
        {
            await CheckForUpdatesAsync(cancellationToken).ConfigureAwait(false);
        }

        string? installedCandidateDirectory = null;
        string? extractionStagingDirectory = null;
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var release = availableRelease ?? throw new InvalidOperationException("No newer stable release is available.");
            if (snapshot.RequiresInstaller) throw new InvalidOperationException("This update requires a newer Script-Loader installer.");
            var layout = VersionedInstallLayout.TryFromHostBaseDirectory(hostBaseDirectory)
                ?? throw new InvalidOperationException("Online update is available only from a standard versioned installation.");
            if (!layout.IsStandardInstallation) throw new InvalidOperationException("Portable Script-Loader copies use manual updates.");
            var rid = RuntimeInformation.RuntimeIdentifier is "win-arm64" ? "win-arm64" : "win-x64";
            var architecture = rid == "win-arm64" ? "arm64" : "x64";
            var assetName = $"CodexScriptLoader-{release.Version}-windows-{architecture}.zip";
            var checksumName = assetName + ".sha256";
            var archiveUri = ReleaseAssetUri(release.Version, assetName);
            var checksumUri = ReleaseAssetUri(release.Version, checksumName);

            var cacheRoot = Path.Combine(paths.StateRoot, "update-cache");
            Directory.CreateDirectory(cacheRoot);
            var archivePath = Path.Combine(cacheRoot, assetName);
            var checksumPath = Path.Combine(cacheRoot, checksumName);
            downloadCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            SetSnapshot(snapshot with { State = UpdateStage.Downloading, Progress = 0, Error = null, ErrorCode = null });
            await updateTransport.DownloadAsync(checksumUri, checksumPath, 1024 * 1024, (_, _) => { }, downloadCancellation.Token).ConfigureAwait(false);
            var checksum = await File.ReadAllTextAsync(checksumPath, downloadCancellation.Token).ConfigureAwait(false);
            await updateTransport.DownloadAsync(archiveUri, archivePath, 600L * 1024 * 1024, (downloaded, total) =>
                SetSnapshot(snapshot with { Progress = total <= 0 ? 0 : (double)downloaded / total }), downloadCancellation.Token).ConfigureAwait(false);
            downloadCancellation.Dispose();
            downloadCancellation = null;

            SetSnapshot(snapshot with { State = UpdateStage.Verifying, Progress = 1 });
            var expectedHash = UpdatePackageVerifier.ReadUniqueSha256(checksum, assetName);
            var stagingRoot = Path.Combine(layout.InstallRoot, ".update-staging", $"{release.Version}-{Guid.NewGuid():N}");
            extractionStagingDirectory = stagingRoot;
            var manifest = await UpdatePackageVerifier.VerifyAndExtractAsync(archivePath, stagingRoot, release.Version, rid, expectedHash, cancellationToken).ConfigureAwait(false);
            if (manifest.LauncherProtocol > LauncherProtocol)
            {
                SetSnapshot(snapshot with { State = UpdateStage.Available, RequiresInstaller = true, Progress = null });
                return snapshot;
            }
            if (manifest.HandoffProtocol != HandoffProtocol) throw new InvalidDataException("Update handoff protocol is not supported.");

            SetSnapshot(snapshot with { State = UpdateStage.Staging });
            var relativeHostRoot = Path.Combine("versions", release.Version, rid);
            var stagedHost = VersionedInstallLayout.EnsureWithin(stagingRoot, Path.Combine(stagingRoot, relativeHostRoot), "staged host");
            if (!Directory.Exists(stagedHost)) throw new InvalidDataException("Update archive has no versioned host directory.");
            var finalHost = layout.ResolveVersionDirectory(release.Version, rid);
            if (Directory.Exists(finalHost)) throw new InvalidOperationException("The target Loader version is already staged.");
            Directory.CreateDirectory(Path.GetDirectoryName(finalHost)!);
            Directory.Move(stagedHost, finalHost);
            installedCandidateDirectory = finalHost;
            try { Directory.Delete(stagingRoot, recursive: true); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { logger.Warn("update-staging-cleanup-failed", new { message = JsonlLogger.Redact(exception.Message) }); }
            extractionStagingDirectory = null;
            var pointer = new InstallPointer(1, release.Version, rid, "CodexScriptLoader.exe", manifest.LauncherProtocol, manifest.HandoffProtocol);
            var staged = new StagedUpdate(manifest, layout, finalHost, pointer, release);
            SetSnapshot(snapshot with { State = UpdateStage.Switching, Progress = null });
            await switchHost(staged, cancellationToken).ConfigureAwait(false);
            SetSnapshot(snapshot with { State = UpdateStage.Succeeded, Progress = 1, CurrentVersion = release.Version, Error = null, ErrorCode = null });
            return snapshot;
        }
        catch (OperationCanceledException) when (downloadCancellation?.IsCancellationRequested == true)
        {
            SetSnapshot(snapshot with { State = UpdateStage.Available, Progress = null, Error = null, ErrorCode = null });
            return snapshot;
        }
        catch (HandoffRolledBackException exception)
        {
            TryDeleteCandidateDirectory(extractionStagingDirectory);
            TryDeleteCandidateDirectory(installedCandidateDirectory);
            SetSnapshot(snapshot with { State = UpdateStage.RolledBack, Progress = null, Error = JsonlLogger.Redact(exception.Message), ErrorCode = "handoffRolledBack" });
            throw;
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException or InvalidDataException or InvalidOperationException or UnauthorizedAccessException)
        {
            SetSnapshot(snapshot with { State = UpdateStage.Failed, Progress = null, Error = DescribeNetworkError(exception), ErrorCode = ClassifyError(exception) });
            logger.Error("update-failed", exception);
            TryDeleteCandidateDirectory(extractionStagingDirectory);
            TryDeleteCandidateDirectory(installedCandidateDirectory);
            throw;
        }
        finally
        {
            downloadCancellation?.Dispose();
            downloadCancellation = null;
            operation.Release();
        }
    }

    public UpdateSnapshot CancelDownload()
    {
        if (snapshot.State != UpdateStage.Downloading || downloadCancellation is null)
        {
            throw new InvalidOperationException("Update cancellation is available only while downloading.");
        }
        downloadCancellation.Cancel();
        return snapshot;
    }

    private static string ClassifyError(Exception exception) => exception is TaskCanceledException ? "timeout" : "networkOrPackage";

    private static string DescribeNetworkError(Exception exception)
    {
        var current = exception;
        while (current.InnerException is not null) current = current.InnerException;
        return JsonlLogger.Redact(current.Message);
    }

    internal static void ValidateRelease(GitHubReleaseInfo release)
    {
        if (string.IsNullOrWhiteSpace(release.TagName) || string.IsNullOrWhiteSpace(release.HtmlUrl) ||
            !release.TagName.StartsWith('v') || release.TagName[1..] != release.Version ||
            !string.Equals(release.HtmlUrl, $"https://github.com/{Repository}/releases/tag/{release.TagName}", StringComparison.Ordinal))
        {
            throw new InvalidDataException("GitHub release identity is invalid or is not a stable release.");
        }
        VersionedInstallLayout.ValidateVersionAndRid(release.Version, "win-x64");
    }

    private static Uri ReleaseAssetUri(string version, string assetName)
    {
        VersionedInstallLayout.ValidateVersionAndRid(version, "win-x64");
        if (string.IsNullOrWhiteSpace(assetName) || Path.GetFileName(assetName) != assetName) throw new InvalidDataException("Release asset name is invalid.");
        var uri = new Uri($"https://github.com/{Repository}/releases/download/v{version}/{Uri.EscapeDataString(assetName)}");
        UpdatePackageVerifier.ValidateDownloadUri(uri);
        return uri;
    }

    private void SetSnapshot(UpdateSnapshot value)
    {
        snapshot = value;
        SnapshotChanged?.Invoke(value);
    }

    private void TryDeleteCandidateDirectory(string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return;
        try { Directory.Delete(directory, recursive: true); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            logger.Warn("candidate-cleanup-failed", new { message = JsonlLogger.Redact(exception.Message) });
        }
    }

    private async Task CleanupOldVersionsAsync(CancellationToken cancellationToken)
    {
        var layout = VersionedInstallLayout.TryFromHostBaseDirectory(hostBaseDirectory);
        if (layout is null || !layout.IsStandardInstallation || !Directory.Exists(layout.VersionsRoot)) return;
        var active = await AtomicJsonFile.ReadAsync<InstallPointer>(layout.ActivePointerPath, cancellationToken).ConfigureAwait(false);
        var previous = await AtomicJsonFile.ReadAsync<InstallPointer>(layout.PreviousPointerPath, cancellationToken).ConfigureAwait(false);
        var keep = new HashSet<string>(StringComparer.Ordinal) { LiveSupervisor.Version };
        if (active is not null) keep.Add(active.Version);
        if (previous is not null) keep.Add(previous.Version);
        foreach (var directory in Directory.GetDirectories(layout.VersionsRoot))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var name = Path.GetFileName(directory);
            if (keep.Contains(name)) continue;
            try
            {
                VersionedInstallLayout.ValidateVersionAndRid(name, "win-x64");
                _ = VersionedInstallLayout.EnsureWithin(layout.VersionsRoot, directory, "old version directory");
                Directory.Delete(directory, recursive: true);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
            {
                // Cleanup is opportunistic; active and previous versions were already excluded.
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        downloadCancellation?.Cancel();
        downloadCancellation?.Dispose();
        operation.Dispose();
        return ValueTask.CompletedTask;
    }
}

internal sealed record GitHubReleaseInfo(string TagName, string HtmlUrl)
{
    public string Version => TagName.StartsWith('v') ? TagName[1..] : string.Empty;

    public int? LauncherProtocolHint => null;
}
