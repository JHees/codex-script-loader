using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record ProviderModel(string Id, string Name, int? ContextWindow, bool? SupportsImages,
    bool? SupportsTools, bool? SupportsReasoning, string[] ReasoningLevels, string? DefaultReasoningEffort,
    string ToolFormat, bool ParallelToolCalls);

public static class ProviderCatalog
{
    public static async Task<IReadOnlyList<ProviderModel>> ReadAsync(string provider, string baseUrl, string? key,
        CancellationToken cancellation, HttpMessageHandler? handler = null)
    {
        var endpoint = ProviderSettings.ValidateEndpoint(provider, baseUrl);
        using var client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(30), MaxResponseContentBufferSize = 8 * 1024 * 1024 };
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint + "/models")
        { Version = System.Net.HttpVersion.Version20, VersionPolicy = HttpVersionPolicy.RequestVersionOrLower };
        if (key is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        using var response = await client.SendAsync(request, cancellation);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException((int)response.StatusCode switch
            { 401 or 403 => "AUTHENTICATION_FAILED", 404 or 405 => "MODEL_DISCOVERY_UNSUPPORTED", 429 => "RATE_LIMITED", _ => "SERVICE_UNAVAILABLE" });
        return Parse(provider, JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellation)));
    }

    public static IReadOnlyList<ProviderModel> Parse(string provider, JsonNode? catalog)
    {
        if (catalog?["data"] is not JsonArray models) throw new InvalidOperationException("RESPONSE_INVALID");
        var result = new List<ProviderModel>();
        foreach (var item in models.OfType<JsonObject>().Take(2000))
        {
            if (item["id"] is not JsonValue idValue || !idValue.TryGetValue<string>(out var id) ||
                id.Length is < 1 or > 160 || id.Any(char.IsWhiteSpace) || id.Any(char.IsControl)) continue;
            var name = item["display_name"]?.GetValue<string>() ?? item["displayName"]?.GetValue<string>()
                ?? item["name"]?.GetValue<string>() ?? id;
            if (name.Length > 240) name = id;
            var context = (item["context_window"] ?? item["contextWindow"] ?? item["context_length"] ?? item["max_context_tokens"])?.GetValue<int>();
            if (context < 1024) context = null;
            var modalities = item["input_modalities"] as JsonArray ?? item["architecture"]?["input_modalities"] as JsonArray;
            var parameters = item["supported_parameters"] as JsonArray;
            bool Has(string value) => parameters?.Any(parameter => parameter?.GetValue<string>() == value) == true;
            var levels = (item["effort"]?["supported_levels"] as JsonArray
                    ?? item["supported_reasoning_levels"] as JsonArray
                    ?? item["supported_reasoning_efforts"] as JsonArray
                    ?? item["reasoning_efforts"] as JsonArray)?
                .Select(level => level is JsonObject entry
                    ? entry["reasoningEffort"]?.GetValue<string>() ?? entry["effort"]?.GetValue<string>()
                    : level?.GetValue<string>())
                .Where(level => level is "minimal" or "low" or "medium" or "high" or "xhigh" or "max" or "ultra")
                .Select(level => level!).Distinct(StringComparer.Ordinal).ToArray() ?? [];
            var deepseek = provider == "deepseek";
            if (deepseek && levels.Length == 0) levels = ["low", "high", "max"];
            var reasoning = levels.Length > 0 ? true : parameters is null ? (bool?)null : Has("reasoning") || Has("reasoning_effort");
            if (reasoning == true && levels.Length == 0) levels = ["low", "medium", "high"];
            var defaultEffort = item["effort"]?["default_level"]?.GetValue<string>();
            if (defaultEffort is not ("minimal" or "low" or "medium" or "high" or "xhigh" or "max" or "ultra") ||
                levels.Length > 0 && !levels.Contains(defaultEffort))
                defaultEffort = levels.FirstOrDefault();
            result.Add(new(id, name, context, modalities?.Any(value => value?.GetValue<string>() == "image"),
                deepseek ? true : parameters is null ? null : Has("tools"), reasoning, levels,
                defaultEffort,
                deepseek ? "freeform" : "function", deepseek || Has("parallel_tool_calls")));
        }
        return result.DistinctBy(model => model.Id).OrderBy(model => model.Name, StringComparer.OrdinalIgnoreCase).ToArray();
    }
}
