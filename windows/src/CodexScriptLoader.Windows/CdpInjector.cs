using System.Text.Json;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed class CdpInjector
{
    private readonly CdpClient client;
    private readonly Dictionary<string, string> registrationIds = new(StringComparer.Ordinal);

    public CdpInjector(CdpClient client)
    {
        this.client = client;
    }

    public async Task<IReadOnlyList<ScriptLoadResult>> InjectAsync(
        string source,
        IReadOnlyList<ScriptDescriptor> descriptors,
        IReadOnlyList<CdpTarget> targets,
        CancellationToken cancellationToken)
    {
        var descriptorById = descriptors.ToDictionary(descriptor => descriptor.Id, StringComparer.Ordinal);
        var results = new List<ScriptLoadResult>();
        foreach (var target in targets)
        {
            if (!client.IsManagedEndpoint(target.WebSocketDebuggerUrl))
            {
                throw new InvalidOperationException("Renderer target endpoint is outside the managed loopback port.");
            }

            await using var session = await CdpSession.ConnectAsync(new Uri(target.WebSocketDebuggerUrl), cancellationToken).ConfigureAwait(false);
            await session.SendAsync("Runtime.enable", cancellationToken: cancellationToken).ConfigureAwait(false);
            await session.SendAsync("Page.enable", cancellationToken: cancellationToken).ConfigureAwait(false);
            if (registrationIds.Remove(target.Id, out var previousId))
            {
                try
                {
                    await session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", new { identifier = previousId }, cancellationToken).ConfigureAwait(false);
                }
                catch (InvalidOperationException)
                {
                }
            }

            var registration = await session.SendAsync("Page.addScriptToEvaluateOnNewDocument", new { source }, cancellationToken).ConfigureAwait(false);
            var registrationId = registration.TryGetProperty("identifier", out var identifier) ? identifier.GetString() : null;
            try
            {
                var evaluation = await session.SendAsync("Runtime.evaluate", new
                {
                    expression = source,
                    awaitPromise = false,
                    returnByValue = true,
                }, cancellationToken).ConfigureAwait(false);
                if (evaluation.TryGetProperty("exceptionDetails", out _))
                {
                    throw new InvalidOperationException("Renderer rejected the injected script source.");
                }

                if (evaluation.TryGetProperty("result", out var runtimeResult) &&
                    runtimeResult.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in value.EnumerateArray())
                    {
                        var id = item.TryGetProperty("id", out var idElement) ? idElement.GetString() : null;
                        var status = item.TryGetProperty("status", out var statusElement) ? statusElement.GetString() : "failed";
                        if (id is null || !descriptorById.TryGetValue(id, out var descriptor))
                        {
                            continue;
                        }

                        results.Add(new ScriptLoadResult(
                            descriptor.Id,
                            descriptor.Version,
                            descriptor.Fingerprint,
                            "granted",
                            status == "running" ? "running" : "failed",
                            status == "running" ? null : "SCRIPT_START_FAILED"));
                    }
                }

                if (!string.IsNullOrWhiteSpace(registrationId))
                {
                    registrationIds[target.Id] = registrationId;
                }
            }
            catch
            {
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

                throw;
            }
        }

        return results;
    }

    public async Task StopAllAsync(IReadOnlyList<CdpTarget> targets, CancellationToken cancellationToken)
    {
        const string source = """
        (() => {
          const runtime = globalThis.__codexScriptLoader;
          if (!runtime?.scripts) return;
          for (const [id, record] of Object.entries(runtime.scripts)) {
            try { record?.stop?.({ reason: "shutdown" }); } catch (error) { runtime.recordError?.({ id, phase: "stop", error: String(error) }); }
            delete runtime.scripts[id];
          }
          try { runtime.settingsHost?.stop?.(); } catch {}
        })()
        """;
        foreach (var target in targets)
        {
            await using var session = await CdpSession.ConnectAsync(new Uri(target.WebSocketDebuggerUrl), cancellationToken).ConfigureAwait(false);
            await session.SendAsync("Runtime.evaluate", new { expression = source, returnByValue = true }, cancellationToken).ConfigureAwait(false);
            if (registrationIds.Remove(target.Id, out var registrationId))
            {
                try
                {
                    await session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", new { identifier = registrationId }, cancellationToken).ConfigureAwait(false);
                }
                catch (InvalidOperationException)
                {
                }
            }
        }
    }
}
