using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed record CdpDownloadResult(Uri FinalUri, int StatusCode, long BytesWritten);

internal sealed class CdpUpdateTransport(CdpClient client, JsonlLogger logger)
{
    public async Task<CdpDownloadResult> DownloadAsync(
        Uri uri,
        string destination,
        long maximumBytes,
        Action<long> progress,
        CancellationToken cancellationToken)
    {
        if (maximumBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        var browserEndpoint = await client.GetBrowserEndpointAsync(cancellationToken).ConfigureAwait(false);
        await using var browser = await CdpSession.ConnectAsync(browserEndpoint, cancellationToken).ConfigureAwait(false);
        string? targetId = null;
        try
        {
            var created = await browser.SendAsync("Target.createTarget", new
            {
                url = "about:blank",
                hidden = true,
                background = true,
                focus = false,
            }, cancellationToken).ConfigureAwait(false);
            targetId = created.GetProperty("targetId").GetString()
                ?? throw new InvalidDataException("CDP hidden update target has no id.");
            var target = await WaitForTargetAsync(targetId, cancellationToken).ConfigureAwait(false);
            await using var page = await CdpSession.ConnectAsync(new Uri(target.WebSocketDebuggerUrl), cancellationToken).ConfigureAwait(false);
            var observedUris = new ConcurrentQueue<Uri>();
            page.EventReceived += message => CaptureRequestUri(message, observedUris);
            await page.SendAsync("Network.enable", cancellationToken: cancellationToken).ConfigureAwait(false);
            var frameTree = await page.SendAsync("Page.getFrameTree", cancellationToken: cancellationToken).ConfigureAwait(false);
            var frameId = frameTree.GetProperty("frameTree").GetProperty("frame").GetProperty("id").GetString()
                ?? throw new InvalidDataException("CDP hidden update target has no frame id.");
            var result = await page.SendAsync("Network.loadNetworkResource", new
            {
                frameId,
                url = uri.AbsoluteUri,
                options = new { disableCache = true, includeCredentials = false },
            }, cancellationToken).ConfigureAwait(false);
            var resource = result.GetProperty("resource");
            var success = resource.TryGetProperty("success", out var successElement) && successElement.GetBoolean();
            var status = resource.TryGetProperty("httpStatusCode", out var statusElement) ? statusElement.GetInt32() : 0;
            if (!success || status is < 200 or >= 300)
            {
                var networkError = resource.TryGetProperty("netErrorName", out var errorElement) ? errorElement.GetString() : null;
                throw new HttpRequestException($"Chromium update request failed with HTTP {status} ({networkError ?? "network error"}).");
            }
            var handle = resource.TryGetProperty("stream", out var streamElement) ? streamElement.GetString() : null;
            if (string.IsNullOrWhiteSpace(handle)) throw new InvalidDataException("Chromium update response has no stream.");
            long total = 0;
            try
            {
                await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
                while (true)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var chunk = await page.SendAsync("IO.read", new { handle, size = 128 * 1024 }, cancellationToken).ConfigureAwait(false);
                    var text = chunk.TryGetProperty("data", out var dataElement) ? dataElement.GetString() ?? string.Empty : string.Empty;
                    var bytes = chunk.TryGetProperty("base64Encoded", out var encodedElement) && encodedElement.GetBoolean()
                        ? Convert.FromBase64String(text)
                        : Encoding.UTF8.GetBytes(text);
                    total = checked(total + bytes.LongLength);
                    if (total > maximumBytes) throw new InvalidDataException("Chromium update response exceeded the allowed size.");
                    if (bytes.Length > 0) await output.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
                    progress(total);
                    if (chunk.TryGetProperty("eof", out var eofElement) && eofElement.GetBoolean()) break;
                }
            }
            finally
            {
                try { await page.SendAsync("IO.close", new { handle }, CancellationToken.None).ConfigureAwait(false); }
                catch (Exception exception) when (exception is IOException or InvalidOperationException or OperationCanceledException)
                {
                    logger.Warn("update-cdp-stream-close-failed", new { message = JsonlLogger.Redact(exception.Message) });
                }
            }
            var finalUri = observedUris.LastOrDefault() ?? uri;
            return new CdpDownloadResult(finalUri, status, total);
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(targetId))
            {
                try { await browser.SendAsync("Target.closeTarget", new { targetId }, CancellationToken.None).ConfigureAwait(false); }
                catch (Exception exception) when (exception is IOException or InvalidOperationException or OperationCanceledException)
                {
                    logger.Warn("update-cdp-target-close-failed", new { message = JsonlLogger.Redact(exception.Message) });
                }
            }
        }
    }

    private async Task<CdpTarget> WaitForTargetAsync(string targetId, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        while (true)
        {
            var target = await client.GetTargetByIdAsync(targetId, timeout.Token).ConfigureAwait(false);
            if (target is not null) return target;
            await Task.Delay(50, timeout.Token).ConfigureAwait(false);
        }
    }

    private static void CaptureRequestUri(JsonElement message, ConcurrentQueue<Uri> observedUris)
    {
        if (!message.TryGetProperty("method", out var method) || method.GetString() != "Network.requestWillBeSent" ||
            !message.TryGetProperty("params", out var parameters) || !parameters.TryGetProperty("request", out var request) ||
            !request.TryGetProperty("url", out var url) || !Uri.TryCreate(url.GetString(), UriKind.Absolute, out var uri)) return;
        observedUris.Enqueue(uri);
    }
}
