using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CodexScriptLoader.Core;

public sealed partial class ScriptRegistry
{
    private const long MaxPackageBytes = 8 * 1024 * 1024;
    private const int MaxPackageFiles = 256;
    private readonly Dictionary<string, PendingPackage> pendingPackages = new(StringComparer.Ordinal);

    public async Task<IReadOnlyList<PluginSnapshot>> ListPluginsAsync(
        IReadOnlyDictionary<string, ScriptLoadResult>? runtimeById = null,
        CancellationToken cancellationToken = default)
    {
        var config = await ReadConfigAsync(cancellationToken).ConfigureAwait(false);
        var result = new List<PluginSnapshot>();
        foreach (var directory in Directory.EnumerateDirectories(paths.ScriptsRoot).OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var descriptor = await LoadDescriptorAsync(directory, cancellationToken).ConfigureAwait(false);
                var enabled = !config.Overrides.TryGetValue(descriptor.Id, out var overrideEnabled) || overrideEnabled;
                var effectiveEnabled = config.GlobalEnabled && !config.SafeMode && enabled;
                ScriptLoadResult? runtime = null;
                runtimeById?.TryGetValue(descriptor.Id, out runtime);
                var status = !effectiveEnabled
                    ? "disabled"
                    : runtime?.LifecycleResult == "running"
                        ? "running"
                        : runtime is not null
                            ? "failed"
                            : "ready";
                var documentation = await ResolveDocumentationAsync(descriptor, cancellationToken).ConfigureAwait(false);
                var legacy = descriptor.SettingsMode == "legacy" || descriptor.Documentation is null;
                result.Add(new PluginSnapshot(
                    descriptor.Id,
                    descriptor.Name,
                    descriptor.Version,
                    descriptor.Description,
                    descriptor.Author,
                    enabled,
                    bundledIds.Contains(descriptor.Id),
                    status,
                    runtime?.ErrorCode,
                    descriptor.Permissions,
                    descriptor.SettingsMode,
                    descriptor.SettingsPageId,
                    descriptor.SettingsPageTitle,
                    descriptor.Documentation,
                    documentation,
                    legacy,
                    null,
                    descriptor.AgentSkill,
                    skillLinks?.Status(descriptor) ?? (descriptor.AgentSkill is null ? "none" : "unavailable")));
            }
            catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException or UnauthorizedAccessException)
            {
                var id = Path.GetFileName(directory);
                result.Add(new PluginSnapshot(
                    id,
                    id,
                    "?",
                    string.Empty,
                    string.Empty,
                    false,
                    bundledIds.Contains(id),
                    "invalid",
                    JsonlLogger.Redact(exception.Message),
                    [],
                    "legacy",
                    null,
                    null,
                    null,
                    null,
                    true,
                    null));
            }
        }

        return result;
    }

    public async Task<PluginSnapshot> SetEnabledAsync(string id, bool enabled, CancellationToken cancellationToken = default)
    {
        if (!ScriptIdRegex().IsMatch(id))
        {
            throw new ArgumentException("Invalid script id.", nameof(id));
        }

        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await ReloadConfigAsync(cancellationToken).ConfigureAwait(false);
            var directory = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, id), "Installed script");
            var descriptor = await LoadDescriptorAsync(directory, cancellationToken).ConfigureAwait(false);
            var hadPrevious = enabledOverrides.TryGetValue(id, out var previous);
            var previousEnabled = !hadPrevious || previous;
            enabledOverrides[id] = enabled;
            try
            {
                if (configInvalid) throw new InvalidDataException("Loader configuration is invalid; refusing to overwrite it.");
                await SyncSkillAsync(descriptor, enabled && globalEnabled && !safeMode, cancellationToken).ConfigureAwait(false);
                await SaveConfigAsync(cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                if (hadPrevious) enabledOverrides[id] = previous;
                else enabledOverrides.Remove(id);
                await SyncSkillAsync(descriptor, previousEnabled && globalEnabled && !safeMode, CancellationToken.None).ConfigureAwait(false);
                throw;
            }

            return (await ListPluginsAsync(cancellationToken: cancellationToken).ConfigureAwait(false))
                .Single(plugin => plugin.Id == id);
        }
        finally
        {
            registryMutation.Release();
        }
    }

    public async Task<PluginInstallPreview> StagePackageAsync(string sourcePath, bool archive, CancellationToken cancellationToken = default, PluginReleasePackage? release = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourcePath);
        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            CleanupExpiredPendingPackages();
            var pendingRoot = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "pending"), "Pending package root");
            Directory.CreateDirectory(pendingRoot);
            var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(18));
            var stageRoot = paths.EnsureWithin(pendingRoot, Path.Combine(pendingRoot, token), "Pending package");
            Directory.CreateDirectory(stageRoot);
            try
            {
                if (archive)
                {
                    await ExtractArchiveAsync(sourcePath, stageRoot, cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    await CopyPackageDirectoryAsync(sourcePath, stageRoot, cancellationToken).ConfigureAwait(false);
                }

                var packageRoot = FindPackageRoot(stageRoot);
                var descriptor = await LoadDescriptorAsync(packageRoot, cancellationToken).ConfigureAwait(false);
                if (release is not null && (descriptor.Version != release.Version || descriptor.Update is not { } update ||
                    !string.Equals(update.Repository, release.Repository, StringComparison.OrdinalIgnoreCase) ||
                    update.Asset.Replace("{version}", release.Version, StringComparison.Ordinal) != release.AssetName))
                    throw new InvalidDataException("Plugin manifest version and update source must match the selected GitHub Release.");
                await CheckSkillAsync(descriptor, cancellationToken).ConfigureAwait(false);
                if (bundledIds.Contains(descriptor.Id))
                {
                    throw new InvalidOperationException("Bundled plugins cannot be replaced from the settings page.");
                }

                var installed = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, descriptor.Id), "Installed plugin target");
                if (File.Exists(installed)) throw new IOException("Plugin destination is not a directory.");
                var previousDescriptor = Directory.Exists(installed) ? await LoadDescriptorAsync(installed, cancellationToken).ConfigureAwait(false) : null;
                var installedFingerprint = previousDescriptor is null ? null : await ComputeDirectoryFingerprintAsync(installed, cancellationToken).ConfigureAwait(false);

                var documentation = await ResolveDocumentationAsync(descriptor, cancellationToken).ConfigureAwait(false);
                var pending = new PendingPackage(token, stageRoot, packageRoot, descriptor, DateTimeOffset.UtcNow, installedFingerprint);
                pendingPackages[token] = pending;
                return new PluginInstallPreview(
                    token,
                    descriptor.Id,
                    descriptor.Name,
                    descriptor.Version,
                    descriptor.Description,
                    descriptor.Author,
                    descriptor.Permissions,
                    descriptor.SettingsMode,
                    descriptor.SettingsPageTitle,
                    documentation,
                    descriptor.SettingsMode == "legacy" || descriptor.Documentation is null,
                    descriptor.AgentSkill,
                    previousDescriptor?.Version,
                    release is null ? null : $"https://github.com/{release.Repository}/releases/tag/v{release.Version}",
                    release?.Sha256);
            }
            catch
            {
                if (Directory.Exists(stageRoot)) Directory.Delete(stageRoot, recursive: true);
                throw;
            }
        }
        finally
        {
            registryMutation.Release();
        }
    }

    public async Task<PluginSnapshot> InstallPendingAsync(string token, bool enabled, CancellationToken cancellationToken = default,
        Func<string, CancellationToken, Task>? activate = null)
    {
        PendingPackage? replacement;
        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { replacement = pendingPackages.TryGetValue(token, out var candidate) && candidate.InstalledFingerprint is not null ? candidate : null; }
        finally { registryMutation.Release(); }
        if (replacement is not null)
        {
            async Task ActivateAsync(CancellationToken ct)
            {
                // Replacement preserves the installed enable state; it is not a second install.
                var current = (await ListPluginsAsync(cancellationToken: ct).ConfigureAwait(false)).Single(item => item.Id == replacement.Descriptor.Id);
                if (current.Enabled && !safeMode && globalEnabled && activate is not null) await activate(current.Id, ct).ConfigureAwait(false);
            }
            await ApplyPendingUpdateAsync(token, replacement.InstalledFingerprint!, ActivateAsync, ActivateAsync, cancellationToken).ConfigureAwait(false);
            return (await ListPluginsAsync(cancellationToken: cancellationToken).ConfigureAwait(false)).Single(item => item.Id == replacement.Descriptor.Id);
        }

        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!pendingPackages.Remove(token, out var pending) || DateTimeOffset.UtcNow - pending.CreatedAt > TimeSpan.FromMinutes(10))
            {
                throw new InvalidOperationException("Plugin installation preview expired.");
            }

            var target = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, pending.Descriptor.Id), "Plugin install target");
            if (Directory.Exists(target) || File.Exists(target))
            {
                throw new IOException($"Plugin is already installed: {pending.Descriptor.Id}.");
            }

            await ReloadConfigAsync(cancellationToken).ConfigureAwait(false);
            if (configInvalid) throw new InvalidDataException("Loader configuration is invalid; refusing to install a plugin.");
            var hadPrevious = enabledOverrides.TryGetValue(pending.Descriptor.Id, out var previous);
            enabledOverrides[pending.Descriptor.Id] = enabled;
            var moved = false;
            var saved = false;
            try
            {
                await SaveConfigAsync(cancellationToken).ConfigureAwait(false);
                saved = true;
                Directory.Move(pending.PackageRoot, target);
                moved = true;
                await SyncSkillAsync(pending.Descriptor, enabled && globalEnabled && !safeMode, cancellationToken).ConfigureAwait(false);
                if (enabled && globalEnabled && !safeMode && activate is not null) await activate(pending.Descriptor.Id, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                if (moved)
                {
                    await SyncSkillAsync(pending.Descriptor, false, CancellationToken.None).ConfigureAwait(false);
                    Directory.Move(target, pending.PackageRoot);
                }
                if (hadPrevious) enabledOverrides[pending.Descriptor.Id] = previous;
                else enabledOverrides.Remove(pending.Descriptor.Id);
                if (saved) await SaveConfigAsync(CancellationToken.None).ConfigureAwait(false);
                throw;
            }
            finally
            {
                if (Directory.Exists(pending.StageRoot)) Directory.Delete(pending.StageRoot, recursive: true);
            }

            return (await ListPluginsAsync(cancellationToken: cancellationToken).ConfigureAwait(false))
                .Single(plugin => plugin.Id == pending.Descriptor.Id);
        }
        finally
        {
            registryMutation.Release();
        }
    }

    public async Task CancelPendingPackageAsync(string token, CancellationToken cancellationToken = default)
    {
        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!pendingPackages.Remove(token, out var pending)) return;
            if (Directory.Exists(pending.StageRoot)) Directory.Delete(pending.StageRoot, recursive: true);
        }
        finally
        {
            registryMutation.Release();
        }
    }

    private async Task SaveConfigAsync(CancellationToken cancellationToken)
    {
        if (configInvalid) throw new InvalidDataException("Loader configuration is invalid; refusing to overwrite it.");
        var scripts = enabledOverrides.OrderBy(item => item.Key, StringComparer.Ordinal)
            .ToDictionary(item => item.Key, item => new { enabled = item.Value }, StringComparer.Ordinal);
        await AtomicJsonFile.WriteAsync(paths.ConfigPath, new { schemaVersion = 1, globalEnabled, safeMode, scripts }, cancellationToken).ConfigureAwait(false);
    }

    private async Task<string?> ResolveDocumentationAsync(ScriptDescriptor descriptor, CancellationToken cancellationToken)
    {
        var relative = descriptor.Documentation;
        if (relative is null)
        {
            var legacy = Path.Combine(descriptor.Directory, "README.md");
            if (!File.Exists(legacy)) return null;
            relative = "README.md";
        }

        var root = Path.GetFullPath(descriptor.Directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var documentPath = Path.GetFullPath(Path.Combine(descriptor.Directory, relative));
        if (!documentPath.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Plugin documentation escapes its package directory.");
        }

        var info = new FileInfo(documentPath);
        if (!info.Exists || info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.Length > 256 * 1024)
        {
            if (descriptor.Documentation is not null) throw new InvalidDataException("Declared plugin documentation is missing or invalid.");
            return null;
        }

        var text = await File.ReadAllTextAsync(documentPath, Encoding.UTF8, cancellationToken).ConfigureAwait(false);
        var compact = string.Join(" ", text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return compact.Length <= 800 ? compact : compact[..800] + "…";
    }

    private static async Task CopyPackageDirectoryAsync(string sourcePath, string stageRoot, CancellationToken cancellationToken)
    {
        var source = new DirectoryInfo(Path.GetFullPath(sourcePath));
        if (!source.Exists || source.Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            throw new InvalidDataException("Plugin package must be a real directory.");
        }

        long totalBytes = 0;
        var files = 0;
        foreach (var entry in source.EnumerateFileSystemInfos("*", SearchOption.AllDirectories))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("Plugin packages cannot contain links or reparse points.");
            var relative = Path.GetRelativePath(source.FullName, entry.FullName);
            var target = Path.GetFullPath(Path.Combine(stageRoot, relative));
            var prefix = Path.GetFullPath(stageRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Plugin package path escapes its staging directory.");
            if (entry is DirectoryInfo)
            {
                Directory.CreateDirectory(target);
                continue;
            }

            var file = (FileInfo)entry;
            files++;
            totalBytes += file.Length;
            if (files > MaxPackageFiles || totalBytes > MaxPackageBytes) throw new InvalidDataException("Plugin package is too large.");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await using var input = file.OpenRead();
            await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true);
            await input.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
        }
    }

    private static async Task ExtractArchiveAsync(string sourcePath, string stageRoot, CancellationToken cancellationToken)
    {
        var archiveInfo = new FileInfo(Path.GetFullPath(sourcePath));
        if (!archiveInfo.Exists || archiveInfo.Attributes.HasFlag(FileAttributes.ReparsePoint) || !string.Equals(archiveInfo.Extension, ".zip", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Plugin archive must be a real ZIP file.");
        }

        using var archive = ZipFile.OpenRead(archiveInfo.FullName);
        long totalBytes = 0;
        var files = 0;
        var prefix = Path.GetFullPath(stageRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var unixMode = (entry.ExternalAttributes >> 16) & 0xF000;
            if (unixMode == 0xA000 || (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Plugin archives cannot contain links or reparse points.");
            var normalized = entry.FullName.Replace('\\', '/');
            if (string.IsNullOrWhiteSpace(normalized) || normalized.StartsWith("/", StringComparison.Ordinal) ||
                normalized.Split('/').Any(part => part == "..") || Path.IsPathRooted(normalized) || !names.Add(normalized))
            {
                throw new InvalidDataException("Plugin archive contains an unsafe or duplicate path.");
            }
            var target = Path.GetFullPath(Path.Combine(stageRoot, normalized.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Plugin archive contains a path traversal entry.");
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(target);
                continue;
            }

            files++;
            totalBytes += entry.Length;
            if (files > MaxPackageFiles || totalBytes > MaxPackageBytes) throw new InvalidDataException("Plugin archive is too large.");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await using var input = entry.Open();
            await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true);
            await input.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
        }
    }

    private static string FindPackageRoot(string stageRoot)
    {
        var manifests = Directory.EnumerateFiles(stageRoot, "manifest.json", SearchOption.AllDirectories).ToArray();
        if (manifests.Length != 1) throw new InvalidDataException("Plugin package must contain exactly one manifest.json.");
        var root = Path.GetDirectoryName(manifests[0])!;
        var relative = Path.GetRelativePath(stageRoot, root);
        if (relative != "." && relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Length > 1)
        {
            throw new InvalidDataException("Plugin manifest must be at the package root or inside one top-level folder.");
        }

        return root;
    }

    private void CleanupExpiredPendingPackages()
    {
        foreach (var item in pendingPackages.Values.Where(item => DateTimeOffset.UtcNow - item.CreatedAt > TimeSpan.FromMinutes(10)).ToArray())
        {
            pendingPackages.Remove(item.Token);
            if (Directory.Exists(item.StageRoot)) Directory.Delete(item.StageRoot, recursive: true);
        }
    }

    private sealed record PendingPackage(string Token, string StageRoot, string PackageRoot, ScriptDescriptor Descriptor, DateTimeOffset CreatedAt, string? InstalledFingerprint = null);
}
