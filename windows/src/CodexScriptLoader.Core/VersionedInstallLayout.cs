using System.Text.RegularExpressions;

namespace CodexScriptLoader.Core;

public sealed class VersionedInstallLayout
{
    private static readonly Regex VersionPattern = new("^[0-9]+\\.[0-9]+\\.[0-9]+$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> SupportedRids = new(StringComparer.Ordinal) { "win-x64", "win-arm64" };

    public VersionedInstallLayout(string installRoot)
    {
        InstallRoot = Path.GetFullPath(installRoot);
        VersionsRoot = Path.Combine(InstallRoot, "versions");
        ActivePointerPath = Path.Combine(InstallRoot, "active.json");
        PreviousPointerPath = Path.Combine(InstallRoot, "previous.json");
    }

    public string InstallRoot { get; }
    public string VersionsRoot { get; }
    public string ActivePointerPath { get; }
    public string PreviousPointerPath { get; }
    public bool IsStandardInstallation => File.Exists(Path.Combine(InstallRoot, ".codex-script-loader-install"));

    public static VersionedInstallLayout? TryFromHostBaseDirectory(string hostBaseDirectory)
    {
        var ridDirectory = new DirectoryInfo(Path.GetFullPath(hostBaseDirectory).TrimEnd(Path.DirectorySeparatorChar));
        var versionDirectory = ridDirectory.Parent;
        var versionsDirectory = versionDirectory?.Parent;
        var installDirectory = versionsDirectory?.Parent;
        if (versionDirectory is null || versionsDirectory is null || installDirectory is null ||
            !string.Equals(versionsDirectory.Name, "versions", StringComparison.OrdinalIgnoreCase) ||
            !VersionPattern.IsMatch(versionDirectory.Name) || !SupportedRids.Contains(ridDirectory.Name))
        {
            return null;
        }

        return new VersionedInstallLayout(installDirectory.FullName);
    }

    public string ResolveHostPath(InstallPointer pointer)
    {
        ValidatePointer(pointer);
        var versionRoot = EnsureWithin(VersionsRoot, Path.Combine(VersionsRoot, pointer.Version, pointer.Rid), "version directory");
        return EnsureWithin(versionRoot, Path.Combine(versionRoot, pointer.EntryPoint), "host entry point");
    }

    public string ResolveVersionDirectory(string version, string rid)
    {
        ValidateVersionAndRid(version, rid);
        return EnsureWithin(VersionsRoot, Path.Combine(VersionsRoot, version, rid), "version directory");
    }

    public static void ValidatePointer(InstallPointer pointer)
    {
        if (pointer.SchemaVersion != 1 || pointer.LauncherProtocol <= 0 || pointer.HandoffProtocol <= 0)
        {
            throw new InvalidDataException("Install pointer protocol is unsupported.");
        }

        ValidateVersionAndRid(pointer.Version, pointer.Rid);
        if (string.IsNullOrWhiteSpace(pointer.EntryPoint) || Path.IsPathRooted(pointer.EntryPoint) || pointer.EntryPoint.Contains("..", StringComparison.Ordinal) ||
            pointer.EntryPoint.IndexOfAny(Path.GetInvalidPathChars()) >= 0)
        {
            throw new InvalidDataException("Install pointer entry point is invalid.");
        }
    }

    public static void ValidateVersionAndRid(string version, string rid)
    {
        if (!VersionPattern.IsMatch(version) || !SupportedRids.Contains(rid))
        {
            throw new InvalidDataException("Version or runtime identifier is invalid.");
        }
    }

    public static int CompareVersions(string left, string right)
    {
        ValidateVersionAndRid(left, "win-x64");
        ValidateVersionAndRid(right, "win-x64");
        return Version.Parse(left).CompareTo(Version.Parse(right));
    }

    public static string EnsureWithin(string root, string candidate, string label)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var fullCandidate = Path.GetFullPath(candidate);
        if (!fullCandidate.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException($"{label} escapes the allowed directory.");
        }

        return fullCandidate;
    }
}
