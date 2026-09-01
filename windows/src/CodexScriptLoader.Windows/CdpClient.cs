using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CodexScriptLoader.Windows;

internal sealed record CdpTarget(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("webSocketDebuggerUrl")] string WebSocketDebuggerUrl);

internal sealed class CdpClient : IDisposable
{
    private readonly HttpClient httpClient;
    private readonly int port;

    public CdpClient(int port)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(port, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(port, ushort.MaxValue);
        this.port = port;
        httpClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{port}/"),
            Timeout = TimeSpan.FromSeconds(3),
        };
    }

    public async Task<IReadOnlyList<CdpTarget>> GetCodexTargetsAsync(CancellationToken cancellationToken)
    {
        var targets = await GetTargetsAsync(cancellationToken).ConfigureAwait(false);
        return targets.Where(target =>
            string.Equals(target.Type, "page", StringComparison.Ordinal) &&
            string.Equals(target.Url, "app://-/index.html", StringComparison.Ordinal) &&
            IsManagedEndpoint(target.WebSocketDebuggerUrl)).ToArray();
    }

    public async Task<CdpTarget?> GetTargetByIdAsync(string targetId, CancellationToken cancellationToken)
    {
        var targets = await GetTargetsAsync(cancellationToken).ConfigureAwait(false);
        return targets.SingleOrDefault(target =>
            string.Equals(target.Id, targetId, StringComparison.Ordinal) &&
            IsManagedEndpoint(target.WebSocketDebuggerUrl));
    }

    public async Task<IReadOnlyList<CdpTarget>> GetPageTargetsAsync(string origin, CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var expected) || expected.GetLeftPart(UriPartial.Authority) != origin)
        {
            throw new ArgumentException("Page target origin is invalid.", nameof(origin));
        }
        var targets = await GetTargetsAsync(cancellationToken).ConfigureAwait(false);
        return targets.Where(target =>
            string.Equals(target.Type, "page", StringComparison.Ordinal) &&
            Uri.TryCreate(target.Url, UriKind.Absolute, out var page) &&
            string.Equals(page.GetLeftPart(UriPartial.Authority), origin, StringComparison.Ordinal) &&
            IsManagedEndpoint(target.WebSocketDebuggerUrl)).ToArray();
    }

    public async Task<Uri> GetBrowserEndpointAsync(CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync("json/version", cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false), cancellationToken: cancellationToken).ConfigureAwait(false);
        var endpoint = document.RootElement.GetProperty("webSocketDebuggerUrl").GetString();
        if (!IsManagedEndpoint(endpoint))
        {
            throw new InvalidDataException("Browser CDP endpoint is not the managed loopback port.");
        }

        return new Uri(endpoint!);
    }

    public bool IsManagedEndpoint(string? endpoint)
    {
        return Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) &&
            uri.Scheme is "ws" or "wss" &&
            uri.Port == port &&
            IPAddress.TryParse(uri.Host, out var address) && IPAddress.IsLoopback(address);
    }

    private async Task<IReadOnlyList<CdpTarget>> GetTargetsAsync(CancellationToken cancellationToken) =>
        await httpClient.GetFromJsonAsync<CdpTarget[]>("json", cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("CDP target response is empty.");

    public void Dispose() => httpClient.Dispose();
}

internal sealed class CdpSession : IAsyncDisposable
{
    private readonly ClientWebSocket socket = new();
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> pending = new();
    private readonly CancellationTokenSource lifetime = new();
    private Task? receiveTask;
    private int nextId;

    public event Action<JsonElement>? EventReceived;

    public static async Task<CdpSession> ConnectAsync(Uri endpoint, CancellationToken cancellationToken)
    {
        if (!IPAddress.TryParse(endpoint.Host, out var address) || !IPAddress.IsLoopback(address) || endpoint.Scheme is not ("ws" or "wss"))
        {
            throw new InvalidOperationException("CDP WebSocket must be loopback-only.");
        }

        var session = new CdpSession();
        try
        {
            await session.socket.ConnectAsync(endpoint, cancellationToken).ConfigureAwait(false);
            session.receiveTask = session.ReceiveLoopAsync();
            return session;
        }
        catch
        {
            await session.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<JsonElement> SendAsync(string method, object? parameters = null, CancellationToken cancellationToken = default)
    {
        if (socket.State != WebSocketState.Open)
        {
            throw new InvalidOperationException("CDP WebSocket is not open.");
        }

        var id = Interlocked.Increment(ref nextId);
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!pending.TryAdd(id, completion))
        {
            throw new InvalidOperationException("CDP command id collision.");
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        using var registration = timeout.Token.Register(() => completion.TrySetCanceled(timeout.Token));
        try
        {
            var payload = JsonSerializer.SerializeToUtf8Bytes(new { id, method, @params = parameters ?? new { } });
            await socket.SendAsync(payload, WebSocketMessageType.Text, true, timeout.Token).ConfigureAwait(false);
            return await completion.Task.ConfigureAwait(false);
        }
        finally
        {
            pending.TryRemove(id, out _);
        }
    }

    private async Task ReceiveLoopAsync()
    {
        var buffer = new byte[32 * 1024];
        try
        {
            while (!lifetime.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, lifetime.Token).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        throw new WebSocketException("CDP WebSocket closed.");
                    }

                    message.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                message.Position = 0;
                using var document = await JsonDocument.ParseAsync(message, cancellationToken: lifetime.Token).ConfigureAwait(false);
                var root = document.RootElement;
                if (root.TryGetProperty("id", out var idElement) && pending.TryGetValue(idElement.GetInt32(), out var completion))
                {
                    if (root.TryGetProperty("error", out var error))
                    {
                        completion.TrySetException(new InvalidOperationException(error.TryGetProperty("message", out var text) ? text.GetString() : "CDP command failed."));
                    }
                    else
                    {
                        completion.TrySetResult(root.TryGetProperty("result", out var commandResult) ? commandResult.Clone() : default);
                    }
                }
                else
                {
                    try
                    {
                        EventReceived?.Invoke(root.Clone());
                    }
                    catch
                    {
                    }
                }
            }
        }
        catch (Exception exception) when (exception is OperationCanceledException or WebSocketException or JsonException)
        {
            foreach (var completion in pending.Values)
            {
                completion.TrySetException(new IOException("CDP WebSocket receive loop stopped.", exception));
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            try
            {
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Loader session closed", CancellationToken.None).ConfigureAwait(false);
            }
            catch (WebSocketException)
            {
            }
        }

        if (receiveTask is not null)
        {
            try
            {
                await receiveTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        foreach (var completion in pending.Values)
        {
            completion.TrySetCanceled();
        }

        socket.Dispose();
        lifetime.Dispose();
    }
}
