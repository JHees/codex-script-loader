using System.Diagnostics;
using System.Runtime.InteropServices;
using CodexScriptLoader.Interop;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task TestRestartRegistrationAsync()
    {
        const int port = 53171;
        var library = Path.Combine(AppContext.BaseDirectory, RestartRegistration.LibraryName);
        async Task Check(string original, bool accepted)
        {
            var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "NativeRestartFixture.exe"))
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            start.ArgumentList.Add(original);
            using var fixture = Process.Start(start)!;
            var window = (IntPtr)long.Parse((await fixture.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)))!);
            try
            {
                var before = RestartRegistration.Read(fixture.Id);
                if (accepted)
                {
                    var after = RestartRegistration.Ensure(fixture.Id, port, library);
                    True(RestartRegistration.Matches(after.Arguments, port), "Real native hook registers exactly the managed switches");
                    Equal(before.Flags, after.Flags, "Native registration preserves restart flags");
                    if (original.Length > 0) True(after.Arguments.StartsWith(original, StringComparison.Ordinal), "Existing restart state is retained verbatim");
                    Equal(after, RestartRegistration.Ensure(fixture.Id, port, library), "Registration is idempotent");
                }
                else
                {
                    Throws<InvalidOperationException>(() => RestartRegistration.Ensure(fixture.Id, port, library), "Conflicting or oversized arguments are not overwritten");
                    Equal(before, RestartRegistration.Read(fixture.Id), "Rejected registration leaves original settings intact");
                }
                Throws<ArgumentOutOfRangeException>(() => RestartRegistration.Ensure(fixture.Id, 0, library), "Invalid port never reaches the native hook");
                True(!fixture.HasExited, "Registration never closes the target process");
                _ = SendMessageTimeoutW(window, 0x8001, UIntPtr.Zero, IntPtr.Zero, 2, 3000, out _);
                _ = SendMessageTimeoutW(window, RegisterWindowMessageW("CodexScriptLoader.RegisterManagedRestart.v1"), (UIntPtr)(uint)fixture.Id, (IntPtr)port, 2, 3000, out _);
                Equal(string.Empty, RestartRegistration.Read(fixture.Id).Arguments, "Hook is removed on both success and rejection");
            }
            finally
            {
                _ = PostMessageW(window, 0x10, UIntPtr.Zero, IntPtr.Zero);
                await fixture.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
        }
        await Check(string.Empty, true);
        await Check("--restore-state \"window with spaces\"", true);
        await Check("--remote-debugging-port=53172", false);
        await Check("--remote-debugging-port=53171 --remote-debugging-port=53171", false);
        await Check(new string('x', 1000), false);
        True(!RestartRegistration.Matches("\"--remote-debugging-port=53171 extra\"", port), "Quoted lookalike arguments do not pass verification");
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wp, IntPtr lp);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterWindowMessageW(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
}
