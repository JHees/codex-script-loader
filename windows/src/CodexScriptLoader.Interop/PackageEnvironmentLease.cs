using System.ComponentModel;
using System.Runtime.InteropServices;

namespace CodexScriptLoader.Interop;

public sealed class PackageEnvironmentLease : IDisposable
{
    private readonly object instance;
    private readonly IPackageDebugSettings settings;
    private readonly string package;
    private bool enabled;

    public PackageEnvironmentLease(string packageFullName)
    {
        package = packageFullName;
        instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D"), true)!)!;
        settings = (IPackageDebugSettings)instance;
    }

    public void Enable(string debugger, IReadOnlyDictionary<string, string> environment)
    {
        if (environment.Count == 0 || environment.Any(pair => string.IsNullOrWhiteSpace(pair.Key)
            || pair.Key.IndexOfAny(['=', '\0']) >= 0 || pair.Value.Contains('\0')))
            throw new ArgumentException("Invalid activation environment.");
        var block = string.Join('\0', environment.Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0";
        var pointer = Marshal.StringToHGlobalUni(block);
        try { enabled = true; Marshal.ThrowExceptionForHR(settings.EnableDebugging(package, debugger, pointer)); }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    public static void Resume(string expectedFamily, int processId, int threadId)
    {
        if (processId <= 0 || threadId <= 0 || ProcessIdentity.TryGetPackageFamilyName(processId) != expectedFamily)
            throw new InvalidOperationException("Activation helper process does not belong to the managed package.");
        var thread = OpenThread(0x0802, false, threadId);
        if (thread == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            if (GetProcessIdOfThread(thread) != processId) throw new InvalidOperationException("Activation thread owner mismatch.");
            if (ResumeThread(thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { CloseHandle(thread); }
    }

    public void Dispose()
    {
        try { if (enabled) { Marshal.ThrowExceptionForHR(settings.DisableDebugging(package)); enabled = false; } }
        finally { if (Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance); }
    }

    [ComImport, Guid("F27C3930-8029-4AD1-94E3-3DBA417810C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPackageDebugSettings
    {
        [PreserveSig] int EnableDebugging([MarshalAs(UnmanagedType.LPWStr)] string package,
            [MarshalAs(UnmanagedType.LPWStr)] string debugger, nint environment);
        [PreserveSig] int DisableDebugging([MarshalAs(UnmanagedType.LPWStr)] string package);
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint OpenThread(uint access, bool inherit, int threadId);
    [DllImport("kernel32.dll")] private static extern uint GetProcessIdOfThread(nint thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(nint thread);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(nint handle);
}
