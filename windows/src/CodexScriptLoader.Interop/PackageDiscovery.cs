using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Interop;

public static partial class PackageDiscovery
{
    public const string CodexPackageFamilyName = "OpenAI.Codex_2p2nqsd0c76g0";
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
        if (applicationIds.Count != 1)
        {
            throw new InvalidOperationException(
                $"Expected exactly one application id for '{fullName}', found {applicationIds.Count}.");
        }

        var versionMatch = PackageVersionRegex().Match(fullName);
        if (!versionMatch.Success || !Version.TryParse(versionMatch.Groups[1].Value, out var version))
        {
            throw new InvalidOperationException($"Package version could not be parsed from '{fullName}'.");
        }

        var architecture = versionMatch.Groups[2].Value;
        var returnedApplicationId = applicationIds[0];
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
