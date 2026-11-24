using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace CodexScriptLoader.Interop;

public static partial class PackageDiscovery
{
    public const string CodexPackageFamilyName = "OpenAI.Codex_2p2nqsd0c76g0";
    private const string PrimaryCodexApplicationId = "App";
    private const int ErrorInsufficientBuffer = 122;
    private const int ErrorNoMoreItems = 259;

    public static CodexPackageIdentity DiscoverCodexForCurrentUser() =>
        DiscoverForCurrentUser(CodexPackageFamilyName);

    public static CodexPackageIdentity DiscoverForCurrentUser(string packageFamilyName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageFamilyName);
        var packageNames = GetPackageFullNames(packageFamilyName);
        if (packageNames.Count == 0)
        {
            throw new InvalidOperationException($"No package registered for current user with family '{packageFamilyName}'.");
        }

        return packageNames
            .Select(fullName => CreateIdentity(packageFamilyName, fullName))
            .OrderByDescending(identity => identity.Version)
            .ThenBy(identity => ArchitectureRank(identity.Architecture))
            .First();
    }

    private static CodexPackageIdentity CreateIdentity(string familyName, string fullName)
    {
        var applicationIds = GetApplicationIds(fullName);

        var versionMatch = PackageVersionRegex().Match(fullName);
        if (!versionMatch.Success || !Version.TryParse(versionMatch.Groups[1].Value, out var version))
        {
            throw new InvalidOperationException($"Package version could not be parsed from '{fullName}'.");
        }

        var architecture = versionMatch.Groups[2].Value;
        var returnedApplicationId = SelectApplicationIdForActivation(familyName, fullName, applicationIds);
        var aumidPrefix = $"{familyName}!";
        var applicationId = returnedApplicationId.StartsWith(aumidPrefix, StringComparison.OrdinalIgnoreCase)
            ? returnedApplicationId[aumidPrefix.Length..]
            : returnedApplicationId;
        var appUserModelId = returnedApplicationId.StartsWith(aumidPrefix, StringComparison.OrdinalIgnoreCase)
            ? returnedApplicationId
            : $"{familyName}!{applicationId}";
        return new CodexPackageIdentity(
            fullName,
            familyName,
            applicationId,
            appUserModelId,
            architecture,
            version);
    }

    internal static string SelectApplicationIdForActivation(
        string packageFamilyName,
        string packageFullName,
        IReadOnlyCollection<string> applicationIds)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageFamilyName);
        ArgumentException.ThrowIfNullOrWhiteSpace(packageFullName);
        ArgumentNullException.ThrowIfNull(applicationIds);

        var expected = $"{packageFamilyName}!{PrimaryCodexApplicationId}";
        var matches = applicationIds
            .Where(applicationId => string.Equals(applicationId, expected, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (matches.Length == 1)
        {
            return matches[0];
        }

        throw new InvalidOperationException(
            $"Expected one primary application id '{expected}' for '{packageFullName}', found {matches.Length} among {applicationIds.Count} registered ids.");
    }

    private static IReadOnlyList<string> GetPackageFullNames(string packageFamilyName)
    {
        uint count = 0;
        uint bufferLength = 0;
        var result = GetPackagesByPackageFamily(packageFamilyName, ref count, IntPtr.Zero, ref bufferLength, IntPtr.Zero);
        if (result == ErrorNoMoreItems)
        {
            return [];
        }

        if (result != ErrorInsufficientBuffer)
        {
            throw new Win32Exception(result, "GetPackagesByPackageFamily size query failed.");
        }

        var pointers = Marshal.AllocHGlobal(checked((int)count * IntPtr.Size));
        var buffer = Marshal.AllocHGlobal(checked((int)bufferLength * sizeof(char)));
        try
        {
            result = GetPackagesByPackageFamily(packageFamilyName, ref count, pointers, ref bufferLength, buffer);
            if (result != 0)
            {
                throw new Win32Exception(result, "GetPackagesByPackageFamily failed.");
            }

            var names = new List<string>(checked((int)count));
            for (var index = 0; index < count; index++)
            {
                var pointer = Marshal.ReadIntPtr(pointers, checked((int)index * IntPtr.Size));
                var name = Marshal.PtrToStringUni(pointer);
                if (!string.IsNullOrWhiteSpace(name))
                {
                    names.Add(name);
                }
            }

            return names;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
            Marshal.FreeHGlobal(pointers);
        }
    }

    private static IReadOnlyList<string> GetApplicationIds(string packageFullName)
    {
        var result = OpenPackageInfoByFullName(packageFullName, 0, out var packageInfoReference);
        if (result != 0)
        {
            throw new Win32Exception(result, "OpenPackageInfoByFullName failed.");
        }

        try
        {
            uint bufferLength = 0;
            uint count = 0;
            result = GetPackageApplicationIds(packageInfoReference, ref bufferLength, IntPtr.Zero, out count);
            if (result != ErrorInsufficientBuffer)
            {
                throw new Win32Exception(result, "GetPackageApplicationIds size query failed.");
            }

            var buffer = Marshal.AllocHGlobal(checked((int)bufferLength));
            try
            {
                result = GetPackageApplicationIds(packageInfoReference, ref bufferLength, buffer, out count);
                if (result != 0)
                {
                    throw new Win32Exception(result, "GetPackageApplicationIds failed.");
                }

                var ids = new List<string>(checked((int)count));
                for (var index = 0; index < count; index++)
                {
                    var pointer = Marshal.ReadIntPtr(buffer, checked((int)index * IntPtr.Size));
                    var id = Marshal.PtrToStringUni(pointer);
                    if (!string.IsNullOrWhiteSpace(id))
                    {
                        ids.Add(id);
                    }
                }

                return ids;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            ClosePackageInfo(packageInfoReference);
        }
    }

    internal static string? FindApplicationExecutable(string packageFullName, string applicationId)
    {
        uint length = 0;
        if (GetPackagePathByFullName(packageFullName, ref length, null) != ErrorInsufficientBuffer) return null;
        var root = new StringBuilder(checked((int)length));
        if (GetPackagePathByFullName(packageFullName, ref length, root) != 0) return null;
        try
        {
            return ReadApplicationExecutable(root.ToString(), applicationId);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            // The Store can retire the old registration while its processes are exiting.
            return null;
        }
    }

    internal static string? ReadApplicationExecutable(string packageRoot, string applicationId)
    {
        var manifest = XElement.Load(Path.Combine(packageRoot, "AppxManifest.xml"));
        var ns = manifest.Name.Namespace;
        var entries = manifest.Element(ns + "Applications")?.Elements(ns + "Application")
            .Where(app => (string?)app.Attribute("Id") == applicationId).ToArray();
        if (entries is not { Length: 1 }) return null;
        var relative = (string?)entries[0].Attribute("Executable");
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative)) return null;
        var path = Path.GetFullPath(relative, packageRoot);
        var prefix = Path.TrimEndingDirectorySeparator(packageRoot) + Path.DirectorySeparatorChar;
        return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? path : null;
    }

    private static int ArchitectureRank(string architecture) => architecture.ToLowerInvariant() switch
    {
        "x64" when RuntimeInformation.ProcessArchitecture == Architecture.X64 => 0,
        "arm64" when RuntimeInformation.ProcessArchitecture == Architecture.Arm64 => 0,
        "neutral" => 1,
        _ => 2,
    };

    [GeneratedRegex(@"_(\d+\.\d+\.\d+\.\d+)_(x64|arm64|x86|neutral)_", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PackageVersionRegex();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackagePathByFullName(string packageFullName, ref uint pathLength, StringBuilder? path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackagesByPackageFamily(
        string packageFamilyName,
        ref uint count,
        IntPtr packageFullNames,
        ref uint bufferLength,
        IntPtr buffer);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int OpenPackageInfoByFullName(
        string packageFullName,
        uint reserved,
        out IntPtr packageInfoReference);

    [DllImport("kernel32.dll")]
    private static extern int GetPackageApplicationIds(
        IntPtr packageInfoReference,
        ref uint bufferLength,
        IntPtr buffer,
        out uint count);

    [DllImport("kernel32.dll")]
    private static extern int ClosePackageInfo(IntPtr packageInfoReference);
}
