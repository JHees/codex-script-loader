using System.ComponentModel;
using System.Runtime.InteropServices;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.HostTransportProbe;

internal sealed class PackageDebugLease : IDisposable
{
    private readonly object instance;
    private readonly IPackageDebugSettings settings;
    private readonly string package;
    private bool enabled;

    internal PackageDebugLease(string package)
    {
        this.package = package;
        var type = Type.GetTypeFromCLSID(new Guid("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D"), true)!;
        instance = Activator.CreateInstance(type)!;
        settings = (IPackageDebugSettings)instance;
    }

    internal void Enable(string debugger, IReadOnlyDictionary<string, string> environment)
    {
        var pointer = Marshal.StringToHGlobalUni(EnvironmentBlock(environment));
        try
        {
            enabled = true;
            CheckResult(settings.EnableDebugging(package, debugger, pointer), "IPackageDebugSettings.EnableDebugging");
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    internal static string EnvironmentBlock(IReadOnlyDictionary<string, string> values)
    {
        if (values.Count == 0 || values.Keys.Distinct(StringComparer.OrdinalIgnoreCase).Count() != values.Count
            || values.Any(pair => string.IsNullOrWhiteSpace(pair.Key)
            || pair.Key.IndexOfAny(['=', '\0']) >= 0 || pair.Value.Contains('\0')))
            throw new ArgumentException("Invalid environment block.");
        return string.Join('\0', values.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0";
    }

    internal static void CheckResult(int result, string operation)
    {
        if (result >= 0) return;
        var error = new COMException($"{operation} failed (0x{result:X8}).", result);
        error.Data["nativeOperation"] = operation;
        throw error;
    }

    internal void Clear() { CheckResult(settings.DisableDebugging(package), "IPackageDebugSettings.DisableDebugging"); enabled = false; }

    public void Dispose()
    {
        try { if (enabled) Clear(); }
        finally { if (Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance); }
    }

    internal static async Task ResumeAsync(string package, string directory, int processId, int threadId)
    {
        if (ProcessSnapshot.PackageFullName(processId) != package) throw new InvalidOperationException("Debugger target package mismatch.");
        var thread = OpenThread(0x0802, false, threadId);
        if (thread == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            if (GetProcessIdOfThread(thread) != processId) throw new InvalidOperationException("Debugger thread owner mismatch.");
            var previousCount = ResumeThread(thread);
            if (previousCount == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            await AtomicJsonFile.WriteAsync(Path.Combine(directory, $"resumed-{processId}.json"), new { processId, resumed = true, previousCount });
        }
        finally { CloseHandle(thread); }
    }

    [ComImport, Guid("F27C3930-8029-4AD1-94E3-3DBA417810C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPackageDebugSettings
    {
        [PreserveSig] int EnableDebugging([MarshalAs(UnmanagedType.LPWStr)] string package,
            [MarshalAs(UnmanagedType.LPWStr)] string debugger, IntPtr environment);
        [PreserveSig] int DisableDebugging([MarshalAs(UnmanagedType.LPWStr)] string package);
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenThread(uint access, bool inherit, int threadId);
    [DllImport("kernel32.dll")] private static extern uint GetProcessIdOfThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
