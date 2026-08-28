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
        await ReloadConfigAsync(cancellationToken).ConfigureAwait(false);
        var result = new List<PluginSnapshot>();
        foreach (var directory in Directory.EnumerateDirectories(paths.ScriptsRoot).OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var descriptor = await LoadDescriptorAsync(directory, cancellationToken).ConfigureAwait(false);
                var enabled = !enabledOverrides.TryGetValue(descriptor.Id, out var overrideEnabled) || overrideEnabled;
                var effectiveEnabled = globalEnabled && !safeMode && enabled;
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
                    null));
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
            _ = await LoadDescriptorAsync(directory, cancellationToken).ConfigureAwait(false);
            var hadPrevious = enabledOverrides.TryGetValue(id, out var previous);
            enabledOverrides[id] = enabled;
            try
            {
                await SaveConfigAsync(cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                if (hadPrevious) enabledOverrides[id] = previous;
                else enabledOverrides.Remove(id);
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

    public async Task<PluginInstallPreview> StagePackageAsync(string sourcePath, bool archive, CancellationToken cancellationToken = default)
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
                if (bundledIds.Contains(descriptor.Id))
                {
                    throw new InvalidOperationException("Bundled plugins cannot be replaced from the settings page.");
                }

                var installed = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, descriptor.Id), "Installed plugin target");
                if (Directory.Exists(installed) || File.Exists(installed))
                {
                    throw new IOException($"Plugin is already installed: {descriptor.Id}.");
                }

                var documentation = await ResolveDocumentationAsync(descriptor, cancellationToken).ConfigureAwait(false);
                var pending = new PendingPackage(token, stageRoot, packageRoot, descriptor, DateTimeOffset.UtcNow);
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
                    descriptor.SettingsMode == "legacy" || descriptor.Documentation is null);
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

    public async Task<PluginSnapshot> InstallPendingAsync(string token, bool enabled, CancellationToken cancellationToken = default)
    {
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
            Directory.Move(pending.PackageRoot, target);
            var hadPrevious = enabledOverrides.TryGetValue(pending.Descriptor.Id, out var previous);
            enabledOverrides[pending.Descriptor.Id] = enabled;
            try
            {
                await SaveConfigAsync(cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                Directory.Move(target, pending.PackageRoot);
                if (hadPrevious) enabledOverrides[pending.Descriptor.Id] = previous;
                else enabledOverrides.Remove(pending.Descriptor.Id);
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
        var temporary = paths.EnsureWithin(paths.DataRoot, $"{paths.ConfigPath}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}", "Config temporary file");
        var scripts = enabledOverrides.OrderBy(item => item.Key, StringComparer.Ordinal)
            .ToDictionary(item => item.Key, item => new { enabled = item.Value }, StringComparer.Ordinal);
        var json = JsonSerializer.Serialize(new { schemaVersion = 1, globalEnabled, safeMode, scripts }, new JsonSerializerOptions { WriteIndented = true });
        await File.WriteAllTextAsync(temporary, json + Environment.NewLine, new UTF8Encoding(false), cancellationToken).ConfigureAwait(false);
        File.Move(temporary, paths.ConfigPath, overwrite: true);
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

    private sealed record PendingPackage(string Token, string StageRoot, string PackageRoot, ScriptDescriptor Descriptor, DateTimeOffset CreatedAt);
}
