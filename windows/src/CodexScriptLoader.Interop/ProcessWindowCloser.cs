using System.Runtime.InteropServices;

namespace CodexScriptLoader.Interop;

/// <summary>
/// Requests a normal window-manager close for unmanaged Codex processes. The
/// application receives WM_CLOSE exactly as if the user clicked its close
/// button, so it can persist state and exit on its own terms; no process is
/// terminated.
/// </summary>
public static class ProcessWindowCloser
{
    private const uint WmClose = 0x0010;
    private const uint GetWindowOwner = 0x0004;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    public static int RequestClose(IReadOnlyCollection<int> processIds)
    {
        ArgumentNullException.ThrowIfNull(processIds);
        if (processIds.Count == 0) return 0;
        var targets = processIds.ToHashSet();
        var requested = 0;
        _ = EnumWindows((window, parameter) =>
        {
            _ = GetWindowThreadProcessId(window, out var owner);
            if (!targets.Contains(owner)) return true;
            // Owned dialogs belong to a top-level window that receives its own close.
            if (GetWindow(window, GetWindowOwner) != IntPtr.Zero) return true;
            if (PostMessageW(window, WmClose, IntPtr.Zero, IntPtr.Zero)) requested++;
            return true;
        }, IntPtr.Zero);
        return requested;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
