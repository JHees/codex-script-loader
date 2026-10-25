using System.Text.Json;
using System.Text.Json.Nodes;
using CodexScriptLoader.Accounts;

internal static class ProviderChecks
{
    public static async Task RunAsync(string root)
    {
        static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        var store = new AccountStore(Path.Combine(root, "provider-versions"));
        var firstSettings = new ProviderSettings("deepseek", "https://api.deepseek.com", "deepseek-flash", 1048576, "high", true, "freeform", true);
        var first = store.SaveProviderConfiguration("DeepSeek", firstSettings, "fixture-private-key");
        store.SetDefault(first.Id);
        var firstFiles = new[] { "provider-profile.json", "provider.toml", "models.json", "credential.json" }
            .ToDictionary(name => name, name => File.ReadAllText(Path.Combine(store.Home(first.Id), name)));
        var second = store.SaveProviderConfiguration("DeepSeek", firstSettings with { Model = "deepseek-v4-pro", SupportsImages = false }, null, first.Id);
        Assert(second.Id != first.Id && second.ConfigurationVersion == 2, "A revision must have an independent backend home");
        Assert(store.DefaultAccountId == second.Id && store.List().Single().Id == second.Id, "Global selection follows the current configuration revision");
        Assert(JsonNode.Parse(File.ReadAllText(Path.Combine(store.Home(second.Id), "credential.json")))?["apiKey"]?.GetValue<string>() == "fixture-private-key", "Same-origin revision retains the saved key");
        Assert(firstFiles.All(pair => File.ReadAllText(Path.Combine(store.Home(first.Id), pair.Key)) == pair.Value), "Previous configuration files remain unchanged");
        var history = JsonSerializer.Serialize(store.ProviderConfigurationStatus(second.Id));
        Assert(!history.Contains("fixture-private-key", StringComparison.Ordinal), "Configuration history never returns credentials");
        Assert(store.ActivateProviderConfiguration(second.Id, 1).Id == first.Id && store.DefaultAccountId == first.Id, "Rollback restores the previous selected version");
        try { store.SaveProviderConfiguration("Wrong origin", firstSettings with { Provider = "openrouter", BaseUrl = "https://openrouter.ai/api/v1" }, null, first.Id); throw new Exception("Cross-origin key reuse accepted"); }
        catch (InvalidOperationException error) when (error.Message == "PROVIDER_KEY_REQUIRED") { }
        Assert(store.DefaultAccountId == first.Id && store.List().Count == 1, "Rejected changes preserve the active configuration");
        var fresh = new AccountStore(Path.Combine(root, "provider-versions"));
        Assert(fresh.DefaultAccountId == first.Id && fresh.ConfigurationAccounts(first.Id).Length == 2, "Revision selection survives reopening the store");

        var primary = Path.Combine(root, "provider-primary");
        Directory.CreateDirectory(primary);
        File.WriteAllText(Path.Combine(primary, "config.toml"), "sandbox_mode=\"read-only\"\napproval_policy=\"on-request\"\nmodel_reasoning_effort=\"ultra\"\nforced_login_method=\"chatgpt\"\n[features.code_mode]\nenabled=true\n");
        var offline = store.SaveProviderConfiguration("Offline catalog", firstSettings with { Provider = "custom", BaseUrl = "https://provider.example.invalid/v1" }, "fixture-catalog-key");
        var cli = OfficialCliLocator.Find();
        var factory = new RouterBackendFactory(store, cli, primary, null, ["app-server"], null);
        var start = factory.CreateStartInfo(offline.Id);
        Assert(start.Environment["ACCOUNT_SWITCHER_RELAY_KEY"] == "fixture-catalog-key", "Credentials are delivered through the owned process environment");
        Assert(!string.Join(" ", start.ArgumentList).Contains("fixture-catalog-key", StringComparison.Ordinal), "Keys never appear in process arguments");
        Assert(File.ReadAllText(Path.Combine(primary, "config.toml")).Contains("ultra", StringComparison.Ordinal), "Provider configuration does not rewrite the desktop's primary config");
        await using var backend = new OfficialBackend(start);
        await backend.InitializeAsync();
        var catalog = await backend.RequestAsync("model/list", new JsonObject());
        Assert(catalog?["data"]?.AsArray().Any(model => model?["model"]?.GetValue<string>() == "deepseek-flash") == true, "Official CLI loads the provider model catalog");
        var config = await backend.RequestAsync("config/read", new JsonObject { ["includeLayers"] = false });
        Assert(config?["config"]?["model"]?.GetValue<string>() == "deepseek-flash", "The selected revision supplies the effective model");
        Assert(config?["config"]?["model_reasoning_effort"]?.GetValue<string>() == "high", "The model revision overrides incompatible inherited reasoning");
        Assert(config?["config"]?["forced_login_method"]?.GetValue<string>() == "api", "Provider API authentication overrides an inherited subscription-only login requirement");
        await using (var deepseekBackend = new OfficialBackend(new RouterBackendFactory(store, cli, primary, null,
            ["-c", "features.code_mode_host=true", "app-server"], null).CreateStartInfo(first.Id)))
        {
            await deepseekBackend.InitializeAsync();
            var effective = await deepseekBackend.RequestAsync("config/read", new JsonObject { ["includeLayers"] = false });
            Assert(effective?["config"]?["features"]?["code_mode"]?["enabled"]?.GetValue<bool>() == false,
                "DeepSeek must not inherit the desktop custom exec tool");
            var presetCatalog = await deepseekBackend.RequestAsync("model/list", new JsonObject());
            AssertRelayModelMatchesCatalog(presetCatalog, store.Get(first.Id), store.ReadProviderSettings(first.Id)!);
        }
        var legacy = store.ImportRelay(new("legacy-source", "Legacy relay", "https://relay.example.invalid/v1", "legacy-model", "fixture-legacy-key"), null);
        File.WriteAllText(Path.Combine(store.Home(legacy.Id), "config.toml"), "legacy-config");
        store.SetDefault(legacy.Id);
        var draft = JsonSerializer.SerializeToNode(store.ProviderConfigurationStatus(legacy.Id), AccountStore.JsonOptions)!;
        Assert(draft["legacy"]!.GetValue<bool>() && draft["settings"]!["model"]!.GetValue<string>() == "legacy-model", "Imported relay settings are editable before migration");
        var edited = store.SaveProviderConfiguration("Edited legacy", new("custom", legacy.BaseUrl!, "new-model", 64000), "", legacy.Id);
        Assert(store.DefaultAccountId == edited.Id && edited.SourceId == "legacy-source", "Legacy default and import identity follow the new revision");
        Assert(ProviderRuntime.ProviderId(store.Get(legacy.Id)) == "account_relay" && store.ReadProviderSettings(legacy.Id) is null, "In-flight legacy backends keep their existing provider identity");
        Assert(File.ReadAllText(Path.Combine(store.Home(legacy.Id), "config.toml")) == "legacy-config", "Migration preserves original configuration files");
        Assert(store.ActivateProviderConfiguration(edited.Id, 0).Id == legacy.Id && store.DefaultAccountId == legacy.Id, "The original imported configuration can be restored");
        try { store.ImportRelay(new("legacy-source", "Overwritten", legacy.BaseUrl!, "changed", "new-key"), null); throw new Exception("Versioned import was overwritten"); }
        catch (InvalidOperationException error) when (error.Message == "PROVIDER_CONFIGURATION_MANAGED") { }
        var retainedDefaults = store.SaveProviderConfiguration("Key edit", new("custom", legacy.BaseUrl!, legacy.Model!, 0, UseDefaultModelMetadata: true), "fixture-new-key", legacy.Id);
        Assert(!ProviderRuntime.Overrides(retainedDefaults, store.ReadProviderSettings(retainedDefaults.Id)!, store.Home(retainedDefaults.Id))
            .Any(option => option.StartsWith("model_catalog_json=", StringComparison.Ordinal) || option.StartsWith("model_context_window=", StringComparison.Ordinal)), "Key-only edits preserve native model metadata without requiring an invented context window");
        try { store.SaveProviderConfiguration("Changed model", new("custom", legacy.BaseUrl!, "different-model", 0, UseDefaultModelMetadata: true), null, retainedDefaults.Id); throw new Exception("A changed model reused unverified defaults"); }
        catch (InvalidOperationException error) when (error.Message == "MODEL_SETTINGS_INVALID") { }
        var multiStore = new AccountStore(Path.Combine(root, "provider-multi"));
        var multiSettings = new ProviderSettings("custom", "https://multi.invalid/v1", "m-one", 64000, "high",
            Models: new[] { new ProviderModelSettings("m-one", "Model One", 64000, new[] { "low", "high" }, "high"),
                new ProviderModelSettings("m-two", "Model Two", 32000, new[] { "low", "high" }, "low", SupportsImages: true) },
            Usage: new ProviderUsageSettings("auto"));
        var multi = multiStore.SaveProviderConfiguration("Multi", multiSettings, "fixture-multi-key");
        var documents = JsonNode.Parse(File.ReadAllText(Path.Combine(multiStore.Home(multi.Id), "models.json")))!["models"]!.AsArray();
        Assert(documents.Count == 2 && documents.Any(item => item!["slug"]!.GetValue<string>() == "m-two"), "Every enabled model is written to the provider catalog");
        var multiStatus = JsonNode.Parse(JsonSerializer.Serialize(multiStore.ProviderConfigurationStatus(multi.Id), AccountStore.JsonOptions))!;
        Assert(multiStatus["settings"]!["models"]!.AsArray().Count == 2 && multiStatus["settings"]!["usage"]!["mode"]!.GetValue<string>() == "auto",
            "Multi-model settings and usage configuration round-trip");
        Console.WriteLine("PASS: legacy relay editing, retained provider identity, original configuration rollback and import protection");
        Console.WriteLine("PASS: provider configuration versions, key isolation, rollback and official CLI model catalog");
        Console.WriteLine("PASS: synthesized relay model entries match the official CLI model catalog");
    }

    private static void AssertRelayModelMatchesCatalog(JsonNode? catalog, AccountEntry account, ProviderSettings settings)
    {
        var synthesized = AccountRouter.RelayModelEntry(account, settings);
        var actual = catalog?["data"]?.AsArray().FirstOrDefault(model => model?["id"]?.GetValue<string>() == settings.Model)
            ?? throw new InvalidOperationException("The official CLI catalog is missing the relay model.");
        foreach (var field in new[] { "id", "model", "displayName", "description", "defaultReasoningEffort", "inputModalities" })
            if (!JsonNode.DeepEquals(synthesized[field], actual[field]))
                throw new InvalidOperationException($"Synthesized model field '{field}' does not match the official catalog.");
        var actualEfforts = actual["supportedReasoningEfforts"]?.AsArray() ?? [];
        foreach (var effort in synthesized["supportedReasoningEfforts"]!.AsArray())
            if (!actualEfforts.Any(candidate => JsonNode.DeepEquals(candidate, effort)))
                throw new InvalidOperationException("A synthesized reasoning effort is missing from the official catalog.");
        foreach (var field in new[] { "hidden", "supportsPersonality", "multiAgentVersion", "additionalSpeedTiers", "serviceTiers", "defaultServiceTier", "availableAccessPrograms" })
            if (actual[field] is { } expected && !JsonNode.DeepEquals(synthesized[field], expected))
                throw new InvalidOperationException($"Synthesized model field '{field}' does not match the official catalog.");
    }
}
