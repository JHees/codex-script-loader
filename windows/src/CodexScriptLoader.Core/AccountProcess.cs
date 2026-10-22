using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
namespace CodexScriptLoader.Core;
    internal sealed class AccountProcess : IAsyncDisposable
    {
        private readonly Process process;
        private readonly Task reader, stderr;
        private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonNode?>> pending = new();
        private readonly SemaphoreSlim writer = new(1, 1);
        private volatile bool closed;
        private long nextId;
        public bool IsRunning => !closed && !process.HasExited;

        public AccountProcess(ProcessStartInfo start)
        {
            process = Process.Start(start) ?? throw new AccountModuleException("BACKEND_START_FAILED");
            stderr = process.StandardError.BaseStream.CopyToAsync(Stream.Null);
            reader = ReadAsync();
        }

        public async Task<JsonNode?> RequestAsync(string method, JsonObject parameters, CancellationToken cancellation)
        {
            var id = Interlocked.Increment(ref nextId);
            var completion = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending[id] = completion;
            try
            {
                if (closed) throw new AccountModuleException("BACKEND_DISCONNECTED");
                var line = new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters }.ToJsonString();
                if (Encoding.UTF8.GetByteCount(line) > 64 * 1024) throw new AccountModuleException("BACKEND_MESSAGE_TOO_LARGE");
                await writer.WaitAsync(cancellation).ConfigureAwait(false);
                try
                {
                    await process.StandardInput.WriteLineAsync(line.AsMemory(), cancellation).ConfigureAwait(false);
                    await process.StandardInput.FlushAsync(cancellation).ConfigureAwait(false);
                }
                finally { writer.Release(); }
                try { return await completion.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellation).ConfigureAwait(false); }
                catch (TimeoutException) { throw new AccountModuleException("BACKEND_TIMEOUT"); }
            }
            finally { pending.TryRemove(id, out _); }
        }

        private async Task ReadAsync()
        {
            try
            {
                while (await process.StandardOutput.ReadLineAsync().ConfigureAwait(false) is { } line)
                {
                    if (Encoding.UTF8.GetByteCount(line) > 64 * 1024) break;
                    if (JsonNode.Parse(line) is not JsonObject response ||
                        response["id"] is not JsonValue value || !value.TryGetValue<long>(out var id)) break;
                    if (!pending.TryRemove(id, out var completion)) continue;
                    if (response["error"] is not null) completion.TrySetException(new AccountModuleException("BACKEND_REQUEST_FAILED"));
                    else completion.TrySetResult(response["result"]?.DeepClone());
                }
            }
            catch (Exception error) when (error is IOException or JsonException or InvalidOperationException or FormatException) { }
            finally
            {
                closed = true;
                foreach (var completion in pending.Values) completion.TrySetException(new AccountModuleException("BACKEND_DISCONNECTED"));
            }
        }

        public async ValueTask DisposeAsync()
        {
            process.StandardInput.Close();
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false); }
            catch (TimeoutException) { if (!process.HasExited) process.Kill(entireProcessTree: true); await process.WaitForExitAsync().ConfigureAwait(false); }
            await Task.WhenAll(reader, stderr).ConfigureAwait(false);
            process.Dispose();
            writer.Dispose();
        }
    }
