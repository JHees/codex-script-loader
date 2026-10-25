using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record ConnectionResult(bool Passed, string? ErrorCode, int? HttpStatus, long ElapsedMilliseconds, IReadOnlyList<UsageWindow>? Usage = null, AccountCredits? Credits = null);
public sealed record AccountCredits(bool HasCredits, bool Unlimited, string? Balance, string? Limit = null);
public sealed record UsageWindow(string Name, int UsedPercent, long? WindowDurationMins, long? ResetsAt);

public static class ConnectionProbe
{
    public static async Task<ConnectionResult> RelayAsync(AccountStore store, string id, CancellationToken cancellation, HttpMessageHandler? handler = null)
    {
        var account = store.Get(id);
        var endpoint = RelayAccountSource.ValidateEndpoint(account.BaseUrl ?? "");
        using var client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(45) };
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint + "/responses")
        { Version = System.Net.HttpVersion.Version20, VersionPolicy = HttpVersionPolicy.RequestVersionOrLower };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", store.ReadRelayKey(id));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        var profile = store.ReadProviderSettings(id);
        request.Content = new StringContent(JsonSerializer.Serialize(new
        {
            model = account.Model, stream = true, store = false, max_output_tokens = 2048,
            reasoning = profile?.ReasoningEffort is { } effort ? new { effort } : null,
            input = new[] { new { role = "user", content = new[] { new { type = "input_text", text = "Reply with exactly ACCOUNT_CONNECTION_OK. Do not use tools." } } } },
        }), Encoding.UTF8, "application/json");
        var timer = Stopwatch.StartNew();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(45));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var status = (int)response.StatusCode;
            if (!response.IsSuccessStatusCode)
                return new(false, status is 401 or 403 ? "AUTHENTICATION_FAILED" : status == 404 ? "MODEL_OR_ENDPOINT_NOT_FOUND" : status == 429 ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE", status, timer.ElapsedMilliseconds);
            using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(timeout.Token), Encoding.UTF8);
            var text = new StringBuilder();
            var count = 0;
            while (await reader.ReadLineAsync(timeout.Token) is { } line)
            {
                if ((count += line.Length) > 1024 * 1024) return new(false, "RESPONSE_INVALID", status, timer.ElapsedMilliseconds);
                if (!line.StartsWith("data:", StringComparison.Ordinal) || line[5..].Trim() == "[DONE]") continue;
                using var frame = JsonDocument.Parse(line[5..]);
                var value = frame.RootElement;
                var type = value.TryGetProperty("type", out var kind) ? kind.GetString() : null;
                if (type == "response.output_text.delta") text.Append(value.GetProperty("delta").GetString());
                if (type == "response.completed")
                    return new(text.ToString().Trim() == "ACCOUNT_CONNECTION_OK", text.ToString().Trim() == "ACCOUNT_CONNECTION_OK" ? null : "RESPONSE_INVALID", status, timer.ElapsedMilliseconds);
                if (type == "response.incomplete") return new(false, "RESPONSE_INCOMPLETE", status, timer.ElapsedMilliseconds);
                if (type is "error" or "response.failed") return new(false, "SERVICE_UNAVAILABLE", status, timer.ElapsedMilliseconds);
            }
            return new(false, "RESPONSE_INCOMPLETE", status, timer.ElapsedMilliseconds);
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return new(false, "CONNECTION_TIMEOUT", null, timer.ElapsedMilliseconds); }
        catch (HttpRequestException) { return new(false, "CONNECTION_FAILED", null, timer.ElapsedMilliseconds); }
        catch (JsonException) { return new(false, "RESPONSE_INVALID", null, timer.ElapsedMilliseconds); }
    }

    public static async Task<ConnectionResult> SubscriptionAsync(AccountStore store, string id, OfficialCli cli, CancellationToken cancellation)
    {
        var timer = Stopwatch.StartNew();
        await using var backend = new OfficialBackend(OfficialBackend.LoginStartInfo(cli.Executable, cli.Sha256, store.Home(id)));
        await backend.InitializeAsync(cancellation);
        var status = await backend.RequestAsync("account/read", new JsonObject { ["refreshToken"] = false }, cancellation);
        if (status?["account"]?["type"]?.GetValue<string>() != "chatgpt")
            return new(false, "AUTHENTICATION_FAILED", null, timer.ElapsedMilliseconds);
        using (var account = JsonDocument.Parse(status["account"]!.ToJsonString())) store.MarkAuthenticated(id, account.RootElement);
        try
        {
            var limits = await backend.RequestAsync("account/rateLimits/read", new JsonObject(), cancellation);
            return new(true, null, null, timer.ElapsedMilliseconds, ParseUsage(limits), ParseCredits(limits));
        }
        catch (BackendRpcException) { return new(true, "USAGE_UNAVAILABLE", null, timer.ElapsedMilliseconds); }
    }

    public static async Task<AccountCredits?> RelayBalanceAsync(AccountStore store, string id, CancellationToken cancellation, HttpMessageHandler? handler = null)
    {
        var account = store.Get(id);
        if (account.Kind != "relay" || account.BaseUrl is null) return null;
        var endpoint = RelayAccountSource.ValidateEndpoint(account.BaseUrl);
        var settings = store.ReadProviderSettings(id);
        var provider = settings?.Provider ?? new Uri(endpoint).Host switch
        {
            "api.deepseek.com" => "deepseek", "openrouter.ai" => "openrouter", _ => "custom",
        };
        return await RelayBalanceAsync(endpoint, store.ReadRelayKey(id), provider, settings?.Usage, cancellation, handler);
    }

    public static async Task<AccountCredits?> RelayBalanceAsync(string endpoint, string key, string provider,
        ProviderUsageSettings? usage, CancellationToken cancellation, HttpMessageHandler? handler = null)
    {
        var targets = usage is { Mode: "custom", Url: { Length: > 0 } url }
            ? new[] { new Uri(new Uri(endpoint), url).AbsoluteUri }
            : provider == "openrouter"
                ? new[] { endpoint + "/credits", endpoint + "/v1/credits", endpoint + "/user/balance", endpoint + "/v1/usage" }
                : new[] { endpoint + "/user/balance", endpoint + "/v1/usage", endpoint + "/credits", endpoint + "/v1/credits" };
        using var client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(5), MaxResponseContentBufferSize = 64 * 1024 };
        foreach (var target in targets)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, target);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                using var response = await client.SendAsync(request, cancellation);
                if (!response.IsSuccessStatusCode) continue;
                var text = await response.Content.ReadAsStringAsync(cancellation);
                if (text.Length == 0 || text[0] is not ('{' or '[')) continue;
                if (ParseRelayBalance(provider, JsonNode.Parse(text), usage) is { } credits) return credits;
            }
            catch (Exception error) when (error is HttpRequestException or JsonException or IOException or InvalidOperationException or OperationCanceledException)
            {
                if (cancellation.IsCancellationRequested) throw;
            }
        }
        return null;
    }

    public static AccountCredits? ParseRelayBalance(string provider, JsonNode? document, ProviderUsageSettings? usage = null)
    {
        if (document is not JsonObject root) return null;
        if (usage is { Mode: "custom" })
        {
            var value = ReadPath(root, usage.RemainingPath) ?? ReadPath(root, "balance") ?? ReadPath(root, "remaining");
            if (Amount(value) is not { } amount) return null;
            var unit = Text(ReadPath(root, usage.UnitPath)) ?? Text(ReadPath(root, "unit")) ?? Text(ReadPath(root, "currency"));
            var limit = Amount(ReadPath(root, usage.LimitPath) ?? ReadPath(root, "quota.limit"));
            var valid = ReadPath(root, usage.ValidPath);
            if (valid is JsonValue flag && flag.TryGetValue<bool>(out var active) && !active) return null;
            return new(amount > 0, false, Format(amount, unit), limit is null ? null : Format(limit.Value, unit));
        }
        if (provider == "openrouter" && root["data"] is JsonObject data)
        {
            var total = Amount(data["total_credits"]);
            var used = Amount(data["total_usage"]);
            return total is null || used is null ? null : new(total.Value > used.Value, false, Format(total.Value - used.Value, "USD"));
        }
        if (root["balance_infos"] is JsonArray infos)
        {
            var parts = new List<string>();
            decimal total = 0;
            foreach (var info in infos.OfType<JsonObject>())
            {
                var value = Amount(info["total_balance"]);
                var currency = Text(info["currency"]);
                if (value is null || currency is null) continue;
                parts.Add(Format(value.Value, currency));
                total += value.Value;
            }
            return parts.Count == 0 ? null : new(total > 0, false, string.Join(" + ", parts));
        }
        var remaining = FirstAmount(root, "remaining", "balance", "quota.remaining", "quota.balance", "data.remaining", "data.balance");
        if (remaining is null) return null;
        var unitText = Text(ReadPath(root, "unit")) ?? Text(ReadPath(root, "quota.unit")) ?? Text(ReadPath(root, "currency")) ?? Text(ReadPath(root, "data.unit"));
        var limitAmount = FirstAmount(root, "quota.limit", "limit", "data.limit");
        return new(remaining > 0, false, Format(remaining.Value, unitText), limitAmount is null ? null : Format(limitAmount.Value, unitText));
    }

    private static decimal? FirstAmount(JsonObject root, params string[] paths)
    {
        foreach (var path in paths)
            if (Amount(ReadPath(root, path)) is { } value) return value;
        return null;
    }

    private static JsonNode? ReadPath(JsonNode? node, string path)
    {
        if (node is null || string.IsNullOrWhiteSpace(path)) return null;
        var current = node;
        foreach (var part in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (current is not JsonObject obj || !obj.TryGetPropertyValue(part, out current)) return null;
        }
        return current;
    }

    public static IReadOnlyList<UsageWindow> ParseUsage(JsonNode? limits)
    {
        var windows = new List<UsageWindow>();
        var buckets = limits?["rateLimitsByLimitId"] as JsonObject;
        if (buckets is not null)
            foreach (var bucket in buckets) AddWindows(windows, bucket.Key, bucket.Value);
        else AddWindows(windows, "codex", limits?["rateLimits"]);
        return windows;
    }

    public static AccountCredits? ParseCredits(JsonNode? limits)
    {
        var credits = limits?["rateLimits"]?["credits"] ?? (limits?["rateLimitsByLimitId"] as JsonObject)?
            .Select(pair => pair.Value?["credits"]).FirstOrDefault(value => value is JsonObject);
        return credits is JsonObject ? new(credits["hasCredits"]!.GetValue<bool>(),
            credits["unlimited"]!.GetValue<bool>(), credits["balance"]?.GetValue<string>()) : null;
    }

    private static decimal? Amount(JsonNode? value) =>
        decimal.TryParse(value?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var amount) ? amount : null;

    private static string? Text(JsonNode? value) =>
        value is JsonValue item && item.TryGetValue<string>(out var text) ? text : null;

    private static string Format(decimal value, string? unit) =>
        value.ToString("0.##", CultureInfo.InvariantCulture) +
        (unit is { Length: > 0 and <= 8 } && unit.All(char.IsLetterOrDigit) ? " " + unit : "");

    private static void AddWindows(List<UsageWindow> output, string name, JsonNode? bucket)
    {
        foreach (var type in new[] { "primary", "secondary" })
            if (bucket?[type] is JsonObject window)
                output.Add(new UsageWindow(name + "/" + type, window["usedPercent"]!.GetValue<int>(),
                    window["windowDurationMins"]?.GetValue<long>(), window["resetsAt"]?.GetValue<long>()));
    }
}
