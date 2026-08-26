namespace CodexScriptLoader.Interop;

public sealed record CodexPackageIdentity(
    string PackageFullName,
    string PackageFamilyName,
    string ApplicationId,
    string AppUserModelId,
    string Architecture,
    Version Version);

public sealed record TcpOwner(string Address, int Port, int ProcessId);
