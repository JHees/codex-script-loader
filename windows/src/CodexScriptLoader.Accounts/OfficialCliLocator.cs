using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace CodexScriptLoader.Accounts;

public sealed record OfficialCli(string Executable, string Sha256);

public static class OfficialCliLocator
{
    public static OfficialCli Find()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenAI", "Codex", "bin");
        if (!Directory.Exists(root)) throw new InvalidOperationException("OFFICIAL_CLI_UNAVAILABLE");
        foreach (var directory in new DirectoryInfo(root).EnumerateDirectories().OrderByDescending(item => item.LastWriteTimeUtc))
        {
            if (directory.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
            var path = Path.Combine(directory.FullName, "codex.exe");
            if (!File.Exists(path) || File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint) || !IsOfficial(path)) continue;
            using var file = File.OpenRead(path);
            return new OfficialCli(path, Convert.ToHexString(SHA256.HashData(file)));
        }
        throw new InvalidOperationException("OFFICIAL_CLI_UNAVAILABLE");
    }

    public static bool IsOfficial(string path)
    {
        var fileName = Marshal.StringToCoTaskMemUni(path);
        var filePointer = Marshal.AllocHGlobal(Marshal.SizeOf<TrustFile>());
        var data = new TrustData
        {
            Size = (uint)Marshal.SizeOf<TrustData>(), UiChoice = 2, UnionChoice = 1, File = filePointer,
            StateAction = 1, ProviderFlags = 0x1010,
        };
        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try
        {
            Marshal.StructureToPtr(new TrustFile { Size = (uint)Marshal.SizeOf<TrustFile>(), FileName = fileName }, filePointer, false);
            if (WinVerifyTrust(new nint(-1), ref action, ref data) != 0) return false;
            var provider = WTHelperProvDataFromStateData(data.StateData);
            if (provider == 0) return false;
            var signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
            if (signer == 0) return false;
            var providerCertificate = WTHelperGetProvCertFromChain(signer, 0);
            if (providerCertificate == 0) return false;
            var context = Marshal.PtrToStructure<CertificateContext>(Marshal.PtrToStructure<ProviderCertificate>(providerCertificate).Certificate);
            var bytes = new byte[context.Length];
            Marshal.Copy(context.Bytes, bytes, 0, bytes.Length);
            using var certificate = X509CertificateLoader.LoadCertificate(bytes);
            return certificate.GetNameInfo(X509NameType.SimpleName, false) == "OpenAI OpCo, LLC";
        }
        catch (CryptographicException) { return false; }
        finally
        {
            data.StateAction = 2;
            WinVerifyTrust(new nint(-1), ref action, ref data);
            Marshal.FreeHGlobal(filePointer);
            Marshal.FreeCoTaskMem(fileName);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TrustFile { public uint Size; public nint FileName, FileHandle, KnownSubject; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProviderCertificate { public uint Size; public nint Certificate; }
    [StructLayout(LayoutKind.Sequential)]
    private struct CertificateContext { public uint Encoding; public nint Bytes; public uint Length; public nint Info, Store; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TrustData
    {
        public uint Size;
        public nint Policy, Sip;
        public uint UiChoice, Revocation, UnionChoice;
        public nint File;
        public uint StateAction;
        public nint StateData, UrlReference;
        public uint ProviderFlags, UiContext;
        public nint SignatureSettings;
    }
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern int WinVerifyTrust(nint window, ref Guid action, ref TrustData data);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern nint WTHelperProvDataFromStateData(nint state);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern nint WTHelperGetProvSignerFromChain(nint provider, uint index, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterIndex);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern nint WTHelperGetProvCertFromChain(nint signer, uint index);
}
