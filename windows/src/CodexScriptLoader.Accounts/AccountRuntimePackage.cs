using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CodexScriptLoader.Accounts;

public sealed record AccountRuntimeManifest(int SchemaVersion, int WorkerProtocol, int StoreSchema, string Version,
    string Revision, string AssemblySha256, string UiSha256);
public sealed record AccountRuntimePointer(int SchemaVersion, string Revision, string? PreviousRevision = null);

public sealed class AccountRuntimePackage
{
    public const string AssemblyFile = "CodexScriptLoader.Accounts.dll";
    public const string UiFile = "accounts-ui.js";
    public string Root { get; }
    public string RevisionsRoot => Path.Combine(Root, "revisions");
    public string PointerPath => Path.Combine(Root, "active.json");

    public AccountRuntimePackage(string dataDirectory)
    {
        Root = Path.Combine(Path.GetFullPath(dataDirectory), "runtime");
        Directory.CreateDirectory(Root); RejectLink(Root);
        Directory.CreateDirectory(RevisionsRoot); RejectLink(RevisionsRoot);
    }

    public static string Hash(string path)
    {
        RejectLink(path);
        using var file = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(file));
    }
    private static string Revision(string assemblyHash, string uiHash) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(assemblyHash + "\n" + uiHash)));

    public static AccountRuntimeManifest Create(string destination, string assemblyPath, string uiPath, string version)
    {
        Directory.CreateDirectory(destination); RejectLink(destination);
        File.Copy(assemblyPath, Path.Combine(destination, AssemblyFile), false);
        File.Copy(uiPath, Path.Combine(destination, UiFile), false);
        var assemblyHash = Hash(Path.Combine(destination, AssemblyFile)); var uiHash = Hash(Path.Combine(destination, UiFile));
        var manifest = new AccountRuntimeManifest(1, 1, 1, version, Revision(assemblyHash, uiHash), assemblyHash, uiHash);
        WriteJson(Path.Combine(destination, "manifest.json"), manifest);
        return manifest;
    }

    public static AccountRuntimeManifest Validate(string directory)
    {
        RejectLink(directory);
        var manifestPath = Path.Combine(directory, "manifest.json"); RejectLink(manifestPath);
        var manifest = JsonSerializer.Deserialize<AccountRuntimeManifest>(File.ReadAllBytes(manifestPath), AccountStore.JsonOptions)
            ?? throw new InvalidOperationException("ACCOUNT_UPDATE_MANIFEST_INVALID");
        if (manifest.SchemaVersion != 1 || manifest.WorkerProtocol != 1 || manifest.StoreSchema != 1)
            throw new InvalidOperationException("ACCOUNT_UPDATE_PROTOCOL");
        ValidateRevision(manifest.Revision);
        if (manifest.Revision != Revision(manifest.AssemblySha256, manifest.UiSha256) ||
            Hash(Path.Combine(directory, AssemblyFile)) != manifest.AssemblySha256 || Hash(Path.Combine(directory, UiFile)) != manifest.UiSha256)
            throw new InvalidOperationException("ACCOUNT_UPDATE_HASH_MISMATCH");
        return manifest;
    }

    public AccountRuntimeManifest Stage(string sourceDirectory)
    {
        var manifest = Validate(sourceDirectory);
        var destination = DirectoryFor(manifest.Revision);
        if (Directory.Exists(destination)) return Validate(destination);
        var temporary = Path.Combine(RevisionsRoot, ".stage-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        try
        {
            foreach (var name in new[] { AssemblyFile, UiFile, "manifest.json" }) File.Copy(Path.Combine(sourceDirectory, name), Path.Combine(temporary, name));
            _ = Validate(temporary);
            Directory.Move(temporary, destination);
            return manifest;
        }
        finally
        {
            if (Directory.Exists(temporary) && Path.GetFullPath(temporary).StartsWith(RevisionsRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                Directory.Delete(temporary, true);
        }
    }

    public AccountRuntimeManifest EnsureCurrent(string assemblyPath, string uiPath)
    {
        if (ReadPointer() is { } pointer) return Validate(DirectoryFor(pointer.Revision));
        var directory = Path.Combine(Root, ".initial-" + Guid.NewGuid().ToString("N"));
        try
        {
            var manifest = Create(directory, assemblyPath, uiPath, BackendService.Version);
            Stage(directory); Activate(manifest.Revision, null);
            return manifest;
        }
        finally
        {
            if (Directory.Exists(directory) && Path.GetFullPath(directory).StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                Directory.Delete(directory, true);
        }
    }

    public AccountRuntimePointer? ReadPointer()
    {
        if (!File.Exists(PointerPath)) return null;
        RejectLink(PointerPath);
        var pointer = JsonSerializer.Deserialize<AccountRuntimePointer>(File.ReadAllBytes(PointerPath), AccountStore.JsonOptions)
            ?? throw new InvalidOperationException("ACCOUNT_UPDATE_MANIFEST_INVALID");
        if (pointer.SchemaVersion != 1) throw new InvalidOperationException("ACCOUNT_UPDATE_PROTOCOL");
        ValidateRevision(pointer.Revision);
        return pointer;
    }

    public string DirectoryFor(string revision)
    {
        ValidateRevision(revision);
        var directory = Path.Combine(RevisionsRoot, revision);
        if (Directory.Exists(directory)) RejectLink(directory);
        return directory;
    }
    public void Activate(string revision, string? previous) => WriteJson(PointerPath, new AccountRuntimePointer(1, revision, previous));
    public static void WriteJson<T>(string path, T value)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, JsonSerializer.Serialize(value, AccountStore.JsonOptions)); File.Move(temporary, path, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private static void ValidateRevision(string revision)
    {
        if (revision.Length != 64 || revision.Any(character => character is not (>= 'a' and <= 'f' or >= '0' and <= '9')))
            throw new InvalidOperationException("ACCOUNT_UPDATE_MANIFEST_INVALID");
    }
    private static void RejectLink(string path)
    {
        if (File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint)) throw new InvalidOperationException("ACCOUNT_UPDATE_LINK_UNSUPPORTED");
    }
}
