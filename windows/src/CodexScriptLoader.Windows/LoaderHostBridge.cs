using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CodexScriptLoader.Windows;

internal sealed class LoaderHostBridge : IAsyncDisposable
{
    private const string BridgeGlobal = "__codexScriptLoaderHostBridge";
    private static readonly JsonSerializerOptions BridgeJsonOptions = CreateBridgeJsonOptions();
    private readonly CdpClient client;
    private readonly Func<string, JsonElement, CancellationToken, Task<object>> dispatch;
    private readonly LoopbackTransportHost? transportHost;
    private readonly string bindingName = $"__codex_loader_{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12))}";
    private readonly Dictionary<string, BridgeSession> sessions = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim sync = new(1, 1);

    public LoaderHostBridge(CdpClient client, Func<string, JsonElement, CancellationToken, Task<object>> dispatch, LoopbackTransportHost? transportHost = null)
    {
        this.client = client;
        this.dispatch = dispatch;
        this.transportHost = transportHost;
    }

    public async Task SyncAsync(IReadOnlyList<CdpTarget> targets, CancellationToken cancellationToken)
    {
        await sync.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var desired = targets.ToDictionary(target => target.Id, StringComparer.Ordinal);
            foreach (var targetId in sessions.Keys.Where(targetId => !desired.ContainsKey(targetId)).ToArray())
            {
                await DropAsync(targetId, cancellationToken).ConfigureAwait(false);
            }

            foreach (var target in targets)
            {
                if (!sessions.ContainsKey(target.Id))
                {
                    await AttachAsync(target, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            sync.Release();
        }
    }

    public async Task ReconnectAsync(IReadOnlyList<CdpTarget> targets, CancellationToken cancellationToken)
    {
        await sync.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            foreach (var targetId in sessions.Keys.ToArray())
            {
                await DropAsync(targetId, cancellationToken).ConfigureAwait(false);
            }

            foreach (var target in targets)
            {
                await AttachAsync(target, cancellationToken).ConfigureAwait(false);
            }
        }
        finally
        {
            sync.Release();
        }
    }

    private async Task AttachAsync(CdpTarget target, CancellationToken cancellationToken)
    {
        if (!client.IsManagedEndpoint(target.WebSocketDebuggerUrl))
        {
            throw new InvalidOperationException("Bridge target endpoint is outside the managed port.");
        }

        var session = await CdpSession.ConnectAsync(new Uri(target.WebSocketDebuggerUrl), cancellationToken).ConfigureAwait(false);
        string? registrationId = null;
        try
        {
            await session.SendAsync("Runtime.enable", cancellationToken: cancellationToken).ConfigureAwait(false);
            await session.SendAsync("Page.enable", cancellationToken: cancellationToken).ConfigureAwait(false);
            await session.SendAsync("Runtime.addBinding", new { name = bindingName }, cancellationToken).ConfigureAwait(false);
            var source = BuildClientSource();
            var registration = await session.SendAsync("Page.addScriptToEvaluateOnNewDocument", new { source }, cancellationToken).ConfigureAwait(false);
            registrationId = registration.TryGetProperty("identifier", out var identifier) ? identifier.GetString() : null;
            session.EventReceived += message => HandleEvent(target.Id, message);
            sessions[target.Id] = new BridgeSession(session, registrationId);
            if (transportHost is not null)
            {
                await transportHost.AttachToSessionAsync(target, session, cancellationToken).ConfigureAwait(false);
            }
            var evaluation = await session.SendAsync("Runtime.evaluate", new { expression = source, returnByValue = true }, cancellationToken).ConfigureAwait(false);
            if (evaluation.TryGetProperty("exceptionDetails", out _))
            {
                throw new InvalidOperationException("Renderer rejected the Loader bridge client.");
            }
        }
        catch
        {
            if (transportHost is not null)
            {
                try { await transportHost.DetachSessionAsync(target.Id, cancellationToken).ConfigureAwait(false); } catch { }
            }
            sessions.Remove(target.Id);
            if (!string.IsNullOrWhiteSpace(registrationId))
            {
                try
                {
                    await session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", new { identifier = registrationId }, cancellationToken).ConfigureAwait(false);
                }
                catch (InvalidOperationException)
                {
                }
            }

            await session.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private void HandleEvent(string targetId, JsonElement message)
    {
        if (!message.TryGetProperty("method", out var method) || method.GetString() != "Runtime.bindingCalled" ||
            !message.TryGetProperty("params", out var parameters) ||
            !parameters.TryGetProperty("name", out var name) || name.GetString() != bindingName)
        {
            return;
        }

        _ = Task.Run(() => DispatchBindingAsync(targetId, parameters));
    }

    private async Task DispatchBindingAsync(string targetId, JsonElement parameters)
    {
        string? requestId = null;
        object response;
        try
        {
            var payload = parameters.GetProperty("payload").GetString() ?? throw new InvalidDataException("Bridge payload is empty.");
            if (System.Text.Encoding.UTF8.GetByteCount(payload) > 16 * 1024)
            {
                throw new InvalidDataException("Bridge payload is too large.");
            }

            using var request = JsonDocument.Parse(payload);
            var root = request.RootElement;
            if (root.GetProperty("version").GetInt32() != 1)
            {
                throw new InvalidDataException("Bridge protocol version is invalid.");
            }

            requestId = root.GetProperty("id").GetString();
            if (string.IsNullOrWhiteSpace(requestId) || requestId.Length > 128)
            {
                throw new InvalidDataException("Bridge request id is invalid.");
            }

            var command = root.GetProperty("command").GetString();
            if (command is not (
                "get_app_status" or
                "list_plugins" or
                "set_plugin_enabled" or
                "reload_scripts" or
                "reload_plugins" or
                "pick_plugin_folder" or
                "pick_plugin_archive" or
                "preview_plugin_github" or
                "install_plugin" or
                "cancel_plugin_install" or
                "remove_plugin" or
                "list_quarantined" or
                "restore_plugin" or
                "restart_codex" or
                "get_update_status" or
                "set_auto_update" or
                "check_for_updates" or
                "start_update" or
                "cancel_update" or
                "check_plugin_updates" or
                "page_companion_probe" or
                "page_companion_bind" or
                "page_companion_invoke" or
                "page_companion_unbind" or
                "set_plugin_auto_update" or
                "start_plugin_update" or
                "confirm_plugin_update" or
                "cancel_plugin_update"))
            {
                throw new InvalidDataException("Bridge command is not allowed.");
            }

            var payloadElement = root.TryGetProperty("payload", out var commandPayload) ? commandPayload : default;
            if (payloadElement.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
            {
                payloadElement = JsonSerializer.SerializeToElement(new { });
            }
            else if (payloadElement.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidDataException("Bridge command payload must be an object.");
            }

            var result = await dispatch(command!, payloadElement.Clone(), CancellationToken.None).ConfigureAwait(false);
            response = new { id = requestId, ok = true, result };
        }
        catch (Exception exception) when (exception is InvalidDataException or JsonException or InvalidOperationException or IOException or UnauthorizedAccessException or ArgumentException or KeyNotFoundException or HttpRequestException or OperationCanceledException)
        {
            if (requestId is null)
            {
                return;
            }

            response = new { id = requestId, ok = false, error = exception is OperationCanceledException
                ? "Loader operation timed out or was cancelled. No automatic retry was performed."
                : CodexScriptLoader.Core.JsonlLogger.Redact(exception.Message) };
        }

        if (!sessions.TryGetValue(targetId, out var state))
        {
            return;
        }

        var expression = $"globalThis[{JsonSerializer.Serialize(BridgeGlobal)}]?.receive({JsonSerializer.Serialize(response, BridgeJsonOptions)});";
        var contextId = parameters.TryGetProperty("executionContextId", out var context) ? context.GetInt32() : (int?)null;
        try
        {
            await state.Session.SendAsync("Runtime.evaluate", contextId.HasValue
                ? new { expression, contextId = contextId.Value, returnByValue = true }
                : new { expression, returnByValue = true }, CancellationToken.None).ConfigureAwait(false);
        }
        catch (InvalidOperationException)
        {
        }
    }

    private async Task DropAsync(string targetId, CancellationToken cancellationToken)
    {
        if (!sessions.Remove(targetId, out var state))
        {
            return;
        }

        if (transportHost is not null)
        {
            try { await transportHost.DetachSessionAsync(targetId, cancellationToken).ConfigureAwait(false); } catch { }
        }

        try
        {
            await state.Session.SendAsync("Runtime.evaluate", new
            {
                expression = $"globalThis[{JsonSerializer.Serialize(BridgeGlobal)}]?.bindingName === {JsonSerializer.Serialize(bindingName)} && globalThis[{JsonSerializer.Serialize(BridgeGlobal)}].dispose('Loader sidecar disconnected');",
            }, cancellationToken).ConfigureAwait(false);
        }
        catch (InvalidOperationException)
        {
        }

        if (!string.IsNullOrWhiteSpace(state.RegistrationId))
        {
            try
            {
                await state.Session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", new { identifier = state.RegistrationId }, cancellationToken).ConfigureAwait(false);
            }
            catch (InvalidOperationException)
            {
            }
        }

        try
        {
            await state.Session.SendAsync("Runtime.removeBinding", new { name = bindingName }, cancellationToken).ConfigureAwait(false);
        }
        catch (InvalidOperationException)
        {
        }

        await state.Session.DisposeAsync().ConfigureAwait(false);
    }

    private string BuildClientSource() => $$"""
    ((bindingName, globalName, requestTimeoutMs, mutationTimeoutMs, pickerTimeoutMs) => {
      const binding = globalThis[bindingName];
      const previous = globalThis[globalName];
      try { previous?.dispose?.("Loader bridge reconnected"); } catch {}
      if (typeof binding !== "function") {
        globalThis[globalName] = Object.freeze({ connected: false, request() { return Promise.reject(new Error("Loader sidecar is not connected")); }, dispose() {} });
        return;
      }
      const pending = new Map();
      let nextId = 1;
      let disposed = false;
      globalThis[globalName] = {
        bindingName,
        connected: true,
        request(command, payload = {}) {
          if (disposed) return Promise.reject(new Error("Loader sidecar is not connected"));
          const id = `${Date.now().toString(36)}-${(nextId++).toString(36)}`;
          return new Promise((resolve, reject) => {
            const timeoutMs = command === "pick_plugin_folder" || command === "pick_plugin_archive" || command === "page_companion_invoke"
              ? pickerTimeoutMs
              : command === "preview_plugin_github" ? 150000
              : command === "get_app_status" || command === "list_plugins" || command === "list_quarantined" || command === "get_update_status"
                ? requestTimeoutMs
                : mutationTimeoutMs;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error("Loader request timed out")); }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            try { binding(JSON.stringify({ version: 1, id, command, payload })); }
            catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
          });
        },
        receive(message) {
          if (!message || typeof message.id !== "string") return;
          const item = pending.get(message.id);
          if (!item) return;
          pending.delete(message.id);
          clearTimeout(item.timer);
          if (message.ok) item.resolve(message.result); else item.reject(new Error(String(message.error || "Loader request failed")));
        },
        dispose(reason = "Loader sidecar disconnected") {
          if (disposed) return;
          disposed = true;
          for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(reason)); }
          pending.clear();
        }
      };
    })({{JsonSerializer.Serialize(bindingName)}}, {{JsonSerializer.Serialize(BridgeGlobal)}}, 8000, 30000, 300000);
    """;

    public async ValueTask DisposeAsync()
    {
        await sync.WaitAsync().ConfigureAwait(false);
        try
        {
            foreach (var targetId in sessions.Keys.ToArray())
            {
                await DropAsync(targetId, CancellationToken.None).ConfigureAwait(false);
            }
        }
        finally
        {
            sync.Release();
            sync.Dispose();
        }
    }

    private sealed record BridgeSession(CdpSession Session, string? RegistrationId);

    private static JsonSerializerOptions CreateBridgeJsonOptions()
    {
        var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return options;
    }
}
