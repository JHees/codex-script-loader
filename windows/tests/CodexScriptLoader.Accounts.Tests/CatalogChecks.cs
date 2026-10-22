using System.Net;
using System.Text.Json.Nodes;
using CodexScriptLoader.Accounts;

internal static class CatalogChecks
{
    public static async Task RunAsync(string root)
    {
        static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        const string deepseek = """
        {"data":[{"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash","context_window":1048576,
        "input_modalities":["text","image"],"effort":{"supported_levels":["low","high","max"],"default_level":"high"}}]}
        """;
        var models = await ProviderCatalog.ReadAsync("deepseek", "https://api.deepseek.com/responses", "fixture-key", CancellationToken.None,
            new ProbeHttpHandler(request =>
            {
                Assert(request.RequestUri!.AbsoluteUri == "https://api.deepseek.com/models", "Responses suffix is normalized before model discovery");
                Assert(request.Version == HttpVersion.Version20 && request.VersionPolicy == HttpVersionPolicy.RequestVersionOrLower, "Provider requests negotiate HTTP/2 without excluding HTTP/1.1 services");
                Assert(request.Headers.Authorization?.Parameter == "fixture-key", "Discovery uses the intended provider credential");
                return new(HttpStatusCode.OK) { Content = new StringContent(deepseek) };
            }));
        Assert(models.Single() is { Id: "deepseek-flash", ContextWindow: 1048576, SupportsImages: true, ToolFormat: "freeform", SupportsTools: true }, "DeepSeek capabilities follow its official model metadata");
        Assert(models.Single().ReasoningLevels.SequenceEqual(new[] { "low", "high", "max" }), "Reasoning levels are preserved");
        var openrouter = ProviderCatalog.Parse("openrouter", JsonNode.Parse("""
        {"data":[{"id":"vendor/model","context_length":128000,"architecture":{"input_modalities":["text","image"]},
        "supported_parameters":["tools","reasoning","parallel_tool_calls"]},{"id":"unknown-model"}]}
        """));
        Assert(openrouter.Single(model => model.Id == "vendor/model") is { ContextWindow: 128000, SupportsReasoning: true, ToolFormat: "function", ParallelToolCalls: true }, "OpenRouter capabilities map to a generic Responses profile");
        Assert(openrouter.Single(model => model.Id == "unknown-model") is { ContextWindow: null, SupportsTools: null, SupportsImages: null }, "Missing capabilities remain unknown");
        var store = new AccountStore(Path.Combine(root, "catalog-probe"));
        var account = store.SaveProviderConfiguration("Probe", new("deepseek", "https://api.deepseek.com", "deepseek-flash", 1048576, "high"), "fixture-key");
        var probe = await ConnectionProbe.RelayAsync(store, account.Id, CancellationToken.None, new ProbeHttpHandler(request =>
        {
            var body = JsonNode.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult())!;
            Assert(body["store"]!.GetValue<bool>() == false && body["previous_response_id"] is null, "Probes are stateless");
            Assert(body["reasoning"]!["effort"]!.GetValue<string>() == "high" && body["max_output_tokens"]!.GetValue<int>() == 2048, "The saved reasoning setting gets a sufficient synthetic probe output budget");
            return new(HttpStatusCode.OK) { Content = new StringContent("data: {\"type\":\"response.output_text.delta\",\"delta\":\"ACCOUNT_CONNECTION_OK\"}\n\ndata: {\"type\":\"response.completed\"}\n\n") };
        }));
        Assert(probe.Passed, "Responses streams complete without a DONE sentinel");
        Console.WriteLine("PASS: provider model discovery, capability mapping, unknown metadata and stateless reasoning probe");
    }
}
