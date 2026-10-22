using System.Diagnostics;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.HostTransportProbe;

internal sealed record RelayReport(int WrapperPid, int BackendPid, bool AppServer, string State, int? ExitCode, CountsSnapshot Counts);

internal static class TransparentRelay
{
    internal static async Task<int> RunAsync(ProbeConfig config, string[] arguments)
    {
        var appServer = IsAppServer(arguments);
        var counts = new ProtocolCounts();
        var reportPath = Path.Combine(config.RunDirectory, $"relay-{Environment.ProcessId}.json");
        var backendId = 0;
        using var done = new CancellationTokenSource();
        async Task Save(string state, int? code)
        {
            try { await AtomicJsonFile.WriteAsync(reportPath, new RelayReport(Environment.ProcessId, backendId, appServer, state, code, counts.Snapshot())); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { /* A diagnostic write must not interrupt the official backend. */ }
        }
        Task? reporting = null;
        try
        {
            var exit = await ForwardAsync(config.CreateBackendStartInfo(arguments), Console.OpenStandardInput(),
                Console.OpenStandardOutput(), Console.OpenStandardError(),
                appServer ? counts : null, process =>
                {
                    backendId = process.Id;
                    reporting = Task.Run(async () =>
                    {
                        do
                        {
                            await Save("running", null);
                            try { await Task.Delay(1000, done.Token); } catch (OperationCanceledException) { break; }
                        } while (!done.IsCancellationRequested);
                    });
                });
            await done.CancelAsync();
            if (reporting != null) await reporting;
            await Save("exited", exit);
            return exit;
        }
        catch
        {
            await done.CancelAsync();
            if (reporting != null) await reporting;
            await Save("failed", null);
            throw;
        }
    }

    internal static bool IsAppServer(IReadOnlyList<string> arguments)
    {
        var index = 0;
        while (index + 1 < arguments.Count && arguments[index] is "-c" or "--config") index += 2;
        return index < arguments.Count && arguments[index] == "app-server";
    }

    internal static async Task<int> ForwardAsync(ProcessStartInfo start, Stream input, Stream output, Stream errors,
        ProtocolCounts? counts = null, Action<Process>? onStarted = null)
    {
        using var process = Process.Start(start) ?? throw new InvalidOperationException("The official backend did not start.");
        using var stopInput = new CancellationTokenSource();
        void StopChild()
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
        }
        async Task Pump(Stream from, Stream to, bool? direction, bool closeDestination, CancellationToken cancellation)
        {
            var buffer = new byte[64 * 1024];
            try
            {
                for (;;)
                {
                    var length = await from.ReadAsync(buffer, cancellation);
                    if (length == 0) break;
                    if (direction == true) counts?.Observe(true, buffer.AsSpan(0, length));
                    await to.WriteAsync(buffer.AsMemory(0, length), cancellation);
                    await to.FlushAsync(cancellation);
                    if (direction == false) counts?.Observe(false, buffer.AsSpan(0, length));
                }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
            catch { StopChild(); throw; }
            finally { Array.Clear(buffer); if (closeDestination) to.Dispose(); }
        }
        try
        {
            onStarted?.Invoke(process);
            var incoming = Pump(input, process.StandardInput.BaseStream, true, true, stopInput.Token);
            var outgoing = Pump(process.StandardOutput.BaseStream, output, false, false, CancellationToken.None);
            var stderr = Pump(process.StandardError.BaseStream, errors, null, false, CancellationToken.None);
            // Desktop input may remain open after a child exits; don't wait on that read.
            _ = incoming.ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
            await process.WaitForExitAsync();
            await stopInput.CancelAsync();
            await Task.WhenAll(outgoing, stderr);
            if (incoming.IsFaulted) await incoming;
            return process.ExitCode;
        }
        catch { StopChild(); throw; }
    }
}
