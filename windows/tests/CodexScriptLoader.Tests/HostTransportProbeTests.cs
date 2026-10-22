using System.Diagnostics;
using System.Text;
using System.Text.Json;
using CodexScriptLoader.HostTransportProbe;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task<int> RunTransportFixtureAsync(string[] args)
    {
        if (args.ElementAtOrDefault(1) == "exit") return 23;
        await Console.OpenStandardError().WriteAsync(Encoding.UTF8.GetBytes("fixture stderr\0中文"));
        await Console.OpenStandardInput().CopyToAsync(Console.OpenStandardOutput());
        return 37;
    }

    private static async Task TestHostTransportProbeAsync(string root)
    {
        var block = PackageDebugLease.EnvironmentBlock(new Dictionary<string, string> { ["B"] = "中文=值", ["A"] = "spaced path" });
        Equal("A=spaced path\0B=中文=值\0\0", block, "Package environment is sorted, Unicode and double-NUL terminated");
        Throws<ArgumentException>(() => PackageDebugLease.EnvironmentBlock(new Dictionary<string, string> { ["A=B"] = "x" }), "Environment names reject separators");
        Throws<ArgumentException>(() => PackageDebugLease.EnvironmentBlock(new Dictionary<string, string> { ["A"] = "x\0y" }), "Environment values reject injected entries");
        Throws<ArgumentException>(() => PackageDebugLease.EnvironmentBlock(new Dictionary<string, string> { ["A"] = "x", ["a"] = "y" }), "Environment names are case insensitive");

        var args = ProcessSnapshot.SplitCommandLine("probe.exe \"path with spaces 中文\" \"quoted\\\"value\" tail\\");
        Equal("path with spaces 中文", args[1], "Native argument parsing retains Unicode and spaces");
        Equal("quoted\"value", args[2], "Native argument parsing retains literal quotes");
        Equal("tail\\", args[3], "Native argument parsing retains trailing slash");
        const string variable = "CODEX_LOADER_PROBE_TEST_ONLY";
        Environment.SetEnvironmentVariable(variable, "中文 baseline");
        try
        {
            var snapshot = ProcessSnapshot.Read(Environment.ProcessId, [variable, "CODEX_LOADER_PROBE_TEST_ABSENT"]);
            Equal("中文 baseline", snapshot.Environment[variable], "Read-only process capture preserves an allowlisted variable");
            Equal(2, snapshot.Environment.Count, "Process capture returns only requested variables");
            True(snapshot.Environment["CODEX_LOADER_PROBE_TEST_ABSENT"] == null, "Absent environment markers remain absent");
        }
        finally { Environment.SetEnvironmentVariable(variable, null); }

        var executable = Path.Combine(AppContext.BaseDirectory, "CodexScriptLoader.Tests.exe");
        var config = new ProbeConfig("fixture", executable, "unused", new()
        { ["CODEX_WINDOWS_REGISTERED_CORE"] = "captured", ["CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY"] = null,
            ["CODEX_HOME"] = Path.Combine(root, "original-profile"), ["CODEX_SQLITE_HOME"] = null }, true, root);
        var debuggerArguments = ProcessSnapshot.SplitCommandLine(config.DebuggerCommandLine);
        Equal(1, debuggerArguments.Length, "Windows debugger command contains only the executable; context is read from its baseline file");
        Equal(ProbeConfig.Executable, debuggerArguments[0], "Debugger executable survives spaces without extra arguments");
        var debuggerTarget = CodexScriptLoader.HostTransportProbe.Program.DebuggerArguments(["-p", "123", "-tid", "456"]);
        Equal((123, 456), debuggerTarget!.Value, "Debugger accepts the Windows-supplied PID/TID without custom arguments");
        True(CodexScriptLoader.HostTransportProbe.Program.DebuggerArguments(["-p", "profile", "app-server"]) == null, "A CLI profile option is not treated as a debugger invocation");
        Throws<ArgumentException>(() => CodexScriptLoader.HostTransportProbe.Program.DebuggerArguments(["-p", "-1", "-tid", "456"]), "Debugger rejects invalid target identifiers");
        try { PackageDebugLease.CheckResult(unchecked((int)0x80070057), "IPackageDebugSettings.EnableDebugging"); throw new InvalidOperationException("Expected the native failure."); }
        catch (System.Runtime.InteropServices.COMException error)
        {
            Equal(unchecked((int)0x80070057), error.HResult, "Native failure retains the exact HRESULT");
            Equal("IPackageDebugSettings.EnableDebugging", error.Data["nativeOperation"] as string, "Native failure identifies the precise API");
            True(error.Message.Contains("0x80070057", StringComparison.Ordinal), "Native failure remains useful when only stderr is available");
        }
        var start = config.CreateBackendStartInfo(["-c", "features.code_mode_host=true", "app-server", "--arg", "space 中文", "quote\"\\"]);
        True(!start.UseShellExecute && start.CreateNoWindow, "Relay creates only a hidden, directly owned child");
        Equal("space 中文", start.ArgumentList[4], "Relay preserves original argument values");
        Equal("quote\"\\", start.ArgumentList[5], "Relay does not shell-escape argument values");
        True(start.ArgumentList.Contains("features.windows_sandbox_service=true"), "Relay preserves captured sandbox service enablement");
        Equal("captured", start.Environment["CODEX_WINDOWS_REGISTERED_CORE"], "Relay restores the captured core marker");
        True(!start.Environment.ContainsKey("CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY"), "Relay removes absent baseline markers");
        Equal(executable, start.Environment["CODEX_CLI_PATH"], "Official child points helper calls to the real CLI");
        Equal(Path.Combine(root, "original-profile"), start.Environment["CODEX_HOME"], "Relay preserves the original credential/profile directory");
        True(!start.Environment.ContainsKey("CODEX_SQLITE_HOME"), "Relay preserves an absent SQLite override");
        True(!start.Environment.ContainsKey(ProbeConfig.ConfigVariable), "Official child does not recursively wrap itself");
        Throws<InvalidOperationException>(() => config.CreateBackendStartInfo(["app-server", "-c", "features.windows_sandbox_service=false"]), "Relay refuses a conflicting sandbox downgrade");
        True(!config.CreateBackendStartInfo(["exec", "app-server"]).ArgumentList.Contains("features.windows_sandbox_service=true"), "Other commands are not mistaken for app-server");

        var counts = new ProtocolCounts();
        var request = Encoding.UTF8.GetBytes("{\"id\":7,\"method\":\"initialize\",\"params\":{\"token\":\"DO-NOT-LOG\"}}\n");
        foreach (var value in request) counts.Observe(true, new byte[] { value });
        counts.Observe(false, Encoding.UTF8.GetBytes("{\"id\":7,\"result\":{\"secret\":\"DO-NOT-LOG\"}}\n"));
        counts.Observe(true, Encoding.UTF8.GetBytes("{\"method\":\"DO-NOT-LOG\"}\n"));
        counts.Observe(false, Encoding.UTF8.GetBytes(new string('x', 100_000) + "\n{\"method\":\"turn/completed\"}\n"));
        var observed = counts.Snapshot();
        True(observed.InitializeSucceeded, "Counter correlates fragmented initialize request and response in memory");
        Equal(1L, observed.ToBackend["<other>"], "Counter redacts unknown method names");
        Equal(1L, observed.UncountedFrames, "Oversized diagnostics are skipped without blocking subsequent frames");
        Equal(1L, observed.ToDesktop["turn/completed"], "Counter resumes after an oversized frame");
        True(!JsonSerializer.Serialize(observed).Contains("DO-NOT-LOG", StringComparison.Ordinal), "Diagnostics contain no request or response payload");

        var payload = Enumerable.Range(0, 300_000).Select(index => (byte)(index % 256)).ToArray();
        using var input = new MemoryStream(payload);
        using var output = new MemoryStream();
        using var errors = new MemoryStream();
        var code = await TransparentRelay.ForwardAsync(config.CreateBackendStartInfo(["--transport-fixture", "echo"]), input, output, errors, new ProtocolCounts()).WaitAsync(TimeSpan.FromSeconds(15));
        Equal(37, code, "Relay preserves the official child's exit code");
        True(payload.SequenceEqual(output.ToArray()), "Relay forwards large binary/Unicode/NUL data without reserialization");
        True(Encoding.UTF8.GetBytes("fixture stderr\0中文").SequenceEqual(errors.ToArray()), "Relay preserves stderr separately");
        using var never = new CancellableInput();
        var early = await TransparentRelay.ForwardAsync(config.CreateBackendStartInfo(["--transport-fixture", "exit"]), never, Stream.Null, Stream.Null).WaitAsync(TimeSpan.FromSeconds(5));
        Equal(23, early, "Child exit does not wait for desktop stdin to close");
        using var brokenInput = new MemoryStream(payload);
        using var brokenOutput = new BrokenOutput();
        Process? owned = null;
        var failed = false;
        try
        {
            await TransparentRelay.ForwardAsync(config.CreateBackendStartInfo(["--transport-fixture", "echo"]), brokenInput, brokenOutput, Stream.Null,
                onStarted: child => owned = Process.GetProcessById(child.Id)).WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (IOException) { failed = true; }
        True(failed, "A broken desktop output pipe is reported rather than ignored");
        True(owned?.HasExited == true, "A forwarding failure stops only the owned backend child");
        owned?.Dispose();
    }

    private sealed class BrokenOutput : MemoryStream
    {
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) => throw new IOException("fixture broken pipe");
    }

    private sealed class CancellableInput : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) { await Task.Delay(Timeout.Infinite, token); return 0; }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
