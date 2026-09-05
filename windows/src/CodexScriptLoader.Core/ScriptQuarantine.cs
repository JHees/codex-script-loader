using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Core;

public sealed partial class ScriptRegistry
{
    private const string QuarantineMetadataName = "quarantine.json";
    private const string QuarantineScriptDirectory = "script";

    public async Task<QuarantineRecord> QuarantineAsync(string id, CancellationToken cancellationToken = default)
    {
        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { return await QuarantineCoreAsync(id, cancellationToken).ConfigureAwait(false); }
        finally { registryMutation.Release(); }
    }

    private async Task<QuarantineRecord> QuarantineCoreAsync(string id, CancellationToken cancellationToken)
    {
        if (!ScriptIdRegex().IsMatch(id))
        {
            throw new ArgumentException("Invalid script id.", nameof(id));
        }

        if (bundledIds.Contains(id))
        {
            throw new InvalidOperationException("Bundled plugins can be disabled but cannot be removed.");
        }

        await ReloadConfigAsync(cancellationToken).ConfigureAwait(false);
        var source = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, id), "Installed script");
        var descriptor = await LoadDescriptorAsync(source, cancellationToken).ConfigureAwait(false);
        if (!string.Equals(descriptor.Id, id, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Installed script id does not match its directory.");
        }

        var key = $"q-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}-{RandomNumberGenerator.GetHexString(12).ToLowerInvariant()}";
        var entry = paths.EnsureWithin(paths.QuarantineRoot, Path.Combine(paths.QuarantineRoot, key), "Quarantine entry");
        Directory.CreateDirectory(entry);
        var scriptTarget = paths.EnsureWithin(entry, Path.Combine(entry, QuarantineScriptDirectory), "Quarantined script");
        var metadataPath = paths.EnsureWithin(entry, Path.Combine(entry, QuarantineMetadataName), "Quarantine metadata");
        var temporaryMetadata = paths.EnsureWithin(entry, $"{metadataPath}.tmp", "Quarantine metadata temporary file");
        var record = new QuarantineRecord(
            key,
            id,
            descriptor.Name,
            descriptor.Version,
            !enabledOverrides.TryGetValue(id, out var enabled) || enabled,
            DateTimeOffset.UtcNow);
        var moved = false;
        try
        {
            var json = JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                key = record.Key,
                scriptId = record.ScriptId,
                name = record.Name,
                version = record.Version,
                enabled = record.Enabled,
                quarantinedAt = record.QuarantinedAt,
            }, new JsonSerializerOptions { WriteIndented = true });
            await File.WriteAllTextAsync(temporaryMetadata, json + Environment.NewLine, new UTF8Encoding(false), cancellationToken).ConfigureAwait(false);
            File.Move(temporaryMetadata, metadataPath);
            await SyncSkillAsync(descriptor, false, cancellationToken).ConfigureAwait(false);
            Directory.Move(source, scriptTarget);
            moved = true;
            return record;
        }
        finally
        {
            if (!moved && Directory.Exists(entry))
            {
                Directory.Delete(entry, recursive: true);
                await SyncSkillAsync(descriptor, record.Enabled && globalEnabled && !safeMode, CancellationToken.None).ConfigureAwait(false);
            }
        }
    }

    public async Task<IReadOnlyList<QuarantineRecord>> ListQuarantinedAsync(CancellationToken cancellationToken = default)
    {
        var records = new List<QuarantineRecord>();
        foreach (var directory in Directory.EnumerateDirectories(paths.QuarantineRoot).OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var key = Path.GetFileName(directory);
            if (!QuarantineKeyRegex().IsMatch(key))
            {
                continue;
            }

            try
            {
                records.Add(await ReadQuarantineAsync(key, cancellationToken).ConfigureAwait(false));
            }
            catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException or UnauthorizedAccessException or KeyNotFoundException or FormatException)
            {
            }
        }

        return records.OrderByDescending(record => record.QuarantinedAt).ToArray();
    }

    public async Task<QuarantineRecord> RestoreQuarantinedAsync(string key, CancellationToken cancellationToken = default)
    {
        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { return await RestoreQuarantinedCoreAsync(key, cancellationToken).ConfigureAwait(false); }
        finally { registryMutation.Release(); }
    }

    private async Task<QuarantineRecord> RestoreQuarantinedCoreAsync(string key, CancellationToken cancellationToken)
    {
        var record = await ReadQuarantineAsync(key, cancellationToken).ConfigureAwait(false);
        var entry = paths.EnsureWithin(paths.QuarantineRoot, Path.Combine(paths.QuarantineRoot, key), "Quarantine entry");
        var source = paths.EnsureWithin(entry, Path.Combine(entry, QuarantineScriptDirectory), "Quarantined script");
        var target = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, record.ScriptId), "Script restore target");
        if (Directory.Exists(target) || File.Exists(target))
        {
            throw new IOException($"Restore conflict: script is already installed: {record.ScriptId}.");
        }

        await ReloadConfigAsync(cancellationToken).ConfigureAwait(false);
        var descriptor = await LoadDescriptorAsync(source, cancellationToken).ConfigureAwait(false);
        await CheckSkillAsync(descriptor, cancellationToken).ConfigureAwait(false);
        Directory.Move(source, target);
        try
        {
            await SyncSkillAsync(descriptor, globalEnabled && !safeMode && (!enabledOverrides.TryGetValue(record.ScriptId, out var enabled) || enabled), cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            await SyncSkillAsync(descriptor, false, CancellationToken.None).ConfigureAwait(false);
            Directory.Move(target, source);
            throw;
        }
        try
        {
            Directory.Delete(entry, recursive: true);
        }
        catch (IOException)
        {
            // The restored package is authoritative; a stale metadata entry is ignored because its script directory is gone.
        }

        return record;
    }

    private async Task<QuarantineRecord> ReadQuarantineAsync(string key, CancellationToken cancellationToken)
    {
        if (!QuarantineKeyRegex().IsMatch(key))
        {
            throw new ArgumentException("Invalid quarantine key.", nameof(key));
        }

        var entry = paths.EnsureWithin(paths.QuarantineRoot, Path.Combine(paths.QuarantineRoot, key), "Quarantine entry");
        var entryInfo = new DirectoryInfo(entry);
        if (!entryInfo.Exists || entryInfo.Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            throw new InvalidDataException("Invalid quarantine entry.");
        }

        var metadataPath = paths.EnsureWithin(entry, Path.Combine(entry, QuarantineMetadataName), "Quarantine metadata");
        var metadataInfo = new FileInfo(metadataPath);
        if (!metadataInfo.Exists || metadataInfo.Attributes.HasFlag(FileAttributes.ReparsePoint) || metadataInfo.Length > 64 * 1024)
        {
            throw new InvalidDataException("Invalid quarantine metadata file.");
        }
        await using var stream = File.OpenRead(metadataPath);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.GetProperty("schemaVersion").GetInt32() != 1)
        {
            throw new InvalidDataException("Invalid quarantine metadata.");
        }

        var metadataKey = root.GetProperty("key").GetString() ?? string.Empty;
        var scriptId = root.GetProperty("scriptId").GetString() ?? string.Empty;
        var name = root.GetProperty("name").GetString() ?? string.Empty;
        var version = root.GetProperty("version").GetString() ?? string.Empty;
        if (!string.Equals(metadataKey, key, StringComparison.Ordinal) || !ScriptIdRegex().IsMatch(scriptId) ||
            string.IsNullOrWhiteSpace(name) || name.Length > 128 || version.Length > 128)
        {
            throw new InvalidDataException("Invalid quarantine metadata fields.");
        }

        var quarantinedAt = root.GetProperty("quarantinedAt").GetDateTimeOffset();
        var record = new QuarantineRecord(key, scriptId, name, version, root.GetProperty("enabled").GetBoolean(), quarantinedAt);
        var scriptDirectory = paths.EnsureWithin(entry, Path.Combine(entry, QuarantineScriptDirectory), "Quarantined script");
        var descriptor = await LoadDescriptorAsync(scriptDirectory, cancellationToken).ConfigureAwait(false);
        if (!string.Equals(descriptor.Id, scriptId, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Quarantined script id does not match metadata.");
        }

        return record;
    }

    [GeneratedRegex("^q-[a-f0-9]+-[a-f0-9]{12}$", RegexOptions.CultureInvariant)]
    private static partial Regex QuarantineKeyRegex();
}
