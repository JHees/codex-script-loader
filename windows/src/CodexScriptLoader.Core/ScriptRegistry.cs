using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Core;

public sealed partial class ScriptRegistry
{
    private const int MaxManifestBytes = 64 * 1024;
    private const int MaxSourceBytes = 512 * 1024;
    private static readonly HashSet<string> AllowedRunAt = ["document-start", "document-end"];
    private static readonly HashSet<string> AllowedPageCompanionOrigins = ["https://chatgpt.com"];
    private readonly LoaderPaths paths;
    private readonly string settingsHostModulePath;
    private readonly SemaphoreSlim registryMutation = new(1, 1);
    private readonly HashSet<string> bundledIds = new(StringComparer.Ordinal);
    private bool safeMode;
    private bool globalEnabled = true;
    private bool configInvalid;
    private bool observedSafeMode;
    private Dictionary<string, bool> enabledOverrides = new(StringComparer.Ordinal);
    private readonly BundledSkillLinks? skillLinks;

    public ScriptRegistry(LoaderPaths paths, string settingsHostModulePath, string? userSkillRoot = null, Action<string, string>? createSkillLink = null)
    {
        this.paths = paths;
        this.settingsHostModulePath = Path.GetFullPath(settingsHostModulePath);
        if (userSkillRoot is not null && createSkillLink is not null)
            skillLinks = new BundledSkillLinks(paths, userSkillRoot, createSkillLink);
    }

    public bool SafeMode => observedSafeMode;

    private async Task CheckSkillAsync(ScriptDescriptor descriptor, CancellationToken token)
    {
        if (descriptor.AgentSkill is null) return;
        if (skillLinks is null) throw new InvalidOperationException("Bundled agent skills require a compatible native Windows Loader.");
        await skillLinks.CheckAsync(descriptor.Id, descriptor.AgentSkill, token).ConfigureAwait(false);
    }

    private async Task SyncSkillAsync(ScriptDescriptor descriptor, bool enabled, CancellationToken token)
    {
        if (skillLinks is null)
        {
            if (enabled && descriptor.AgentSkill is not null) throw new InvalidOperationException("Bundled agent skills require a compatible native Windows Loader.");
            return;
        }
        await skillLinks.SyncAsync(descriptor.Id, enabled ? descriptor.AgentSkill : null, token).ConfigureAwait(false);
    }

    public LoaderPaths Paths => paths;

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        paths.EnsureDirectories();
        await RecoverPendingPluginUpdateAsync(cancellationToken).ConfigureAwait(false);
        CleanupOrphanedPendingPackages();
        await ReloadConfigAsync(cancellationToken).ConfigureAwait(false);
        await ReconcileSkillEntriesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task ReconcileSkillEntriesAsync(CancellationToken cancellationToken = default)
    {
        // An install/update already synchronizes its skill under this lock before invoking reload.
        // Do not wait here: activation callbacks re-enter the supervisor while holding that lock.
        if (skillLinks is null || !await registryMutation.WaitAsync(0, cancellationToken).ConfigureAwait(false)) return;
        try
        {
            await ReloadConfigAsync(cancellationToken).ConfigureAwait(false);
            var desired = new List<ScriptDescriptor>();
            foreach (var directory in Directory.EnumerateDirectories(paths.ScriptsRoot))
            {
                try { desired.Add(await LoadDescriptorAsync(directory, cancellationToken).ConfigureAwait(false)); }
                catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException or UnauthorizedAccessException) { }
            }
            await skillLinks.ReconcileAsync(desired, id => globalEnabled && !safeMode && (!enabledOverrides.TryGetValue(id, out var enabled) || enabled), cancellationToken).ConfigureAwait(false);
        }
        finally { registryMutation.Release(); }
    }

    public async Task EnsureBundledScriptAsync(string bundledDirectory, CancellationToken cancellationToken = default)
    {
        var descriptor = await LoadDescriptorAsync(bundledDirectory, cancellationToken).ConfigureAwait(false);
        bundledIds.Add(descriptor.Id);
        var target = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, descriptor.Id), "Bundled script target");
        if (Directory.Exists(target))
        {
            return;
        }

        var temporary = paths.EnsureWithin(paths.ScriptsRoot, $"{target}.install-{Environment.ProcessId}", "Bundled script temporary target");
        Directory.CreateDirectory(temporary);
        try
        {
            foreach (var source in Directory.EnumerateFiles(Path.GetFullPath(bundledDirectory), "*", SearchOption.TopDirectoryOnly))
            {
                cancellationToken.ThrowIfCancellationRequested();
                File.Copy(source, Path.Combine(temporary, Path.GetFileName(source)), overwrite: false);
            }

            Directory.Move(temporary, target);
        }
        catch
        {
            if (Directory.Exists(temporary))
            {
                Directory.Delete(temporary, recursive: true);
            }

            throw;
        }
    }

    public async Task ReloadConfigAsync(CancellationToken cancellationToken = default)
    {
        var config = await ReadConfigAsync(cancellationToken).ConfigureAwait(false);
        configInvalid = config.Invalid;
        safeMode = config.SafeMode;
        globalEnabled = config.GlobalEnabled;
        enabledOverrides = config.Overrides;
    }

    private sealed record RegistryConfig(bool SafeMode, bool GlobalEnabled, bool Invalid, Dictionary<string, bool> Overrides);

    private async Task<RegistryConfig> ReadConfigAsync(CancellationToken cancellationToken)
    {
        var configInvalid = false;
        var safeMode = false;
        var globalEnabled = true;
        var enabledOverrides = new Dictionary<string, bool>(StringComparer.Ordinal);
        if (!File.Exists(paths.ConfigPath))
        {
            observedSafeMode = false;
            return new(false, true, false, enabledOverrides);
        }

        try
        {
            await using var stream = File.OpenRead(paths.ConfigPath);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                (root.TryGetProperty("schemaVersion", out var schema) && schema.GetInt32() != 1))
            {
                throw new InvalidDataException("Unsupported loader config schema.");
            }

            if (root.TryGetProperty("globalEnabled", out var global))
            {
                globalEnabled = global.ValueKind == JsonValueKind.True || global.ValueKind == JsonValueKind.False
                    ? global.GetBoolean()
                    : throw new InvalidDataException("globalEnabled must be a boolean.");
            }

            if (root.TryGetProperty("safeMode", out var safe))
            {
                safeMode = safe.ValueKind == JsonValueKind.True || safe.ValueKind == JsonValueKind.False
                    ? safe.GetBoolean()
                    : throw new InvalidDataException("safeMode must be a boolean.");
            }

            if (root.TryGetProperty("scripts", out var scripts))
            {
                if (scripts.ValueKind != JsonValueKind.Object)
                {
                    throw new InvalidDataException("scripts must be an object.");
                }

                foreach (var property in scripts.EnumerateObject())
                {
                    if (!ScriptIdRegex().IsMatch(property.Name) || property.Value.ValueKind != JsonValueKind.Object)
                    {
                        throw new InvalidDataException("Invalid script configuration entry.");
                    }

                    if (property.Value.TryGetProperty("enabled", out var enabled))
                    {
                        if (enabled.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                        {
                            throw new InvalidDataException("Script enabled state must be a boolean.");
                        }

                        enabledOverrides[property.Name] = enabled.GetBoolean();
                    }
                }
            }
        }
        catch (Exception exception) when (exception is JsonException or IOException or InvalidDataException or UnauthorizedAccessException or InvalidOperationException or FormatException or OverflowException)
        {
            safeMode = true;
            configInvalid = true;
        }
        observedSafeMode = safeMode;
        return new(safeMode, globalEnabled, configInvalid, enabledOverrides);
    }

    public async Task<InjectionPlan> BuildPlanAsync(bool force, CancellationToken cancellationToken = default)
    {
        var forceIds = force ? null : new HashSet<string>(StringComparer.Ordinal);
        return await BuildPlanAsync(forceIds, cancellationToken).ConfigureAwait(false);
    }

    public async Task<InjectionPlan> BuildPlanAsync(IReadOnlySet<string>? forceIds, CancellationToken cancellationToken = default)
    {
        var config = await ReadConfigAsync(cancellationToken).ConfigureAwait(false);
        var descriptors = new List<ScriptDescriptor>();
        foreach (var directory in Directory.EnumerateDirectories(paths.ScriptsRoot).OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var descriptor = await LoadDescriptorAsync(directory, cancellationToken).ConfigureAwait(false);
                if (config.GlobalEnabled && !config.SafeMode && (!config.Overrides.TryGetValue(descriptor.Id, out var enabled) || enabled))
                {
                    descriptors.Add(descriptor);
                }
            }
            catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException or UnauthorizedAccessException)
            {
            }
        }

        var settingsHost = await File.ReadAllTextAsync(settingsHostModulePath, Encoding.UTF8, cancellationToken).ConfigureAwait(false);
        return new InjectionPlan(
            descriptors,
            InjectionSourceBuilder.Build(
                descriptors,
                settingsHost,
                forceIds ?? descriptors.Select(descriptor => descriptor.Id).ToHashSet(StringComparer.Ordinal)),
            config.SafeMode);
    }

    public static async Task<ScriptDescriptor> LoadDescriptorAsync(string scriptDirectory, CancellationToken cancellationToken = default)
    {
        try { return await LoadDescriptorCoreAsync(scriptDirectory, cancellationToken).ConfigureAwait(false); }
        catch (Exception exception) when (exception is InvalidOperationException or FormatException or OverflowException or ArgumentException)
        {
            throw new InvalidDataException("Plugin manifest contains an invalid field type or path.", exception);
        }
    }

    private static async Task<ScriptDescriptor> LoadDescriptorCoreAsync(string scriptDirectory, CancellationToken cancellationToken)
    {
        var directory = new DirectoryInfo(Path.GetFullPath(scriptDirectory));
        if (!directory.Exists || directory.Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            throw new InvalidDataException("Script package must be a real directory.");
        }

        var manifestPath = Path.Combine(directory.FullName, "manifest.json");
        var manifestInfo = new FileInfo(manifestPath);
        if (!manifestInfo.Exists || manifestInfo.Attributes.HasFlag(FileAttributes.ReparsePoint) || manifestInfo.Length > MaxManifestBytes)
        {
            throw new InvalidDataException("Script manifest must be a regular file no larger than 64 KiB.");
        }

        await using var stream = manifestInfo.OpenRead();
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("Manifest must be an object.");
        }

        var schemaVersion = root.TryGetProperty("schemaVersion", out var schema) ? schema.GetInt32() : 1;
        if (schemaVersion is not (1 or 2))
        {
            throw new InvalidDataException("Unsupported manifest schema.");
        }

        var id = RequiredText(root, "id", 128);
        if (!ScriptIdRegex().IsMatch(id))
        {
            throw new InvalidDataException("Invalid script id.");
        }

        var entry = root.TryGetProperty("main", out var main) ? main.GetString() ?? "index.js" : "index.js";
        if (string.IsNullOrWhiteSpace(entry) || Path.IsPathRooted(entry) || entry.Length > 240 || entry.IndexOfAny(['\0', '\r', '\n']) >= 0)
        {
            throw new InvalidDataException("Manifest entry must be a safe relative path.");
        }

        var entryPath = Path.GetFullPath(Path.Combine(directory.FullName, entry));
        var rootPrefix = directory.FullName.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!entryPath.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Manifest entry escapes its script directory.");
        }

        var entryInfo = new FileInfo(entryPath);
        if (!entryInfo.Exists || entryInfo.Attributes.HasFlag(FileAttributes.ReparsePoint) || entryInfo.Length > MaxSourceBytes)
        {
            throw new InvalidDataException("Script entry must be a regular file no larger than 512 KiB.");
        }

        var scope = OptionalText(root, "scope", "renderer", 64);
        if (!string.Equals(scope, "renderer", StringComparison.Ordinal))
        {
            throw new InvalidDataException("Only renderer scripts are supported.");
        }

        var runAt = OptionalText(root, "runAt", "document-start", 64);
        if (!AllowedRunAt.Contains(runAt))
        {
            throw new InvalidDataException("Unsupported runAt value.");
        }

        var lifecycleGlobal = root.TryGetProperty("lifecycleGlobal", out var lifecycle) && lifecycle.ValueKind != JsonValueKind.Null
            ? lifecycle.GetString()
            : null;
        if (lifecycleGlobal is not null && !LifecycleRegex().IsMatch(lifecycleGlobal))
        {
            throw new InvalidDataException("Invalid lifecycle global.");
        }

        var permissions = new List<string>();
        if (root.TryGetProperty("permissions", out var permissionElement))
        {
            if (permissionElement.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("Manifest permissions must be an array.");
            }

            foreach (var item in permissionElement.EnumerateArray())
            {
                var permission = item.GetString();
                if (string.IsNullOrWhiteSpace(permission) || permission.Length > 64 || permission.Any(char.IsControl))
                {
                    throw new InvalidDataException("Invalid manifest permission.");
                }

                permissions.Add(permission);
            }

            if (permissions.Count > 32)
            {
                throw new InvalidDataException("Manifest declares too many permissions.");
            }
        }

        string? agentSkill = null;
        if (root.TryGetProperty("agentSkill", out var agentSkillElement))
        {
            agentSkill = agentSkillElement.GetString();
            if (schemaVersion != 2 || !permissions.Contains("agent-skills", StringComparer.Ordinal))
                throw new InvalidDataException("A bundled agentSkill requires schemaVersion 2 and the agent-skills permission.");
            await BundledSkillLinks.ValidatePackageAsync(directory.FullName, agentSkill, cancellationToken).ConfigureAwait(false);
        }

        HostCommandsDescriptor? hostCommands = null;
        if (root.TryGetProperty("hostCommands", out var hostCommandsElement))
        {
            if (hostCommandsElement.ValueKind != JsonValueKind.Object ||
                !hostCommandsElement.TryGetProperty("operations", out var hostOperationsElement) ||
                hostOperationsElement.ValueKind != JsonValueKind.Array ||
                hostOperationsElement.GetArrayLength() is < 1 or > 16)
            {
                throw new InvalidDataException("Manifest hostCommands operations must contain 1-16 items.");
            }

            var hostOperations = hostOperationsElement.EnumerateArray().Select(item => ValidateText(item.GetString(), "hostCommands operation", 64, allowEmpty: false)).ToArray();
            if (hostOperations.Distinct(StringComparer.Ordinal).Count() != hostOperations.Length || hostOperations.Any(operation => !PageCompanionOperationRegex().IsMatch(operation)))
            {
                throw new InvalidDataException("Manifest hostCommands operations are invalid or duplicated.");
            }

            hostCommands = new HostCommandsDescriptor(hostOperations);
        }

        PageCompanionDescriptor? pageCompanion = null;
        if (root.TryGetProperty("pageCompanion", out var pageCompanionElement))
        {
            if (pageCompanionElement.ValueKind != JsonValueKind.Object || !permissions.Contains("browser-page-companion", StringComparer.Ordinal))
            {
                throw new InvalidDataException("Manifest pageCompanion requires the browser-page-companion permission.");
            }

            var companionId = OptionalText(pageCompanionElement, "id", "main", 64);
            if (!ScriptIdRegex().IsMatch(companionId)) throw new InvalidDataException("Manifest pageCompanion id is invalid.");
            var companionOrigin = RequiredText(pageCompanionElement, "origin", 200);
            if (!Uri.TryCreate(companionOrigin, UriKind.Absolute, out var originUri) || originUri.GetLeftPart(UriPartial.Authority) != companionOrigin ||
                originUri.AbsolutePath != "/" || !string.IsNullOrEmpty(originUri.Query) || !string.IsNullOrEmpty(originUri.Fragment) ||
                !AllowedPageCompanionOrigins.Contains(companionOrigin))
            {
                throw new InvalidDataException("Manifest pageCompanion origin is not allowlisted.");
            }

            var companionEntry = ValidateRelativePackagePath(
                pageCompanionElement.TryGetProperty("main", out var companionMain) ? companionMain.GetString() : null,
                "pageCompanion main");
            var companionEntryPath = Path.GetFullPath(Path.Combine(directory.FullName, companionEntry));
            var companionRootPrefix = directory.FullName.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!companionEntryPath.StartsWith(companionRootPrefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Manifest pageCompanion main escapes its package.");
            var companionInfo = new FileInfo(companionEntryPath);
            if (!companionInfo.Exists || companionInfo.Attributes.HasFlag(FileAttributes.ReparsePoint) || companionInfo.Length > MaxSourceBytes)
            {
                throw new InvalidDataException("Page companion entry must be a regular file no larger than 512 KiB.");
            }

            if (!pageCompanionElement.TryGetProperty("operations", out var operationsElement) || operationsElement.ValueKind != JsonValueKind.Array ||
                operationsElement.GetArrayLength() is < 1 or > 16)
            {
                throw new InvalidDataException("Manifest pageCompanion operations must contain 1-16 items.");
            }
            var operations = operationsElement.EnumerateArray().Select(item => ValidateText(item.GetString(), "pageCompanion operation", 64, allowEmpty: false)).ToArray();
            if (operations.Distinct(StringComparer.Ordinal).Count() != operations.Length || operations.Any(operation => !PageCompanionOperationRegex().IsMatch(operation)))
            {
                throw new InvalidDataException("Manifest pageCompanion operations are invalid or duplicated.");
            }

            var companionSource = await File.ReadAllTextAsync(companionEntryPath, Encoding.UTF8, cancellationToken).ConfigureAwait(false);
            var companionFingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(companionSource)));
            pageCompanion = new PageCompanionDescriptor(companionId, companionOrigin, companionEntry, operations, companionSource, companionFingerprint);
        }

        var source = await File.ReadAllTextAsync(entryPath, Encoding.UTF8, cancellationToken).ConfigureAwait(false);
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(source)));
        if (root.TryGetProperty("integrity", out var integrityElement) && integrityElement.ValueKind != JsonValueKind.Null)
        {
            var integrity = integrityElement.GetString();
            if (!string.Equals(integrity, $"sha256-{fingerprint}", StringComparison.Ordinal))
            {
                throw new InvalidDataException($"Integrity mismatch for {id}.");
            }
        }

        var documentation = root.TryGetProperty("documentation", out var documentationElement) && documentationElement.ValueKind != JsonValueKind.Null
            ? ValidateRelativePackagePath(documentationElement.GetString(), "documentation")
            : null;
        var settingsMode = "legacy";
        string? settingsPageId = null;
        string? settingsPageTitle = null;
        if (root.TryGetProperty("settings", out var settingsElement))
        {
            if (settingsElement.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidDataException("Manifest settings must be an object.");
            }

            settingsMode = RequiredText(settingsElement, "mode", 16);
            if (settingsMode is not ("page" or "none"))
            {
                throw new InvalidDataException("Manifest settings mode must be page or none.");
            }

            if (settingsMode == "page")
            {
                settingsPageId = OptionalText(settingsElement, "pageId", "main", 64);
                settingsPageTitle = OptionalText(settingsElement, "title", OptionalText(root, "name", id, 128), 128);
                if (!permissions.Contains("settings", StringComparer.Ordinal))
                {
                    throw new InvalidDataException("A settings page requires the settings permission.");
                }
            }
        }

        PluginUpdateDescriptor? update = null;
        if (root.TryGetProperty("update", out var updateElement))
        {
            if (updateElement.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidDataException("Manifest update must be an object.");
            }

            var provider = RequiredText(updateElement, "provider", 32);
            if (provider != "github-releases")
            {
                throw new InvalidDataException("Manifest update provider must be github-releases.");
            }

            var repository = RequiredText(updateElement, "repository", 201);
            if (!GitHubRepositoryRegex().IsMatch(repository) || repository.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("Manifest update repository must be owner/repository.");
            }

            var asset = RequiredText(updateElement, "asset", 160);
            if (Path.GetFileName(asset) != asset || asset.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || !asset.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) ||
                asset.Split("{version}", StringSplitOptions.None).Length != 2 || asset.Replace("{version}", string.Empty, StringComparison.Ordinal).IndexOfAny(['{', '}']) >= 0)
            {
                throw new InvalidDataException("Manifest update asset must be a versioned ZIP filename using {version}.");
            }

            var version = OptionalText(root, "version", "0.0.0", 64);
            if (!StableVersionRegex().IsMatch(version))
            {
                throw new InvalidDataException("Manifest update requires a stable major.minor.patch version.");
            }

            update = new PluginUpdateDescriptor(provider, repository, asset);
        }

        return new ScriptDescriptor(
            id,
            OptionalText(root, "name", id, 128),
            OptionalText(root, "version", "0.0.0", 64),
            scope,
            runAt,
            lifecycleGlobal,
            permissions,
            source,
            fingerprint,
            directory.FullName,
            OptionalText(root, "description", string.Empty, 512, allowEmpty: true),
            OptionalText(root, "author", string.Empty, 128, allowEmpty: true),
            documentation,
            settingsMode,
            settingsPageId,
            settingsPageTitle,
            update,
            pageCompanion,
            hostCommands,
            agentSkill);
    }

    private static string ValidateRelativePackagePath(string? value, string name)
    {
        var path = value ?? string.Empty;
        if (string.IsNullOrWhiteSpace(path) || path.Length > 240 || Path.IsPathRooted(path) || path.IndexOfAny(['\0', '\r', '\n']) >= 0)
        {
            throw new InvalidDataException($"Manifest {name} must be a safe relative path.");
        }

        return path.Replace('/', Path.DirectorySeparatorChar);
    }

    private static string RequiredText(JsonElement root, string name, int maxLength) =>
        root.TryGetProperty(name, out var property)
            ? ValidateText(property.GetString(), name, maxLength, allowEmpty: false)
            : throw new InvalidDataException($"Manifest {name} is required.");

    private static string OptionalText(JsonElement root, string name, string fallback, int maxLength, bool allowEmpty = false) =>
        root.TryGetProperty(name, out var property)
            ? ValidateText(property.GetString(), name, maxLength, allowEmpty)
            : fallback;

    private static string ValidateText(string? value, string name, int maxLength, bool allowEmpty)
    {
        var text = value ?? string.Empty;
        if ((!allowEmpty && string.IsNullOrWhiteSpace(text)) || text.Length > maxLength || text.Any(char.IsControl))
        {
            throw new InvalidDataException($"Manifest {name} is invalid.");
        }

        return text;
    }

    [GeneratedRegex("^[a-z0-9][a-z0-9._-]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex ScriptIdRegex();

    [GeneratedRegex("^[A-Za-z_$][A-Za-z0-9_$]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex LifecycleRegex();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$", RegexOptions.CultureInvariant)]
    private static partial Regex GitHubRepositoryRegex();

    [GeneratedRegex("^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$", RegexOptions.CultureInvariant)]
    private static partial Regex StableVersionRegex();

    [GeneratedRegex("^[a-z][a-z0-9_]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex PageCompanionOperationRegex();
}
