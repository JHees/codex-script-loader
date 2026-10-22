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
            var name = item["name"]?.GetValue<string>() ?? id;
            if (name.Length > 240) name = id;
            var context = (item["context_window"] ?? item["context_length"])?.GetValue<int>();
            if (context < 1024) context = null;
            var modalities = item["input_modalities"] as JsonArray ?? item["architecture"]?["input_modalities"] as JsonArray;
            var parameters = item["supported_parameters"] as JsonArray;
            bool Has(string value) => parameters?.Any(parameter => parameter?.GetValue<string>() == value) == true;
            var levels = (item["effort"]?["supported_levels"] as JsonArray)?.Select(level => level!.GetValue<string>())
                .Where(level => level is "minimal" or "low" or "medium" or "high" or "xhigh" or "max" or "ultra").ToArray() ?? [];
            var deepseek = provider == "deepseek" && id is "deepseek-flash" or "deepseek-v4-pro";
            var reasoning = levels.Length > 0 ? true : parameters is null ? (bool?)null : Has("reasoning") || Has("reasoning_effort");
            result.Add(new(id, name, context, modalities?.Any(value => value?.GetValue<string>() == "image"),
                deepseek ? true : parameters is null ? null : Has("tools"), reasoning, levels,
                item["effort"]?["default_level"]?.GetValue<string>() ?? (reasoning == true ? "low" : null),
                deepseek ? "freeform" : "function", deepseek || Has("parallel_tool_calls")));
        }
        return result.DistinctBy(model => model.Id).OrderBy(model => model.Name, StringComparer.OrdinalIgnoreCase).ToArray();
    }
}
