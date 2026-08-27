namespace CodexScriptLoader.Core;

public enum UpdateStage
{
    Idle,
    Checking,
    Available,
    Downloading,
    Verifying,
    Staging,
    Switching,
    Succeeded,
    Failed,
    RolledBack,
}

public sealed record UpdatePreferences(
    int SchemaVersion = 1,
    bool AutoUpdate = true,
    string Channel = "stable");

public sealed record UpdateSnapshot(
    string CurrentVersion,
    string? AvailableVersion,
    UpdateStage State,
    DateTimeOffset? LastCheckedAt,
    double? Progress,
    string? ReleaseUrl,
    string? Error,
    bool RequiresInstaller,
    bool AutoUpdate,
    string Channel)
{
    public string? ErrorCode { get; init; }
}

public sealed record InstallPointer(
    int SchemaVersion,
    string Version,
    string Rid,
    string EntryPoint,
    int LauncherProtocol,
    int HandoffProtocol);

public sealed record UpdateManifestFile(
    string Path,
    long Size,
    string Sha256);

public sealed record UpdateManifest(
    int SchemaVersion,
    string Version,
    string Rid,
    string EntryPoint,
    int LauncherProtocol,
    int HandoffProtocol,
    IReadOnlyList<UpdateManifestFile> Files);

public sealed record UpdateTransaction(
    int SchemaVersion,
    string Id,
    UpdateStage State,
    string CurrentVersion,
    string TargetVersion,
    string Rid,
    int OldHostPid,
    int? CandidateHostPid,
    CdpEndpointIdentity Endpoint,
    int? ActivationProcessId,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string? Error);
