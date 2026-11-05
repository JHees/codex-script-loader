using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexScriptLoader.Interop;

public sealed record ApplicationRestartSettings(string Arguments, uint Flags);

public static class RestartRegistration
{
    public const string LibraryName = "CodexScriptLoader.RestartHook.dll";
    private const uint Alive = 258;

    public static ApplicationRestartSettings Read(int processId)
    {
        using var process = Open(processId);
        return Read(process);
    }

    public static ApplicationRestartSettings Ensure(int processId, int port, string libraryPath)
    {
        if (port is < 1024 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        using var process = Open(processId);
        var before = Read(process);
        if (Matches(before.Arguments, port)) return before;
        IntPtr window = IntPtr.Zero;
        EnumWindowsProc find = (candidate, data) =>
        {
            _ = GetWindowThreadProcessId(candidate, out var owner);
            if (owner == processId && GetWindow(candidate, 4) == IntPtr.Zero)
            {
                window = candidate;
                if (IsWindowVisible(candidate)) return false;
            }
            return true;
        };
        _ = EnumWindows(find, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new InvalidOperationException("Managed Codex has no window thread for restart registration.");
        var thread = GetWindowThreadProcessId(window, out var windowOwner);
        if (thread == 0 || windowOwner != processId || WaitForSingleObject(process, 0) != Alive)
            throw new InvalidOperationException("Managed Codex process changed before restart registration.");
        var module = NativeLibrary.Load(Path.GetFullPath(libraryPath));
        IntPtr hook = IntPtr.Zero;
        try
        {
            var callback = NativeLibrary.GetExport(module, "RestartRegistrationHook");
            hook = SetWindowsHookExW(4, callback, module, thread);
            if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not attach the restart registration component.");
            var message = RegisterWindowMessageW("CodexScriptLoader.RegisterManagedRestart.v1");
            if (message == 0 || SendMessageTimeoutW(window, message, (UIntPtr)(uint)processId, (IntPtr)port, 2, 3000, out _) == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Restart registration did not respond.");
            var after = Read(process);
            if (after.Flags != before.Flags || !Matches(after.Arguments, port))
                throw new InvalidOperationException("Codex restart arguments could not be verified; existing arguments were not replaced.");
            return after;
        }
        finally
        {
            var unhookFailed = hook != IntPtr.Zero && !UnhookWindowsHookEx(hook);
            var error = unhookFailed ? Marshal.GetLastWin32Error() : 0;
            NativeLibrary.Free(module);
            GC.KeepAlive(find);
            if (unhookFailed) throw new Win32Exception(error, "Could not remove the restart registration hook.");
        }
    }

    public static bool Matches(string arguments, int port)
    {
        var parsed = CommandLineToArgvW("codex " + arguments, out var count);
        if (parsed == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var expected = new[] { "--remote-debugging-address=127.0.0.1", $"--remote-debugging-port={port}", $"--remote-allow-origins=http://127.0.0.1:{port}" };
            var found = new int[3];
            for (var i = 1; i < count; i++)
            {
                var value = Marshal.PtrToStringUni(Marshal.ReadIntPtr(parsed, i * IntPtr.Size))!;
                for (var key = 0; key < expected.Length; key++)
                {
                    var name = expected[key][..expected[key].IndexOf('=')];
                    if (value != name && !value.StartsWith(name + "=", StringComparison.Ordinal)) continue;
                    if (value != expected[key]) return false;
                    found[key]++;
                }
            }
            return found.All(value => value == 1);
        }
        finally { _ = LocalFree(parsed); }
    }

    private static SafeProcessHandle Open(int processId)
    {
        var handle = OpenProcess(0x1000 | 0x10 | 0x100000, false, processId);
        if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        return handle;
    }

    private static ApplicationRestartSettings Read(SafeProcessHandle process)
    {
        var buffer = new StringBuilder(1025);
        uint length = 1025;
        Marshal.ThrowExceptionForHR(GetApplicationRestartSettings(process, buffer, ref length, out var flags));
        return new(buffer.ToString(), flags);
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetApplicationRestartSettings(SafeProcessHandle process, StringBuilder arguments, ref uint length, out uint flags);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr SetWindowsHookExW(int type, IntPtr callback, IntPtr module, uint thread);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint RegisterWindowMessageW(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
