using System.Text;
using System.Text.Json;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed class PageCompanionHost : IAsyncDisposable
{
    private const int MaxPayloadBytes = 64 * 1024;
    private const int MaxResultBytes = 1024 * 1024;
    private const string RuntimeGlobal = "__codexScriptLoaderPageCompanions";
    private readonly CdpClient client;
    private readonly Dictionary<string, ScriptDescriptor> authorized = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Binding> bindings = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim gate = new(1, 1);

    public PageCompanionHost(CdpClient client) => this.client = client;

    public async Task SetAuthorizedPluginsAsync(IReadOnlyList<ScriptDescriptor> descriptors, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var desired = descriptors.Where(item => item.PageCompanion is not null && item.Permissions.Contains("browser-page-companion", StringComparer.Ordinal))
                .ToDictionary(item => item.Id, StringComparer.Ordinal);
            foreach (var pluginId in bindings.Keys.ToArray())
            {
                if (!desired.TryGetValue(pluginId, out var descriptor) || descriptor.PageCompanion?.Fingerprint != bindings[pluginId].Fingerprint)
                {
                    await DropUnlockedAsync(pluginId, cancellationToken).ConfigureAwait(false);
                }
            }
            authorized.Clear();
            foreach (var pair in desired) authorized[pair.Key] = pair.Value;
        }
        finally { gate.Release(); }
    }

    public async Task<object> ProbeAsync(string pluginId, CancellationToken cancellationToken)
    {
        var descriptor = RequireDescriptor(pluginId);
        var companion = descriptor.PageCompanion!;
        var targets = await client.GetPageTargetsAsync(companion.Origin, cancellationToken).ConfigureAwait(false);
        return new { available = targets.Count == 1, candidateCount = targets.Count, bound = bindings.ContainsKey(pluginId), origin = companion.Origin };
    }

    public async Task<object> BindAsync(string pluginId, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var descriptor = RequireDescriptor(pluginId);
            var companion = descriptor.PageCompanion!;
            if (bindings.TryGetValue(pluginId, out var existing) && await IsCurrentUnlockedAsync(existing, companion, cancellationToken).ConfigureAwait(false))
            {
                return new { bound = true, targetIdentity = existing.TargetId, origin = companion.Origin };
            }
            if (existing is not null) await DropUnlockedAsync(pluginId, cancellationToken).ConfigureAwait(false);
            var targets = await client.GetPageTargetsAsync(companion.Origin, cancellationToken).ConfigureAwait(false);
            if (targets.Count == 0) throw new InvalidOperationException("PAGE_COMPANION_TARGET_NOT_FOUND");
            if (targets.Count != 1) throw new InvalidOperationException("PAGE_COMPANION_TARGET_AMBIGUOUS");
            var target = targets[0];
            var session = await CdpSession.ConnectAsync(new Uri(target.WebSocketDebuggerUrl), cancellationToken).ConfigureAwait(false);
            string? registrationId = null;
            try
            {
                await session.SendAsync("Runtime.enable", cancellationToken: cancellationToken).ConfigureAwait(false);
                await session.SendAsync("Page.enable", cancellationToken: cancellationToken).ConfigureAwait(false);
                var source = BuildInstallSource(pluginId, companion);
                var registration = await session.SendAsync("Page.addScriptToEvaluateOnNewDocument", new { source }, cancellationToken).ConfigureAwait(false);
                registrationId = registration.TryGetProperty("identifier", out var identifier) ? identifier.GetString() : null;
                var binding = new Binding(pluginId, target.Id, target.WebSocketDebuggerUrl, companion.Origin, companion.Fingerprint, session, registrationId);
                session.EventReceived += message => HandleTargetEvent(binding, message);
                bindings[pluginId] = binding;
                var evaluation = await session.SendAsync("Runtime.evaluate", new { expression = source, awaitPromise = true, returnByValue = true }, cancellationToken).ConfigureAwait(false);
                if (evaluation.TryGetProperty("exceptionDetails", out _)) throw new InvalidOperationException("Page companion bundle failed to start.");
                return new { bound = true, targetIdentity = target.Id, origin = companion.Origin };
            }
            catch
            {
                bindings.Remove(pluginId);
                if (!string.IsNullOrWhiteSpace(registrationId))
                {
                    try { await session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", new { identifier = registrationId }, cancellationToken).ConfigureAwait(false); } catch { }
                }
                await session.DisposeAsync().ConfigureAwait(false);
                throw;
            }
        }
        finally { gate.Release(); }
    }

    public async Task<object> InvokeAsync(string pluginId, string operation, JsonElement payload, CancellationToken cancellationToken)
    {
        if (Encoding.UTF8.GetByteCount(payload.GetRawText()) > MaxPayloadBytes) throw new InvalidDataException("Page companion payload is too large.");
        var descriptor = RequireDescriptor(pluginId);
        var companion = descriptor.PageCompanion!;
        if (!companion.Operations.Contains(operation, StringComparer.Ordinal)) throw new InvalidDataException("Page companion operation is not allowed.");
        Binding binding;
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!bindings.TryGetValue(pluginId, out binding!) || !await IsCurrentUnlockedAsync(binding, companion, cancellationToken).ConfigureAwait(false))
            {
                if (binding is not null) await DropUnlockedAsync(pluginId, cancellationToken).ConfigureAwait(false);
                throw new InvalidOperationException("PAGE_COMPANION_BINDING_UNAVAILABLE");
            }
        }
        finally { gate.Release(); }

        var expression = $"globalThis[{JsonSerializer.Serialize(RuntimeGlobal)}]?.plugins?.[{JsonSerializer.Serialize(pluginId)}]?.invoke({JsonSerializer.Serialize(operation)}, {payload.GetRawText()})";
        var evaluation = await binding.Session.SendAsync("Runtime.evaluate", new { expression, awaitPromise = true, returnByValue = true }, cancellationToken).ConfigureAwait(false);
        if (evaluation.TryGetProperty("exceptionDetails", out _)) throw new InvalidOperationException("Page companion operation failed.");
        if (!evaluation.TryGetProperty("result", out var result) || !result.TryGetProperty("value", out var value)) throw new InvalidDataException("Page companion returned no serializable result.");
        var clone = value.Clone();
        if (Encoding.UTF8.GetByteCount(clone.GetRawText()) > MaxResultBytes) throw new InvalidDataException("Page companion result is too large.");
        return clone;
    }

    public async Task<object> UnbindAsync(string pluginId, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RequireDescriptor(pluginId);
            var removed = bindings.ContainsKey(pluginId);
            if (removed) await DropUnlockedAsync(pluginId, cancellationToken).ConfigureAwait(false);
            return new { unbound = true, wasBound = removed };
        }
        finally { gate.Release(); }
    }

    public async Task SyncAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            foreach (var pluginId in bindings.Keys.ToArray())
            {
                var descriptor = authorized.GetValueOrDefault(pluginId);
                if (descriptor?.PageCompanion is null || !await IsCurrentUnlockedAsync(bindings[pluginId], descriptor.PageCompanion, cancellationToken).ConfigureAwait(false))
                {
                    await DropUnlockedAsync(pluginId, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        finally { gate.Release(); }
    }

    private ScriptDescriptor RequireDescriptor(string pluginId)
    {
        if (!authorized.TryGetValue(pluginId, out var descriptor) || descriptor.PageCompanion is null) throw new InvalidOperationException("PAGE_COMPANION_PERMISSION_DENIED");
        return descriptor;
    }

    private async Task<bool> IsCurrentUnlockedAsync(Binding binding, PageCompanionDescriptor companion, CancellationToken cancellationToken)
    {
        var target = await client.GetTargetByIdAsync(binding.TargetId, cancellationToken).ConfigureAwait(false);
        return target is not null && target.WebSocketDebuggerUrl == binding.Endpoint && Uri.TryCreate(target.Url, UriKind.Absolute, out var page) && page.GetLeftPart(UriPartial.Authority) == companion.Origin;
    }

    private void HandleTargetEvent(Binding binding, JsonElement message)
    {
        if (!message.TryGetProperty("method", out var method) || method.GetString() != "Page.frameNavigated") return;
        if (message.TryGetProperty("params", out var parameters) && parameters.TryGetProperty("frame", out var frame) && frame.TryGetProperty("parentId", out _)) return;
        // A same-origin reload is still a new authorization lifetime. Drop
        // the session and require the plugin to bind/inject again.
        _ = UnbindAfterNavigationAsync(binding.PluginId);
    }

    private async Task UnbindAfterNavigationAsync(string pluginId)
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try { if (bindings.ContainsKey(pluginId)) await DropUnlockedAsync(pluginId, CancellationToken.None).ConfigureAwait(false); }
        finally { gate.Release(); }
    }

    private async Task DropUnlockedAsync(string pluginId, CancellationToken cancellationToken)
    {
        if (!bindings.Remove(pluginId, out var binding)) return;
        try
        {
            await binding.Session.SendAsync("Runtime.evaluate", new
            {
                expression = $"globalThis[{JsonSerializer.Serialize(RuntimeGlobal)}]?.plugins?.[{JsonSerializer.Serialize(pluginId)}]?.stop?.('Loader page companion unbound')",
            }, cancellationToken).ConfigureAwait(false);
        }
        catch { }
        if (!string.IsNullOrWhiteSpace(binding.RegistrationId))
        {
            try { await binding.Session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", new { identifier = binding.RegistrationId }, cancellationToken).ConfigureAwait(false); } catch { }
        }
        await binding.Session.DisposeAsync().ConfigureAwait(false);
    }

    internal static string BuildInstallSource(string pluginId, PageCompanionDescriptor companion)
    {
        return $$"""
        (() => {
          const runtime = globalThis[{{JsonSerializer.Serialize(RuntimeGlobal)}}] || (globalThis[{{JsonSerializer.Serialize(RuntimeGlobal)}}] = { plugins: Object.create(null) });
          const previous = runtime.plugins[{{JsonSerializer.Serialize(pluginId)}}];
          if (previous?.fingerprint === {{JsonSerializer.Serialize(companion.Fingerprint)}} && typeof previous.invoke === "function") return { ready: true, reused: true };
          try { previous?.stop?.("Loader page companion replaced"); } catch {}
          const module = { exports: {} };
          ((module, exports) => {
        {{companion.Source}}
          })(module, module.exports);
          const implementation = module.exports?.default || module.exports;
          if (!implementation || typeof implementation.invoke !== "function") throw new Error("Page companion must export invoke(operation, payload)");
          let stopped = false;
          const record = {
            fingerprint: {{JsonSerializer.Serialize(companion.Fingerprint)}},
            invoke(operation, payload) {
              if (stopped) throw new Error("Page companion is stopped");
              return implementation.invoke(operation, payload);
            },
            stop(reason) {
              if (stopped) return;
              stopped = true;
              try { implementation.stop?.(reason); } finally { if (runtime.plugins[{{JsonSerializer.Serialize(pluginId)}}] === record) delete runtime.plugins[{{JsonSerializer.Serialize(pluginId)}}]; }
            }
          };
          runtime.plugins[{{JsonSerializer.Serialize(pluginId)}}] = record;
          return { ready: true, reused: false };
        })()
        //# sourceURL=codex-script-loader/page-companion/{{pluginId}}.js
        """;
    }

    public async ValueTask DisposeAsync()
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try { foreach (var pluginId in bindings.Keys.ToArray()) await DropUnlockedAsync(pluginId, CancellationToken.None).ConfigureAwait(false); }
        finally { gate.Release(); gate.Dispose(); }
    }

    private sealed record Binding(string PluginId, string TargetId, string Endpoint, string Origin, string Fingerprint, CdpSession Session, string? RegistrationId);
}
