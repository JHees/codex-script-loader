using System.Text.Json;
using System.Text.Json.Nodes;
using CodexScriptLoader.Core;
using CodexScriptLoader.Accounts;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task<int> AccountModuleFixtureAsync()
    {
        var busy = false;
        while (await Console.In.ReadLineAsync() is { } line)
        {
            var request = JsonNode.Parse(line)!.AsObject();
            object result;
            switch (request["method"]!.GetValue<string>())
            {
                case "initialize": result = new { protocolVersion = 1 }; break;
                case "prepare_stop": result = new { canStop = !busy }; break;
                case "invoke":
                    var operation = request["params"]!["operation"]!.GetValue<string>();
                    if (operation == "begin_probe") busy = true;
                    if (operation == "cancel_operation") busy = false;
                    result = new { ok = true, data = new { routingAvailable = false, pid = Environment.ProcessId } };
                    break;
                default: return 2;
            }
            Console.WriteLine(new JsonObject { ["id"] = request["id"]!.DeepClone(), ["result"] = JsonSerializer.SerializeToNode(result) }.ToJsonString());
        }
        return 0;
    }

    private static async Task TestAccountModuleAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "builtin-accounts"));
        paths.EnsureDirectories();
        var legacy = new AccountStore(Path.Combine(paths.DataRoot, "plugin-data", AccountModule.LegacyPluginId));
        var original = legacy.ImportRelay(new("fixture", "Saved account", "https://example.invalid", "fixture-model", "private-fixture-key"), null);
        legacy.SetDefault(original.Id);
        await using var module = new AccountModule(paths, Environment.ProcessPath!);
        await module.InitializeAsync(false, CancellationToken.None);
        var status = await module.StatusAsync(CancellationToken.None);
        True(!status.Enabled && status.State == "stopped" && !module.IsRunning, "Account module is off by default without starting a process");
        True(!module.BuildUiSource("fixture").Contains("registerPage", StringComparison.Ordinal), "Disabled module injects no account page");
        await module.SetEnabledAsync(true, CancellationToken.None);
        status = await module.StatusAsync(CancellationToken.None);
        True(status.Enabled && status.State == "running" && status.NeedsRestart, "Enabling starts the built-in backend and reports native routing readiness");
        var migrated = new AccountStore(module.DataDirectory);
        Equal(original.Id, migrated.List().Single().Id, "Legacy account identity is preserved");
        Equal(original.Id, migrated.DefaultAccountId, "Legacy default is preserved");
        True(File.Exists(Path.Combine(legacy.Home(original.Id), "credential.json")), "Legacy credentials remain recoverable");
        True(module.BuildUiSource("fixture").Contains("registerPage(\"loader\"", StringComparison.Ordinal), "Enabled account settings are registered as a Loader page");
        using var empty = JsonDocument.Parse("{}");
        await module.InvokeAsync("begin_probe", empty.RootElement, CancellationToken.None);
        await ThrowsAsync<AccountModuleException>(() => module.SetEnabledAsync(false, CancellationToken.None), "Active operations refuse module shutdown");
        True((await module.StatusAsync(CancellationToken.None)).Enabled, "Refused shutdown keeps the preference and page enabled");
        await ThrowsAsync<AccountModuleException>(() => module.InvokeAsync("not_allowed", empty.RootElement, CancellationToken.None), "Account operations remain bounded");
        await module.InvokeAsync("cancel_operation", empty.RootElement, CancellationToken.None);
        await module.SetEnabledAsync(false, CancellationToken.None);
        True(!module.IsRunning && !(await module.StatusAsync(CancellationToken.None)).Enabled, "Disabling stops the process");
        True(migrated.List().Single().Id == original.Id, "Disabling retains account data");
        await using var next = new AccountModule(paths, Environment.ProcessPath!);
        await next.InitializeAsync(false, CancellationToken.None);
        True(!(await next.StatusAsync(CancellationToken.None)).Enabled, "The off preference survives a new Loader instance");
        await next.SetEnabledAsync(true, CancellationToken.None);
        await next.SuspendAsync(CancellationToken.None);
        await next.InitializeAsync(true, CancellationToken.None);
        True(!next.IsRunning && (await next.StatusAsync(CancellationToken.None)).ErrorCode == "ACCOUNT_MODULE_SAFE_MODE", "Safe mode prevents account startup without deleting the preference");
    }
}
