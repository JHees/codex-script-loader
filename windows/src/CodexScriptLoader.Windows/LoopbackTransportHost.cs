using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Windows;

internal static partial class LoopbackTransportEndpoint
{
    private static readonly Regex EndpointPattern = EndpointRegex();
    private static readonly Regex PathPattern = PathRegex();

    public static Uri Validate(string endpoint, IReadOnlySet<int>? forbiddenPorts = null)
    {
        if (string.IsNullOrWhiteSpace(endpoint) || Encoding.UTF8.GetByteCount(endpoint) > 2048 || !EndpointPattern.IsMatch(endpoint))
        {
            throw new InvalidDataException("loopback WebSocket endpoint is invalid");
        }

        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeWs ||
            uri.Host != "127.0.0.1" ||
            uri.UserInfo.Length != 0 ||
            uri.Query.Length != 0 ||
            uri.Fragment.Length != 0 ||
            uri.Port is < 1 or > 65535)
        {
            throw new InvalidDataException("loopback WebSocket endpoint is invalid");
        }

        var pathStart = endpoint.IndexOf('/', "ws://127.0.0.1:".Length);
        var path = pathStart >= 0 ? endpoint[pathStart..] : string.Empty;
        if (!PathPattern.IsMatch(path) || path.Length > 512 || path.Contains("..", StringComparison.Ordinal) || path.Contains('\\') || path.Any(char.IsControl))
        {
            throw new InvalidDataException("loopback WebSocket endpoint path is invalid");
        }

        for (var index = 0; index < path.Length; index++)
        {
            if (path[index] != '%' || index + 2 >= path.Length || !Uri.IsHexDigit(path[index + 1]) || !Uri.IsHexDigit(path[index + 2]))
            {
                if (path[index] == '%') throw new InvalidDataException("loopback WebSocket endpoint path is invalid");
                continue;
            }

            index += 2;
        }

        string decoded;
        try { decoded = Uri.UnescapeDataString(path); }
        catch { throw new InvalidDataException("loopback WebSocket endpoint path is invalid"); }
        if (decoded.Contains("..", StringComparison.Ordinal) || decoded.Contains('\\') || decoded.Any(char.IsControl) ||
            decoded.Contains("/devtools", StringComparison.OrdinalIgnoreCase) ||
            decoded.Contains("/json", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("loopback WebSocket endpoint path is invalid");
        }

        if (forbiddenPorts?.Contains(uri.Port) == true)
        {
            throw new InvalidDataException("loopback WebSocket endpoint cannot target the managed CDP port");
        }

        return uri;
    }

    [GeneratedRegex("^ws://127\\.0\\.0\\.1:(\\d{1,5})(/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)$", RegexOptions.CultureInvariant)]
    private static partial Regex EndpointRegex();

    [GeneratedRegex("^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex PathRegex();
}

internal sealed partial class LoopbackTransportHost : IAsyncDisposable
{
    private const string TransportGlobal = "__codexScriptLoaderLocalTransport";
    private const string Permission = "loopback-websocket";
    private const int ProtocolVersion = 1;
    private const int MaxRequestBytes = 16 * 1024;
    private const int MaxResponseBytes = 128 * 1024;
    private const int MaxFrameBytes = 64 * 1024;
    private const int MaxQueueBytes = 256 * 1024;
    private const int MaxQueueMessages = 32;
    private const int MaxConnectionsPerTarget = 8;
    private const int MaxConnectionsTotal = 32;
    private const int MaxDispatchInFlight = 32;
    private const int MaxDispatchRejectionsInFlight = 8;
    private const int MaxPendingRendererRequests = MaxDispatchInFlight;
    private const int MaxRetainedClosedConnectionsPerTarget = 8;
    private const int MaxRetainedClosedConnectionsTotal = 32;
    private const int MaxDestroyedContexts = 64;
    private const int MaxPollMilliseconds = 1000;
    private const int RequestTimeoutMilliseconds = 5000;
    private static readonly TimeSpan ClosedConnectionRetention = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ClosedConnectionSweepInterval = TimeSpan.FromSeconds(5);
    private static readonly Regex IdRegex = IdPattern();
    private static readonly Regex RequestIdRegex = RequestIdPattern();
    private static readonly Regex ConnectionIdRegex = ConnectionIdPattern();
    private readonly string bindingName = $"__codex_loader_transport_{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12))}";
    private readonly IReadOnlySet<int> forbiddenPorts;
    private readonly Dictionary<string, TransportTargetState> sessions = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim sync = new(1, 1);
    private readonly SemaphoreSlim dispatchSlots = new(MaxDispatchInFlight, MaxDispatchInFlight);
    private readonly SemaphoreSlim dispatchRejectionSlots = new(MaxDispatchRejectionsInFlight, MaxDispatchRejectionsInFlight);
    private readonly HashSet<string> authorized = new(StringComparer.Ordinal);
    private readonly System.Threading.Timer closedConnectionSweep;
    private int disposed;
    private int closedSweepRunning;
    private long authorizationGeneration;
    private bool closed;

    public LoopbackTransportHost(IEnumerable<int>? forbiddenPorts = null)
    {
        this.forbiddenPorts = new HashSet<int>(forbiddenPorts ?? [], EqualityComparer<int>.Default);
        closedConnectionSweep = new System.Threading.Timer(_ => _ = SweepClosedConnectionsAsync(), null, ClosedConnectionSweepInterval, ClosedConnectionSweepInterval);
    }

    public async Task SetAuthorizedPluginsAsync(IReadOnlyList<Core.ScriptDescriptor> descriptors, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(descriptors);
        await sync.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var nextAuthorized = new HashSet<string>(StringComparer.Ordinal);
            foreach (var descriptor in descriptors)
            {
                if (IdRegex.IsMatch(descriptor.Id) && descriptor.Permissions.Contains(Permission, StringComparer.Ordinal)) nextAuthorized.Add(descriptor.Id);
            }

            if (!authorized.SetEquals(nextAuthorized))
            {
                authorizationGeneration++;
                authorized.Clear();
                authorized.UnionWith(nextAuthorized);
            }

            foreach (var targetId in sessions.Keys.ToArray())
            {
                var state = sessions[targetId];
                foreach (var connection in state.Connections.Values.Where(connection => !authorized.Contains(connection.PluginId)).ToArray())
                {
                    connection.Close();
                    if (state.Connections.TryRemove(connection.Id, out _)) ReleaseOpenReservationUnlocked(state, connection);
                    await connection.DisposeAsync().ConfigureAwait(false);
                }
                if (authorized.Count == 0 && state.RegistrationId is not null)
                {
                    await DetachBindingUnlockedAsync(targetId, state, cancellationToken).ConfigureAwait(false);
                }
                else if (authorized.Count > 0 && state.RegistrationId is null)
                {
                    await AttachBindingUnlockedAsync(targetId, state, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            sync.Release();
        }
    }

    public async Task AttachToSessionAsync(CdpTarget target, CdpSession session, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(session);
        var endpoint = AssertManagedTarget(target.WebSocketDebuggerUrl);
        await sync.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (closed) throw new InvalidOperationException("loopback transport is closed");
            if (sessions.ContainsKey(target.Id)) return;
            var state = new TransportTargetState(target.Id, endpoint, session);
            sessions[target.Id] = state;
            try
            {
                if (authorized.Count > 0) await AttachBindingUnlockedAsync(target.Id, state, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                if (sessions.TryGetValue(target.Id, out var current) && ReferenceEquals(current, state))
                {
                    state.Active = false;
                    state.Generation++;
                    sessions.Remove(target.Id);
                }
                throw;
            }
        }
        finally
        {
            sync.Release();
        }
    }

    public async Task DetachSessionAsync(string targetId, CancellationToken cancellationToken = default)
    {
        TransportTargetState? state;
        await sync.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!sessions.Remove(targetId, out state)) return;
            state.Active = false;
            state.Generation++;

            // Keep the target handoff serialized. The binding name is host-wide;
            // allowing a replacement state to attach before this state removes
            // its binding/script could make the old cleanup tear down the new
            // renderer session.
            await DetachBindingUnlockedAsync(targetId, state, CancellationToken.None).ConfigureAwait(false);
        }
        finally
        {
            sync.Release();
        }
    }

    private static string AssertManagedTarget(string endpoint)
    {
        var uri = new Uri(endpoint, UriKind.Absolute);
        if (uri.Host != "127.0.0.1" || !IPAddress.TryParse(uri.Host, out var address) || !IPAddress.IsLoopback(address))
        {
            throw new InvalidDataException("managed CDP target endpoint is not loopback");
        }

        return uri.AbsoluteUri;
    }

    private async Task AttachBindingUnlockedAsync(string targetId, TransportTargetState state, CancellationToken cancellationToken)
    {
        if (state.RegistrationId is not null || authorized.Count == 0) return;
        var bindingAttempted = false;
        string? registrationId = null;
        Action? unsubscribe = null;
        try
        {
            bindingAttempted = true;
            await state.Session.SendAsync("Runtime.addBinding", new { name = bindingName }, cancellationToken).ConfigureAwait(false);
            var source = BuildClientSource();
            var registration = await state.Session.SendAsync("Page.addScriptToEvaluateOnNewDocument", new { source }, cancellationToken).ConfigureAwait(false);
            registrationId = registration.TryGetProperty("identifier", out var identifier) ? identifier.GetString() : null;
            if (string.IsNullOrWhiteSpace(registrationId)) throw new InvalidOperationException("Renderer future-script registration did not return an identifier.");
            state.RegistrationId = registrationId;
            unsubscribe = HandleEvent(targetId, state);
            state.Unsubscribe = unsubscribe;
            var evaluation = await state.Session.SendAsync("Runtime.evaluate", new { expression = source, returnByValue = true }, cancellationToken).ConfigureAwait(false);
            if (evaluation.TryGetProperty("exceptionDetails", out _)) throw new InvalidOperationException("Renderer rejected the local transport client.");
        }
        catch
        {
            try { unsubscribe?.Invoke(); } catch { }
            if (state.Unsubscribe == unsubscribe) state.Unsubscribe = null;
            state.RegistrationId = null;
            if (registrationId is not null)
            {
                try { await state.Session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", new { identifier = registrationId }, CancellationToken.None).ConfigureAwait(false); }
                catch { }
            }

            if (bindingAttempted)
            {
                try { await state.Session.SendAsync("Runtime.removeBinding", new { name = bindingName }, CancellationToken.None).ConfigureAwait(false); }
                catch { }
            }

            throw;
        }
    }

    private Action? HandleEvent(string targetId, TransportTargetState state)
    {
        void OnEvent(JsonElement message)
        {
            if (!message.TryGetProperty("method", out var methodElement) || methodElement.ValueKind != JsonValueKind.String)
            {
                return;
            }

            var method = methodElement.GetString();
            if (method == "Runtime.executionContextDestroyed" &&
                message.TryGetProperty("params", out var destroyedParameters) &&
                destroyedParameters.TryGetProperty("executionContextId", out var destroyedId) &&
                destroyedId.ValueKind == JsonValueKind.Number && destroyedId.TryGetInt32(out var executionContextId))
            {
                while (state.DestroyedContexts.Count >= MaxDestroyedContexts)
                {
                    var oldest = state.DestroyedContexts.Keys.FirstOrDefault();
                    if (!state.DestroyedContexts.TryRemove(oldest, out _)) break;
                }
                state.DestroyedContexts.TryAdd(executionContextId, 0);
                QueueRendererLifecycleCleanup(targetId, state, executionContextId, allContexts: false, lifecycleGeneration: null);
                return;
            }

            if (method == "Runtime.executionContextsCleared")
            {
                var lifecycleGeneration = Interlocked.Increment(ref state.Generation);
                state.DestroyedContexts.Clear();
                QueueRendererLifecycleCleanup(targetId, state, null, allContexts: true, lifecycleGeneration: lifecycleGeneration);
                return;
            }

            if (method == "Page.frameNavigated" &&
                message.TryGetProperty("params", out var navigationParameters) &&
                navigationParameters.TryGetProperty("frame", out var frame) &&
                frame.ValueKind == JsonValueKind.Object &&
                (!frame.TryGetProperty("parentId", out var parentId) || parentId.ValueKind == JsonValueKind.Null ||
                 (parentId.ValueKind == JsonValueKind.String && string.IsNullOrEmpty(parentId.GetString()))))
            {
                var lifecycleGeneration = Interlocked.Increment(ref state.Generation);
                state.DestroyedContexts.Clear();
                QueueRendererLifecycleCleanup(targetId, state, null, allContexts: true, lifecycleGeneration: lifecycleGeneration);
                return;
            }

            if (method == "Target.detachedFromTarget" &&
                (!message.TryGetProperty("params", out var detachedParameters) ||
                 !detachedParameters.TryGetProperty("targetId", out var detachedTargetId) ||
                 detachedTargetId.ValueKind != JsonValueKind.String || detachedTargetId.GetString() == targetId))
            {
                _ = DetachFromLifecycleEventAsync(targetId);
                return;
            }

            if (method != "Runtime.bindingCalled" ||
                !message.TryGetProperty("params", out var parameters) || !parameters.TryGetProperty("name", out var name) || name.GetString() != bindingName)
            {
                return;
            }

            try
            {
                if (!dispatchSlots.Wait(0))
                {
                    QueueDispatchRejection(targetId, state, parameters, Volatile.Read(ref state.Generation));
                    return;
                }
                _ = Task.Run(async () =>
                {
                    try { await DispatchBindingAsync(targetId, parameters).ConfigureAwait(false); }
                    catch { }
                    finally { ReleaseDispatchSlot(); }
                });
            }
            catch
            {
                ReleaseDispatchSlot();
            }
        }

        state.Session.EventReceived += OnEvent;
        return () => state.Session.EventReceived -= OnEvent;
    }

    private void QueueRendererLifecycleCleanup(string targetId, TransportTargetState state, int? executionContextId, bool allContexts, long? lifecycleGeneration)
    {
        _ = CleanupRendererConnectionsAsync(targetId, state, executionContextId, allContexts, lifecycleGeneration);
    }

    private async Task DetachFromLifecycleEventAsync(string targetId)
    {
        try { await DetachSessionAsync(targetId, CancellationToken.None).ConfigureAwait(false); }
        catch { }
    }

    private async Task CleanupRendererConnectionsAsync(string targetId, TransportTargetState state, int? executionContextId, bool allContexts, long? lifecycleGeneration)
    {
        List<TransportConnection> connections;
        try
        {
            await sync.WaitAsync().ConfigureAwait(false);
            try
            {
                if (closed || !state.Active || !sessions.TryGetValue(targetId, out var current) || !ReferenceEquals(current, state)) return;
                connections = state.Connections.Values
                    .Where(connection => allContexts
                        ? lifecycleGeneration is { } invalidationGeneration && connection.OwnerGeneration < invalidationGeneration
                        : connection.OwnerExecutionContextId == executionContextId)
                    .ToList();
                foreach (var connection in connections)
                {
                    if (state.Connections.TryRemove(connection.Id, out _)) ReleaseOpenReservationUnlocked(state, connection);
                }
            }
            finally
            {
                sync.Release();
            }
        }
        catch
        {
            return;
        }

        foreach (var connection in connections)
        {
            try { connection.Close(); } catch { }
            try { await connection.DisposeAsync().ConfigureAwait(false); } catch { }
        }
    }

    private void QueueDispatchRejection(string targetId, TransportTargetState state, JsonElement parameters, long ownerGeneration)
    {
        try
        {
            if (!dispatchRejectionSlots.Wait(0)) return;
        }
        catch (ObjectDisposedException)
        {
            return;
        }
        _ = Task.Run(async () =>
        {
            try
            {
                var requestId = TryGetRequestId(parameters);
                if (requestId is null) return;
                await SendRendererResponseAsync(targetId, state, parameters, new
                {
                    version = ProtocolVersion,
                    id = requestId,
                    ok = false,
                    errorCode = "DISPATCH_LIMIT",
                    message = "loopback WebSocket renderer dispatch limit reached",
                }, ownerGeneration).ConfigureAwait(false);
            }
            catch
            {
            }
            finally
            {
                ReleaseDispatchRejectionSlot();
            }
        });
    }

    private static string? TryGetRequestId(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.String) return null;
        var text = payload.GetString();
        if (string.IsNullOrWhiteSpace(text) || Encoding.UTF8.GetByteCount(text) > MaxRequestBytes) return null;
        try
        {
            using var document = JsonDocument.Parse(text);
            return HasUniqueKeys(document.RootElement) && document.RootElement.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && RequestIdRegex.IsMatch(id.GetString()!)
                ? id.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private void ReleaseDispatchRejectionSlot()
    {
        try { dispatchRejectionSlots.Release(); } catch (ObjectDisposedException) { }
    }

    private async Task DetachBindingUnlockedAsync(string targetId, TransportTargetState state, CancellationToken cancellationToken)
    {
        var connections = state.Connections.Values.ToArray();
        foreach (var connection in connections)
        {
            try { connection.Close(); } catch { }
            try { await connection.DisposeAsync().ConfigureAwait(false); } catch { }
        }
        state.Connections.Clear();
        state.Opening = 0;
        var registrationId = state.RegistrationId;
        state.RegistrationId = null;
        var unsubscribe = state.Unsubscribe;
        state.Unsubscribe = null;
        try { unsubscribe?.Invoke(); } catch { }
        if (registrationId is null) return;

        try
        {
            await state.Session.SendAsync("Runtime.evaluate", new { expression = $"globalThis[{JsonSerializer.Serialize(TransportGlobal)}]?.dispose('Loader local transport disconnected');" }, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
        }

        try { await state.Session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", new { identifier = registrationId }, CancellationToken.None).ConfigureAwait(false); }
        catch { }

        try { await state.Session.SendAsync("Runtime.removeBinding", new { name = bindingName }, CancellationToken.None).ConfigureAwait(false); }
        catch { }
    }

    private async Task DispatchBindingAsync(string targetId, JsonElement parameters)
    {
        try { await DispatchBindingCoreAsync(targetId, parameters).ConfigureAwait(false); }
        catch
        {
            // CDP event dispatch is intentionally fire-and-forget. A target can
            // disappear while a binding callback is queued; never leak an
            // unobserved task or expose a host exception to the renderer.
        }
    }

    private void ReleaseDispatchSlot()
    {
        try { dispatchSlots.Release(); } catch (ObjectDisposedException) { }
    }

    private async Task DispatchBindingCoreAsync(string targetId, JsonElement parameters)
    {
        TransportTargetState? state = null;
        long ownerGeneration = 0;
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!sessions.TryGetValue(targetId, out var current) || !current.Active) return;
            state = current;
            ownerGeneration = Volatile.Read(ref current.Generation);
        }
        finally
        {
            sync.Release();
        }

        if (state is null) return;

        string? requestId = null;
        object response;
        try
        {
            var payload = parameters.GetProperty("payload").GetString() ?? throw new InvalidDataException("transport payload is empty");
            var request = ParseRequest(payload);
            requestId = request.Id;
            var result = await HandleRequestAsync(state, request, TryGetExecutionContextId(parameters)).ConfigureAwait(false);
            response = new { version = ProtocolVersion, id = request.Id, ok = true, result };
        }
        catch (Exception exception)
        {
            if (requestId is null && parameters.TryGetProperty("payload", out var rawPayload) && rawPayload.ValueKind == JsonValueKind.String)
            {
                try
                {
                    using var raw = JsonDocument.Parse(rawPayload.GetString()!);
                    if (HasUniqueKeys(raw.RootElement) && raw.RootElement.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && RequestIdRegex.IsMatch(id.GetString()!)) requestId = id.GetString();
                }
                catch (JsonException) { }
            }

            if (requestId is null) return;
            var sanitized = SanitizeError(exception);
            response = new { version = ProtocolVersion, id = requestId, ok = false, errorCode = sanitized.Code, message = sanitized.Message };
        }

        var encoded = JsonSerializer.SerializeToUtf8Bytes(response, JsonOptions);
        if (encoded.Length > MaxResponseBytes) response = new { version = ProtocolVersion, id = requestId, ok = false, errorCode = "TRANSPORT_ERROR", message = "loopback WebSocket transport response is too large" };
        await SendRendererResponseAsync(targetId, state, parameters, response, ownerGeneration).ConfigureAwait(false);
    }

    private async Task SendRendererResponseAsync(string targetId, TransportTargetState state, JsonElement parameters, object response, long? ownerGeneration = null)
    {
        CdpSession? session = null;
        int? contextId = null;
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!sessions.TryGetValue(targetId, out var current) || !ReferenceEquals(current, state) || !state.Active) return;
            contextId = TryGetExecutionContextId(parameters);
            if (ownerGeneration is { } expectedGeneration && state.Generation != expectedGeneration) return;
            if (contextId is { } executionContextId && state.DestroyedContexts.ContainsKey(executionContextId)) return;
            session = state.Session;
        }
        finally
        {
            sync.Release();
        }

        if (session is null) return;

        var expression = $"globalThis[{JsonSerializer.Serialize(TransportGlobal)}]?.receive({JsonSerializer.Serialize(response, JsonOptions)});";
        try
        {
            await session.SendAsync("Runtime.evaluate", contextId.HasValue
                ? new { expression, contextId = contextId.Value, returnByValue = true }
                : new { expression, returnByValue = true }).ConfigureAwait(false);
        }
        catch
        {
            // The renderer may have navigated or the CDP session may have
            // disconnected while the daemon request was in flight.
        }
    }

    private static int? TryGetExecutionContextId(JsonElement parameters)
    {
        return parameters.TryGetProperty("executionContextId", out var context) &&
               context.ValueKind == JsonValueKind.Number && context.TryGetInt32(out var contextId)
            ? contextId
            : null;
    }

    private async Task<object> HandleRequestAsync(TransportTargetState state, TransportRequest request, int? ownerExecutionContextId)
    {
        if (request.Operation == "open") return await OpenConnectionAsync(state, request, ownerExecutionContextId).ConfigureAwait(false);

        TransportConnection? existing = null;
        TransportConnection? expired = null;
        long generation;
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            EnsureCurrentStateUnlocked(state, ownerExecutionContextId);
            if (!authorized.Contains(request.PluginId)) throw new InvalidOperationException("plugin is not authorized for the loopback WebSocket transport");
            if (!state.Connections.TryGetValue(request.ConnectionId!, out existing) || existing.PluginId != request.PluginId)
            {
                throw new InvalidOperationException("loopback WebSocket connection is unavailable");
            }

            if (existing.IsClosed && existing.ClosedAt is { } closedAt && closedAt <= DateTimeOffset.UtcNow - ClosedConnectionRetention)
            {
                if (state.Connections.TryRemove(existing.Id, out _))
                {
                    ReleaseOpenReservationUnlocked(state, existing);
                    expired = existing;
                }
            }

            generation = state.Generation;
        }
        finally
        {
            sync.Release();
        }

        if (expired is not null)
        {
            await SafeDisposeConnectionAsync(expired).ConfigureAwait(false);
            throw new InvalidOperationException("loopback WebSocket connection is unavailable");
        }

        if (existing is null) throw new InvalidOperationException("loopback WebSocket connection is unavailable");

        if (request.Operation == "send")
        {
            await existing.SendAsync(request.Data!).ConfigureAwait(false);
            await EnsureCurrentConnectionAsync(state, existing, generation).ConfigureAwait(false);
            return new { accepted = true };
        }

        if (request.Operation == "poll")
        {
            var result = await existing.PollAsync(request.WaitMilliseconds).ConfigureAwait(false);
            var remove = false;
            var current = false;
            await sync.WaitAsync().ConfigureAwait(false);
            try
            {
                current = IsCurrentConnectionUnlocked(state, existing, generation);
                if (current && result.Closed)
                {
                    remove = state.Connections.TryRemove(existing.Id, out _);
                    if (remove) ReleaseOpenReservationUnlocked(state, existing);
                }
            }
            finally
            {
                sync.Release();
            }

            if (remove) await SafeDisposeConnectionAsync(existing).ConfigureAwait(false);
            if (!current) throw new InvalidOperationException("loopback WebSocket connection is unavailable");
            return new { events = result.Events, closed = result.Closed };
        }

        existing.Close();
        var removed = false;
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            if (state.Connections.TryGetValue(existing.Id, out var current) && ReferenceEquals(current, existing))
            {
                removed = state.Connections.TryRemove(existing.Id, out _);
                if (removed) ReleaseOpenReservationUnlocked(state, existing);
            }
        }
        finally
        {
            sync.Release();
        }

        await SafeDisposeConnectionAsync(existing).ConfigureAwait(false);
        return new { closed = true };
    }

    private async Task<object> OpenConnectionAsync(TransportTargetState state, TransportRequest request, int? ownerExecutionContextId)
    {
        var endpoint = LoopbackTransportEndpoint.Validate(request.Endpoint!, forbiddenPorts);
        var retired = new List<TransportConnection>();
        TransportConnection? connection = null;
        var generation = 0L;
        var authGeneration = 0L;
        try
        {
            await sync.WaitAsync().ConfigureAwait(false);
            try
            {
                EnsureCurrentStateUnlocked(state, ownerExecutionContextId);
                if (!authorized.Contains(request.PluginId)) throw new InvalidOperationException("plugin is not authorized for the loopback WebSocket transport");
                retired = CollectClosedConnectionsUnlocked();
                var perTarget = state.Connections.Values.Count(item => !item.IsClosed) + state.Opening;
                var total = sessions.Values.Sum(item => item.Connections.Values.Count(connection => !connection.IsClosed) + item.Opening);
                if (perTarget >= MaxConnectionsPerTarget || total >= MaxConnectionsTotal)
                {
                    throw new InvalidOperationException("loopback WebSocket connection limit reached");
                }

                generation = state.Generation;
                authGeneration = authorizationGeneration;
                connection = new TransportConnection(request.PluginId, endpoint, ownerExecutionContextId, generation, QueueClosedConnectionSweep);
                state.Connections[connection.Id] = connection;
                state.Opening++;
            }
            finally
            {
                sync.Release();
            }
        }
        catch
        {
            await DisposeConnectionsAsync(retired).ConfigureAwait(false);
            throw;
        }

        await DisposeConnectionsAsync(retired).ConfigureAwait(false);
        if (connection is null) throw new InvalidOperationException("loopback WebSocket connection is unavailable");
        try
        {
            await connection.ConnectAsync().ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            await RemoveOpenConnectionAsync(state, connection).ConfigureAwait(false);
            throw new WebSocketException("loopback WebSocket connection failed", exception);
        }

        var accepted = false;
        var authorizationRevoked = false;
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            ReleaseOpenReservationUnlocked(state, connection);
            authorizationRevoked = authorizationGeneration != authGeneration || !authorized.Contains(request.PluginId);
            accepted = !closed && state.Active && state.Generation == generation &&
                authorizationGeneration == authGeneration &&
                sessions.TryGetValue(state.TargetId, out var current) && ReferenceEquals(current, state) &&
                authorized.Contains(request.PluginId) && !IsDestroyedContextUnlocked(state, ownerExecutionContextId) &&
                state.Connections.TryGetValue(connection.Id, out var existing) &&
                ReferenceEquals(existing, connection) && !connection.IsClosed;
            if (!accepted && state.Connections.TryGetValue(connection.Id, out var currentConnection) && ReferenceEquals(currentConnection, connection))
            {
                state.Connections.TryRemove(connection.Id, out _);
            }
        }
        finally
        {
            sync.Release();
        }

        if (!accepted)
        {
            await SafeDisposeConnectionAsync(connection).ConfigureAwait(false);
            throw new InvalidOperationException(authorizationRevoked
                ? "plugin is not authorized for the loopback WebSocket transport"
                : "loopback WebSocket connection is unavailable");
        }

        return new { connectionId = connection.Id };
    }

    private async Task RemoveOpenConnectionAsync(TransportTargetState state, TransportConnection connection)
    {
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            if (state.Connections.TryGetValue(connection.Id, out var current) && ReferenceEquals(current, connection))
            {
                state.Connections.TryRemove(connection.Id, out _);
                ReleaseOpenReservationUnlocked(state, connection);
            }
            else
            {
                ReleaseOpenReservationUnlocked(state, connection);
            }
        }
        finally
        {
            sync.Release();
        }

        await SafeDisposeConnectionAsync(connection).ConfigureAwait(false);
    }

    private async Task EnsureCurrentConnectionAsync(TransportTargetState state, TransportConnection connection, long generation)
    {
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!IsCurrentConnectionUnlocked(state, connection, generation)) throw new InvalidOperationException("loopback WebSocket connection is unavailable");
        }
        finally
        {
            sync.Release();
        }
    }

    private void EnsureCurrentStateUnlocked(TransportTargetState state, int? ownerExecutionContextId = null)
    {
        if (closed || !state.Active || !sessions.TryGetValue(state.TargetId, out var current) || !ReferenceEquals(current, state))
        {
            throw new InvalidOperationException("loopback WebSocket connection is unavailable");
        }

        if (IsDestroyedContextUnlocked(state, ownerExecutionContextId))
        {
            throw new InvalidOperationException("loopback WebSocket connection is unavailable");
        }
    }

    private bool IsCurrentConnectionUnlocked(TransportTargetState state, TransportConnection connection, long generation)
    {
        return !closed && state.Active && state.Generation == generation &&
            sessions.TryGetValue(state.TargetId, out var current) && ReferenceEquals(current, state) &&
            state.Connections.TryGetValue(connection.Id, out var existing) && ReferenceEquals(existing, connection) &&
            !connection.IsClosed && !IsDestroyedContextUnlocked(state, connection.OwnerExecutionContextId);
    }

    private static bool IsDestroyedContextUnlocked(TransportTargetState state, int? executionContextId) =>
        executionContextId is { } contextId && state.DestroyedContexts.ContainsKey(contextId);

    private static void ReleaseOpenReservationUnlocked(TransportTargetState state, TransportConnection connection)
    {
        if (connection.TryReleaseOpenReservation()) state.Opening = Math.Max(0, state.Opening - 1);
    }

    private static async Task SafeDisposeConnectionAsync(TransportConnection connection)
    {
        try { await connection.DisposeAsync().ConfigureAwait(false); } catch { }
    }

    private static async Task DisposeConnectionsAsync(IEnumerable<TransportConnection> connections)
    {
        foreach (var connection in connections) await SafeDisposeConnectionAsync(connection).ConfigureAwait(false);
    }

    private void QueueClosedConnectionSweep() => _ = SweepClosedConnectionsAsync();

    private List<TransportConnection> CollectClosedConnectionsUnlocked()
    {
        var cutoff = DateTimeOffset.UtcNow - ClosedConnectionRetention;
        var remove = new HashSet<TransportConnection>();
        foreach (var state in sessions.Values)
        {
            var closedConnections = state.Connections.Values
                .Where(connection => connection.IsClosed)
                .OrderBy(connection => connection.ClosedAt ?? DateTimeOffset.MinValue)
                .ToArray();
            foreach (var connection in closedConnections.Where(connection => connection.ClosedAt is { } closedAt && closedAt <= cutoff)) remove.Add(connection);
            foreach (var connection in closedConnections.Take(Math.Max(0, closedConnections.Length - MaxRetainedClosedConnectionsPerTarget))) remove.Add(connection);
        }

        var retained = sessions.Values.SelectMany(state => state.Connections.Values)
            .Where(connection => connection.IsClosed && !remove.Contains(connection))
            .OrderBy(connection => connection.ClosedAt ?? DateTimeOffset.MinValue)
            .ToArray();
        foreach (var connection in retained.Take(Math.Max(0, retained.Length - MaxRetainedClosedConnectionsTotal))) remove.Add(connection);

        var removed = new List<TransportConnection>();
        foreach (var state in sessions.Values)
        {
            foreach (var connection in remove)
            {
                if (state.Connections.TryRemove(connection.Id, out var removedConnection) && ReferenceEquals(removedConnection, connection))
                {
                    ReleaseOpenReservationUnlocked(state, connection);
                    removed.Add(connection);
                }
            }
        }

        return removed;
    }

    private async Task SweepClosedConnectionsAsync()
    {
        if (Interlocked.Exchange(ref closedSweepRunning, 1) != 0) return;
        try
        {
            List<TransportConnection> removed;
            await sync.WaitAsync().ConfigureAwait(false);
            try
            {
                removed = closed ? [] : CollectClosedConnectionsUnlocked();
            }
            finally
            {
                sync.Release();
            }

            await DisposeConnectionsAsync(removed).ConfigureAwait(false);
        }
        catch
        {
        }
        finally
        {
            Volatile.Write(ref closedSweepRunning, 0);
        }
    }

    private static TransportRequest ParseRequest(string payload)
    {
        if (Encoding.UTF8.GetByteCount(payload) > MaxRequestBytes) throw new InvalidDataException("transport request is too large");
        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !HasUniqueKeys(root) || !root.TryGetProperty("version", out var version) || RequiredInt32(version, "transport request version is invalid") != ProtocolVersion)
        {
            throw new InvalidDataException("transport request envelope is invalid");
        }

        var id = RequiredString(root, "id", RequestIdRegex, "transport request id is invalid");
        var pluginId = RequiredString(root, "pluginId", IdRegex, "transport request pluginId is invalid");
        var operation = RequiredString(root, "op", null, "transport request operation is invalid");
        if (operation is not ("open" or "send" or "poll" or "close")) throw new InvalidDataException("transport request operation is invalid");
        var allowed = operation switch
        {
            "open" => new[] { "version", "id", "op", "pluginId", "endpoint" },
            "send" => new[] { "version", "id", "op", "pluginId", "connectionId", "data" },
            "poll" => new[] { "version", "id", "op", "pluginId", "connectionId" },
            _ => new[] { "version", "id", "op", "pluginId", "connectionId" },
        };
        if (!HasExactKeys(root, allowed, operation == "poll" ? ["waitMs"] : [])) throw new InvalidDataException("transport request keys are not exact");

        if (operation == "open")
        {
            return new TransportRequest(id, pluginId, operation, RequiredString(root, "endpoint", null, "transport endpoint is invalid"), null, null, 0);
        }

        var connectionId = RequiredString(root, "connectionId", ConnectionIdRegex, "transport connectionId is invalid");
        if (operation == "send")
        {
            var data = RequiredString(root, "data", null, "transport data is invalid");
            if (Encoding.UTF8.GetByteCount(data) > MaxFrameBytes) throw new InvalidDataException("loopback WebSocket text frame is too large");
            return new TransportRequest(id, pluginId, operation, null, connectionId, data, 0);
        }

        var waitMs = operation == "poll" && root.TryGetProperty("waitMs", out var wait)
            ? RequiredInt32(wait, "transport poll timeout is invalid")
            : MaxPollMilliseconds;
        if (waitMs is < 0 or > MaxPollMilliseconds) throw new InvalidDataException("transport poll timeout is invalid");
        return new TransportRequest(id, pluginId, operation, null, connectionId, null, waitMs);
    }

    internal static void ValidateRequestForTests(string payload) => _ = ParseRequest(payload);

    private static int RequiredInt32(JsonElement value, string message)
    {
        if (value.ValueKind != JsonValueKind.Number) throw new InvalidDataException(message);
        try { return value.GetInt32(); }
        catch (FormatException) { throw new InvalidDataException(message); }
        catch (OverflowException) { throw new InvalidDataException(message); }
        catch (InvalidOperationException) { throw new InvalidDataException(message); }
    }

    private static string RequiredString(JsonElement root, string property, Regex? pattern, string message)
    {
        if (!root.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException(message);
        }

        var text = value.GetString()!;
        if (pattern is not null && !pattern.IsMatch(text)) throw new InvalidDataException(message);
        return text;
    }

    private static bool HasExactKeys(JsonElement root, IReadOnlyList<string> required, IReadOnlyList<string> optional)
    {
        var allowed = required.Concat(optional).ToHashSet(StringComparer.Ordinal);
        var properties = root.EnumerateObject().Select(property => property.Name).ToArray();
        return properties.Length == properties.Distinct(StringComparer.Ordinal).Count() &&
            required.All(properties.Contains) && properties.All(allowed.Contains);
    }

    private static bool HasUniqueKeys(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return false;
        var properties = root.EnumerateObject().Select(property => property.Name).ToArray();
        return properties.Length == properties.Distinct(StringComparer.Ordinal).Count();
    }

    private static (string Code, string Message) SanitizeError(Exception exception)
    {
        var code = exception switch
        {
            InvalidDataException data when data.Message.Contains("endpoint", StringComparison.OrdinalIgnoreCase) => "ENDPOINT_INVALID",
            InvalidDataException data when data.Message.Contains("frame", StringComparison.OrdinalIgnoreCase) => "FRAME_TOO_LARGE",
            InvalidDataException => "PROTOCOL_ERROR",
            FormatException or OverflowException or ArgumentException or KeyNotFoundException => "PROTOCOL_ERROR",
            InvalidOperationException operation when operation.Message.Contains("authorized", StringComparison.OrdinalIgnoreCase) => "PERMISSION_DENIED",
            InvalidOperationException operation when operation.Message.Contains("unavailable", StringComparison.OrdinalIgnoreCase) => "CONNECTION_NOT_FOUND",
            InvalidOperationException operation when operation.Message.Contains("connection is closed", StringComparison.OrdinalIgnoreCase) => "SOCKET_CLOSED",
            InvalidOperationException operation when operation.Message.Contains("dispatch limit", StringComparison.OrdinalIgnoreCase) => "DISPATCH_LIMIT",
            InvalidOperationException operation when operation.Message.Contains("poll is already pending", StringComparison.OrdinalIgnoreCase) => "POLL_BUSY",
            InvalidOperationException operation when operation.Message.Contains("queue limit", StringComparison.OrdinalIgnoreCase) => "QUEUE_LIMIT",
            InvalidOperationException operation when operation.Message.Contains("limit", StringComparison.OrdinalIgnoreCase) => "CONNECTION_LIMIT",
            WebSocketException => "SOCKET_ERROR",
            TimeoutException => "SOCKET_ERROR",
            IOException => "SOCKET_ERROR",
            _ => "TRANSPORT_ERROR",
        };
        var message = code switch
        {
            "ENDPOINT_INVALID" => "loopback WebSocket endpoint is invalid",
            "PERMISSION_DENIED" => "plugin is not authorized for the loopback WebSocket transport",
            "CONNECTION_NOT_FOUND" => "loopback WebSocket connection is unavailable",
            "CONNECTION_LIMIT" => "loopback WebSocket connection limit reached",
            "SOCKET_CLOSED" => "loopback WebSocket connection is closed",
            "QUEUE_LIMIT" => "loopback WebSocket queue limit reached",
            "POLL_BUSY" => "loopback WebSocket poll is already pending",
            "DISPATCH_LIMIT" => "loopback WebSocket renderer dispatch limit reached",
            "FRAME_TOO_LARGE" => "loopback WebSocket text frame is too large",
            "PROTOCOL_ERROR" => "loopback WebSocket transport protocol error",
            "SOCKET_ERROR" => "loopback WebSocket connection failed",
            _ => "loopback WebSocket transport failed",
        };
        return (code, message);
    }

    private string BuildClientSource() => $$"""
    ((bindingName, globalName, requestTimeoutMs, maxFrameBytes, maxPendingRequests) => {
      const binding = globalThis[bindingName];
      const previous = globalThis[globalName];
      try { previous?.dispose?.("Loader local transport reconnected"); } catch {}
      if (typeof binding !== "function") {
        globalThis[globalName] = Object.freeze({ connected: false, openWebSocket() { return Promise.reject(new Error("Loader local transport is not connected")); }, dispose() {} });
        return;
      }
      const pending = new Map(), cancelledOpenRequests = previous?.cancelledOpenRequests instanceof Map ? previous.cancelledOpenRequests : new Map(), sockets = new Set();
      const connectionIdPattern = /^[a-f0-9]{32}$/u;
      let nextId = 1, disposed = false;
      function fireAndForget(payload) { if (typeof binding !== "function") return; const id = `${Date.now().toString(36)}-${(nextId++).toString(36)}`; try { binding(JSON.stringify({ version: 1, id, ...payload })); } catch {} }
      function rememberCancelledOpen(id, item) { if (item?.payload?.op !== "open") return; while (cancelledOpenRequests.size >= maxPendingRequests) { const oldest = cancelledOpenRequests.keys().next().value; if (oldest === undefined) break; const removed = cancelledOpenRequests.get(oldest); clearTimeout(removed?.timer); cancelledOpenRequests.delete(oldest); } const timer = setTimeout(() => cancelledOpenRequests.delete(id), requestTimeoutMs); cancelledOpenRequests.set(id, { pluginId: item.payload.pluginId, timer }); }
      const request = payload => {
        if (disposed) return Promise.reject(new Error("Loader local transport is not connected"));
        if (pending.size >= maxPendingRequests) return Promise.reject(new Error("Loader local transport request limit reached"));
        const id = `${Date.now().toString(36)}-${(nextId++).toString(36)}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { const item = pending.get(id); pending.delete(id); rememberCancelledOpen(id, item); reject(new Error("Loader local transport request timed out")); }, requestTimeoutMs);
          pending.set(id, { resolve, reject, timer, payload });
          try { binding(JSON.stringify({ version: 1, id, ...payload })); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      };
      class LocalSocket {
        constructor(pluginId, endpoint) { this.pluginId = pluginId; this.endpoint = endpoint; this.readyState = 0; this.connectionId = null; this.listeners = new Map(); this.handlers = { open: null, error: null, message: null, close: null }; this.eventBuffer = []; this.eventBufferBytes = 0; this.polling = false; this.finished = false; this.closeRequested = false; for (const type of ["open", "error", "message", "close"]) Object.defineProperty(this, `on${type}`, { configurable: true, get: () => this.handlers[type], set: value => { this.handlers[type] = typeof value === "function" ? value : null; this.flush(type); } }); sockets.add(this); }
        addEventListener(type, listener) { if (typeof listener !== "function") return; const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); this.flush(type); }
        removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); }
        emit(type, event) { const list = this.listeners.get(type) || []; if (!this.handlers[type] && list.length === 0 && type !== "open") { this.bufferEvent(type, event); return; } this.dispatch(type, event); }
        eventSize(event) { return typeof event?.data === "string" ? new TextEncoder().encode(event.data).byteLength : 128; }
        bufferEvent(type, event) { const bytes = this.eventSize(event); if (bytes > 262144) return; while (this.eventBuffer.length >= 32 || this.eventBufferBytes + bytes > 262144) { const removed = this.eventBuffer.shift(); if (!removed) break; this.eventBufferBytes -= this.eventSize(removed.event); } this.eventBuffer.push({ type, event }); this.eventBufferBytes += bytes; }
        dispatch(type, event) { try { this.handlers[type]?.(event); } catch {} for (const listener of this.listeners.get(type) || []) { try { listener(event); } catch {} } }
        flush(type) { if (!this.handlers[type] && (this.listeners.get(type) || []).length === 0) return; const pendingEvents = this.eventBuffer.filter(item => item.type === type); this.eventBuffer = this.eventBuffer.filter(item => item.type !== type); this.eventBufferBytes = this.eventBuffer.reduce((total, item) => total + this.eventSize(item.event), 0); for (const item of pendingEvents) this.dispatch(item.type, item.event); }
        open() { return request({ op: "open", pluginId: this.pluginId, endpoint: this.endpoint }).then(result => { if (!result || typeof result.connectionId !== "string" || !connectionIdPattern.test(result.connectionId)) throw new Error("Loader local transport returned an invalid connection"); if (this.finished || disposed) { fireAndForget({ op: "close", pluginId: this.pluginId, connectionId: result.connectionId }); throw new Error("Loader local transport owner was disposed"); } this.connectionId = result.connectionId; this.readyState = 1; this.emit("open", {}); this.poll(); return this; }).catch(error => { this.fail(error); throw error; }); }
        send(data) { if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > maxFrameBytes) throw new Error("Loader local transport text frame is too large"); if (this.readyState !== 1 || !this.connectionId) throw new Error("Loader local transport socket is not open"); void request({ op: "send", pluginId: this.pluginId, connectionId: this.connectionId, data }).catch(error => this.fail(error)); }
        poll() { if (this.polling || this.finished || !this.connectionId || this.readyState !== 1) return; this.polling = true; void request({ op: "poll", pluginId: this.pluginId, connectionId: this.connectionId, waitMs: 1000 }).then(result => { this.polling = false; for (const event of Array.isArray(result?.events) ? result.events : []) { if (event?.type === "message" && typeof event.data === "string") this.emit("message", { data: event.data }); if (event?.type === "close") this.finish(Number.isInteger(event.code) ? event.code : 1000); } if (!result?.closed && !this.finished) this.poll(); }).catch(error => { this.polling = false; if (!this.finished) this.fail(error); }); }
        close() { if (this.finished) return; if (!this.connectionId) { this.finish(1000); return; } if (this.closeRequested) return; this.closeRequested = true; this.readyState = 2; if (disposed || pending.size >= maxPendingRequests) { fireAndForget({ op: "close", pluginId: this.pluginId, connectionId: this.connectionId }); this.finish(1000); return; } void request({ op: "close", pluginId: this.pluginId, connectionId: this.connectionId }).catch(() => {}).finally(() => this.finish(1000)); }
        fail(error) { if (this.finished) return; this.emit("error", error); this.close(); }
        finish(code) { if (this.finished) return; this.finished = true; this.readyState = 3; sockets.delete(this); this.emit("close", { code, wasClean: code === 1000 }); }
        dispose() { if (!this.finished && this.connectionId && !this.closeRequested) { this.closeRequested = true; fireAndForget({ op: "close", pluginId: this.pluginId, connectionId: this.connectionId }); } if (!this.finished) this.finish(1000); this.listeners.clear(); this.handlers = { open: null, error: null, message: null, close: null }; this.eventBuffer = []; this.eventBufferBytes = 0; }
      }
      globalThis[globalName] = { connected: true, cancelledOpenRequests, openWebSocket(pluginId, endpoint) { if (typeof pluginId !== "string" || typeof endpoint !== "string") return Promise.reject(new Error("Loader local transport arguments are invalid")); return new LocalSocket(pluginId, endpoint).open(); }, receive(message) { if (!message || typeof message.id !== "string") return; const item = pending.get(message.id); if (!item) { const cancelled = cancelledOpenRequests.get(message.id); if (!cancelled) return; clearTimeout(cancelled.timer); cancelledOpenRequests.delete(message.id); const connectionId = message.ok && typeof message.result?.connectionId === "string" && connectionIdPattern.test(message.result.connectionId) ? message.result.connectionId : null; if (connectionId) fireAndForget({ op: "close", pluginId: cancelled.pluginId, connectionId }); return; } pending.delete(message.id); clearTimeout(item.timer); if (message.ok) item.resolve(message.result); else item.reject(new Error(String(message.message || "Loader local transport request failed"))); }, dispose(reason = "Loader local transport disconnected") { if (disposed) return; disposed = true; for (const [id, item] of pending) { clearTimeout(item.timer); rememberCancelledOpen(id, item); item.reject(new Error(reason)); } pending.clear(); for (const socket of sockets) socket.dispose(); sockets.clear(); } };
      })({{JsonSerializer.Serialize(bindingName)}}, {{JsonSerializer.Serialize(TransportGlobal)}}, {{RequestTimeoutMilliseconds}}, {{MaxFrameBytes}}, {{MaxPendingRendererRequests}});
    """;

    internal string BuildClientSourceForTests() => BuildClientSource();

    internal long AuthorizationGenerationForTests => Volatile.Read(ref authorizationGeneration);

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        TransportTargetState[] states;
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            closed = true;
            states = sessions.Values.ToArray();
            sessions.Clear();
            authorized.Clear();
            foreach (var state in states)
            {
                state.Active = false;
                state.Generation++;
            }
        }
        finally
        {
            sync.Release();
        }

        closedConnectionSweep.Dispose();
        foreach (var state in states)
        {
            try { await DetachBindingUnlockedAsync(state.TargetId, state, CancellationToken.None).ConfigureAwait(false); }
            catch { }
        }

        sync.Dispose();
        dispatchSlots.Dispose();
        dispatchRejectionSlots.Dispose();
    }

    private sealed class TransportTargetState(string targetId, string endpoint, CdpSession session)
    {
        public string TargetId { get; } = targetId;
        public string Endpoint { get; } = endpoint;
        public CdpSession Session { get; } = session;
        public string? RegistrationId { get; set; }
        public Action? Unsubscribe { get; set; }
        public bool Active { get; set; } = true;
        public long Generation;
        public int Opening { get; set; }
        public ConcurrentDictionary<int, byte> DestroyedContexts { get; } = new();
        public ConcurrentDictionary<string, TransportConnection> Connections { get; } = new(StringComparer.Ordinal);
    }

    private sealed record TransportRequest(string Id, string PluginId, string Operation, string? Endpoint, string? ConnectionId, string? Data, int WaitMilliseconds);

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    [GeneratedRegex("^[a-z0-9][a-z0-9._-]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex IdPattern();

    [GeneratedRegex("^[A-Za-z0-9._:-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex RequestIdPattern();

    [GeneratedRegex("^[a-f0-9]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ConnectionIdPattern();
}

internal sealed class TransportConnection : IAsyncDisposable
{
    private const int MaxFrameBytes = 64 * 1024;
    private const int MaxQueueBytes = 256 * 1024;
    private const int MaxQueueMessages = 32;
    private const int MaxPollMilliseconds = 1000;
    private readonly ClientWebSocket socket = new();
    private readonly Uri endpoint;
    private readonly ConcurrentQueue<TransportEvent> queue = new();
    // This is an edge-triggered "queue became non-empty" notification, not a
    // per-message counter. Drain() clears the signal once it empties the queue.
    private readonly SemaphoreSlim queueSignal = new(0, 1);
    private readonly SemaphoreSlim sendGate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly object queueLock = new();
    private readonly object lifecycleLock = new();
    private readonly TaskCompletionSource<bool> sendsCompleted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Action? onClosed;
    private int queueBytes;
    private int pendingSends;
    private int pollInFlight;
    private int closed;
    private int disposed;
    private int openReservation = 1;
    private int closeCode = 1000;
    private Task? receiveTask;

    public TransportConnection(string pluginId, Uri endpoint, int? ownerExecutionContextId = null, long ownerGeneration = 0, Action? onClosed = null)
    {
        PluginId = pluginId;
        this.endpoint = endpoint;
        OwnerExecutionContextId = ownerExecutionContextId;
        OwnerGeneration = ownerGeneration;
        this.onClosed = onClosed;
        socket.Options.Proxy = null;
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
    }

    public string Id { get; } = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
    public string PluginId { get; }
    public int? OwnerExecutionContextId { get; }
    public long OwnerGeneration { get; }
    public bool IsClosed => Volatile.Read(ref closed) != 0;
    public DateTimeOffset? ClosedAt { get; private set; }
    public bool IsDisposed => Volatile.Read(ref disposed) != 0;

    internal int QueuedEventCountForTests
    {
        get
        {
            lock (queueLock) return queue.Count;
        }
    }

    public bool TryReleaseOpenReservation() => Interlocked.Exchange(ref openReservation, 0) != 0;

    public async Task ConnectAsync()
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(5000));
        await socket.ConnectAsync(endpoint, timeout.Token).ConfigureAwait(false);
        lock (lifecycleLock)
        {
            if (IsDisposed || IsClosed) throw new WebSocketException("loopback WebSocket connection was closed before it became ready");
            receiveTask = ReceiveLoopAsync();
        }
    }

    public async Task SendAsync(string data)
    {
        if (Encoding.UTF8.GetByteCount(data) > MaxFrameBytes) throw new InvalidDataException("loopback WebSocket text frame is too large");
        lock (lifecycleLock)
        {
            if (IsDisposed || IsClosed) throw new InvalidOperationException("loopback WebSocket connection is closed");
            if (Interlocked.Increment(ref pendingSends) > MaxQueueMessages)
            {
                Interlocked.Decrement(ref pendingSends);
                throw new InvalidOperationException("loopback WebSocket queue limit reached");
            }
        }

        try
        {
            await sendGate.WaitAsync(lifetime.Token).ConfigureAwait(false);
            try
            {
                if (IsClosed || socket.State != WebSocketState.Open) throw new InvalidOperationException("loopback WebSocket connection is closed");
                await socket.SendAsync(Encoding.UTF8.GetBytes(data), WebSocketMessageType.Text, true, lifetime.Token).ConfigureAwait(false);
            }
            finally
            {
                try { sendGate.Release(); } catch (ObjectDisposedException) { }
            }
        }
        catch (OperationCanceledException exception) when (lifetime.IsCancellationRequested)
        {
            throw new WebSocketException("loopback WebSocket send failed", exception);
        }
        catch (ObjectDisposedException exception)
        {
            MarkClosed(1011);
            throw new WebSocketException("loopback WebSocket send failed", exception);
        }
        catch (WebSocketException)
        {
            MarkClosed(1011);
            throw;
        }
        catch (IOException exception)
        {
            MarkClosed(1011);
            throw new WebSocketException("loopback WebSocket send failed", exception);
        }
        finally
        {
            if (Interlocked.Decrement(ref pendingSends) == 0 && IsDisposed) sendsCompleted.TrySetResult(true);
        }
    }

    public async Task<TransportPollResult> PollAsync(int waitMilliseconds)
    {
        if (Interlocked.Exchange(ref pollInFlight, 1) != 0) throw new InvalidOperationException("loopback WebSocket poll is already pending");
        try
        {
            return await PollCoreAsync(waitMilliseconds).ConfigureAwait(false);
        }
        finally
        {
            Volatile.Write(ref pollInFlight, 0);
        }
    }

    private async Task<TransportPollResult> PollCoreAsync(int waitMilliseconds)
    {
        var result = Drain();
        if (result.Events.Count > 0 || result.Closed || waitMilliseconds == 0) return result;
        try { await queueSignal.WaitAsync(Math.Min(waitMilliseconds, MaxPollMilliseconds), lifetime.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (IsClosed) { }
        catch (ObjectDisposedException) { }
        return Drain();
    }

    public void Close() => MarkClosed(1000);

    private async Task ReceiveLoopAsync()
    {
        try
        {
            while (!lifetime.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                using var message = new MemoryStream();
                var buffer = new byte[16 * 1024];
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, lifetime.Token).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        MarkClosed(result.CloseStatus.HasValue ? (int)result.CloseStatus.Value : 1000);
                        return;
                    }

                    if (result.MessageType != WebSocketMessageType.Text || message.Length + result.Count > MaxFrameBytes)
                    {
                        MarkClosed(1009);
                        return;
                    }

                    await message.WriteAsync(buffer.AsMemory(0, result.Count), lifetime.Token).ConfigureAwait(false);
                }
                while (!result.EndOfMessage);

                var text = Encoding.UTF8.GetString(message.ToArray());
                var queueOverflowed = false;
                lock (queueLock)
                {
                    if (queue.Count >= MaxQueueMessages || queueBytes + message.Length > MaxQueueBytes)
                    {
                        queueOverflowed = true;
                    }
                    else
                    {
                        queue.Enqueue(new TransportEvent("message", text, 0));
                        queueBytes += (int)message.Length;
                        SignalQueueNonEmptyUnlocked();
                    }
                }
                if (queueOverflowed) { MarkClosed(1013); return; }
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
        {
        }
        catch (WebSocketException)
        {
            MarkClosed(1011);
        }
        catch (IOException)
        {
            MarkClosed(1011);
        }
        catch (ObjectDisposedException)
        {
            MarkClosed(1011);
        }
    }

    private void SignalQueueNonEmptyUnlocked()
    {
        try
        {
            if (queueSignal.CurrentCount == 0) queueSignal.Release();
        }
        catch (SemaphoreFullException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private void ClearQueueSignalIfEmptyUnlocked()
    {
        if (!queue.IsEmpty) return;
        try
        {
            while (queueSignal.Wait(0)) { }
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private TransportPollResult Drain()
    {
        var events = new List<TransportEvent>(MaxQueueMessages);
        var responseBytes = 0;
        lock (queueLock)
        {
            while (events.Count < MaxQueueMessages && queue.TryPeek(out var item))
            {
                var itemBytes = Encoding.UTF8.GetByteCount(item.Data ?? string.Empty) + 128;
                if (events.Count > 0 && responseBytes + itemBytes > 128 * 1024 - 1024) break;
                if (!queue.TryDequeue(out var dequeued) || dequeued is null) break;
                events.Add(dequeued);
                responseBytes += itemBytes;
            }
            queueBytes = queue.Sum(item => Encoding.UTF8.GetByteCount(item.Data ?? string.Empty));
            ClearQueueSignalIfEmptyUnlocked();
            var queueEmpty = queue.IsEmpty;
            return new TransportPollResult(events, IsClosed && queueEmpty);
        }
    }

    private void MarkClosed(int code)
    {
        if (Interlocked.Exchange(ref closed, 1) != 0) return;
        closeCode = code is >= 1000 and <= 4999 ? code : 1000;
        ClosedAt = DateTimeOffset.UtcNow;
        lifetime.Cancel();
        lock (queueLock)
        {
            while (queue.Count >= MaxQueueMessages && queue.TryDequeue(out var removed))
            {
                queueBytes -= Encoding.UTF8.GetByteCount(removed?.Data ?? string.Empty);
            }
            queue.Enqueue(new TransportEvent("close", null, closeCode));
            SignalQueueNonEmptyUnlocked();
        }
        try { socket.Abort(); } catch (ObjectDisposedException) { }
        try { onClosed?.Invoke(); } catch { }
    }

    public async ValueTask DisposeAsync()
    {
        lock (lifecycleLock)
        {
            if (disposed != 0) return;
            disposed = 1;
        }

        MarkClosed(1000);
        if (Volatile.Read(ref pendingSends) != 0)
        {
            try { await sendsCompleted.Task.ConfigureAwait(false); } catch { }
        }
        if (receiveTask is not null)
        {
            try { await receiveTask.ConfigureAwait(false); } catch { }
        }
        try { socket.Dispose(); } catch { }
        try { queueSignal.Dispose(); } catch { }
        try { sendGate.Dispose(); } catch { }
        try { lifetime.Dispose(); } catch { }
    }

    public sealed record TransportEvent(string Type, string? Data, int Code);
    public sealed record TransportPollResult(IReadOnlyList<TransportEvent> Events, bool Closed);
}
