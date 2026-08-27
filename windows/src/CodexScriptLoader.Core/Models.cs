namespace CodexScriptLoader.Core;

public enum LoaderState
{
    Starting,
    Healthy,
    Reloading,
    Degraded,
    Faulted,
    Stopping,
}

public sealed record CdpEndpointIdentity(
    string Address,
    int Port,
    int OwnerPid,
    string OwnerPackageFamilyName,
    string TargetUrl);

public sealed record ScriptLoadResult(
    string Id,
    string Version,
    string Hash,
    string PermissionResult,
    string LifecycleResult,
    string? ErrorCode);

public sealed record DiagnosticSnapshot(
    string LoaderVersion,
    LoaderState State,
    string? PackageFullName,
    string? PackageFamilyName,
    string? AppUserModelId,
    int? ActivationProcessId,
    CdpEndpointIdentity? Cdp,
    IReadOnlyList<ScriptLoadResult> Scripts,
    string SignatureStatus,
    string? LastError,
    DateTimeOffset StartedAt,
    DateTimeOffset? LastInjectionAt);

public sealed record ScriptDescriptor(
    string Id,
    string Name,
    string Version,
    string Scope,
    string RunAt,
    string? LifecycleGlobal,
    IReadOnlyList<string> Permissions,
    string Source,
    string Fingerprint,
    string Directory,
    string Description,
    string Author,
    string? Documentation,
    string SettingsMode,
    string? SettingsPageId,
    string? SettingsPageTitle);

public sealed record InjectionPlan(
    IReadOnlyList<ScriptDescriptor> Scripts,
    string Source,
    bool SafeMode);

public sealed record QuarantineRecord(
    string Key,
    string ScriptId,
    string Name,
    string Version,
    bool Enabled,
    DateTimeOffset QuarantinedAt);

public sealed record PluginSnapshot(
    string Id,
    string Name,
    string Version,
    string Description,
    string Author,
    bool Enabled,
    bool Bundled,
    string Status,
    string? Error,
    IReadOnlyList<string> Permissions,
    string SettingsMode,
    string? SettingsPageId,
    string? SettingsPageTitle,
    string? Documentation,
    string? DocumentationExcerpt,
    bool Legacy);

public sealed record PluginInstallPreview(
    string Token,
    string Id,
    string Name,
    string Version,
    string Description,
    string Author,
    IReadOnlyList<string> Permissions,
    string SettingsMode,
    string? SettingsPageTitle,
    string? DocumentationExcerpt,
    bool Legacy);

public sealed record PluginOperationResult(
    string Mode,
    IReadOnlyList<string> RequestedIds,
    int ScriptCount,
    int TargetCount,
    IReadOnlyList<string> Succeeded,
    IReadOnlyList<string> Failed,
    DateTimeOffset? LastInjectionAt);
