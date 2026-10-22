using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json.Nodes;
using System.Text.Json;
using System.Net;
using CodexScriptLoader.Accounts;

if (args.FirstOrDefault() == "--loader-backend") { Environment.ExitCode = await BackendService.RunStandaloneAsync(); return; }
if (args.FirstOrDefault() == "--accounts-backend") { Environment.ExitCode = await BackendService.RunAsync(); return; }
if (args.FirstOrDefault() == "--accounts-test-host") { Environment.ExitCode = await AccountBackendHost.RunAsync(args[1]); return; }
if (args.FirstOrDefault() == "--desktop-cli") { Environment.ExitCode = await DesktopCli.RunAsync(args[1], args[3..], args[2] == "enabled"); return; }
if (args.FirstOrDefault() == "--fixture") { await Fixture(args[1], args[2]); return; }
if (args.FirstOrDefault() == "--router-fixture") { await RouterChecks.FixtureAsync(args[1]); return; }
if (args.FirstOrDefault() == "--verify-official-cli")
{
    var cli = OfficialCliLocator.Find();
    Console.WriteLine(JsonSerializer.Serialize(new { verifiedOfficialCli = true, cli.Sha256 }));
    return;
}
var root = Path.Combine(Path.GetTempPath(), "codex-account-switcher-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    await Check("account update packages verify content, protocol and revision paths", async () =>
    {
        var source = Path.Combine(root, "update-source");
        var ui = Path.Combine(root, "update-ui.js"); File.WriteAllText(ui, "/* fixture */");
        var manifest = AccountRuntimePackage.Create(source, typeof(BackendService).Assembly.Location, ui, BackendService.Version);
        var packages = new AccountRuntimePackage(Path.Combine(root, "update-store"));
        Assert(packages.Stage(source) == manifest);
        packages.Activate(manifest.Revision, null);
        Assert(packages.ReadPointer()!.Revision == manifest.Revision);
        await Throws<InvalidOperationException>(() => Task.FromResult(packages.DirectoryFor("../escape")));
        AccountRuntimePackage.WriteJson(Path.Combine(source, "manifest.json"), manifest with { WorkerProtocol = 999 });
        await Throws<InvalidOperationException>(() => Task.FromResult(AccountRuntimePackage.Validate(source)));
        AccountRuntimePackage.WriteJson(Path.Combine(source, "manifest.json"), manifest);
        File.AppendAllText(Path.Combine(source, AccountRuntimePackage.UiFile), "tampered");
        await Throws<InvalidOperationException>(() => Task.FromResult(AccountRuntimePackage.Validate(source)));
        Assert(AccountRuntimePackage.Validate(packages.DirectoryFor(manifest.Revision)) == manifest);
    });
    await Check("credit balances preserve zero, unknown and unlimited values", () =>
    {
        Assert(ConnectionProbe.ParseCredits(JsonNode.Parse("{}")) is null);
        Assert(ConnectionProbe.ParseCredits(JsonNode.Parse("""{"rateLimits":{"credits":{"hasCredits":true,"unlimited":false,"balance":"0"}}}"""))?.Balance == "0");
        Assert(ConnectionProbe.ParseCredits(JsonNode.Parse("""{"rateLimitsByLimitId":{"codex":{"credits":{"hasCredits":true,"unlimited":true,"balance":null}}}}""")) is { Unlimited: true, Balance: null });
        return Task.CompletedTask;
    });
    await Check("relay balances parse DeepSeek, OpenRouter and relay responses", () =>
    {
        var deepseek = ConnectionProbe.ParseRelayBalance("deepseek", JsonNode.Parse("""
            {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"27.13","granted_balance":"0.00","topped_up_balance":"27.13"}]}
            """));
        Assert(deepseek is { Balance: "27.13 CNY", HasCredits: true, Unlimited: false });
        var openrouter = ConnectionProbe.ParseRelayBalance("openrouter", JsonNode.Parse("""{"data":{"total_credits":10,"total_usage":2.5}}"""));
        Assert(openrouter is { Balance: "7.5 USD", HasCredits: true });
        var relay = ConnectionProbe.ParseRelayBalance("custom", JsonNode.Parse("""{"isValid":true,"is_active":true,"remaining":17.3789386,"unit":"USD"}"""));
        Assert(relay is { Balance: "17.38 USD", HasCredits: true });
        Assert(ConnectionProbe.ParseRelayBalance("custom", JsonNode.Parse("""{"error":"no balance"}""")) is null);
        return Task.CompletedTask;
    });
    await Check("dedicated store and current-user ACL", async () =>
    {
        var occupied = Path.Combine(root, "occupied");
        Directory.CreateDirectory(occupied); File.WriteAllText(Path.Combine(occupied, "keep"), "keep");
        await Throws<InvalidOperationException>(() => Task.FromResult(new AccountStore(occupied)));
        var store = new AccountStore(Path.Combine(root, "private"));
        var account = store.Create("  Second account  ");
        Assert(account.Name == "Second account" && store.List().Count == 1);
        await Throws<ArgumentException>(() => Task.FromResult(store.Home("../escape")));
        var home = new DirectoryInfo(store.Home(account.Id));
        var rules = home.GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>();
        Assert(rules.All(rule => rule.IdentityReference.Equals(WindowsIdentity.GetCurrent().User)));
        File.WriteAllText(Path.Combine(home.FullName, "auth.json"), "preserved");
        store.Disable(account.Id);
        Assert(store.Get(account.Id).Status == "disabled" && File.ReadAllText(Path.Combine(home.FullName, "auth.json")) == "preserved");
    });
    await Check("official executable baseline and isolated launch", async () =>
    {
        var executable = Environment.ProcessPath!;
        var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(executable)));
        var info = OfficialBackend.LoginStartInfo(executable, hash, root);
        Assert(info.Environment["CODEX_HOME"] == root && info.Environment["CODEX_SQLITE_HOME"] == Path.Combine(root, "sqlite"));
        Assert(!info.Environment.ContainsKey("OPENAI_API_KEY") && !info.Environment.ContainsKey("CODEX_API_KEY"));
        Assert(info.ArgumentList.Contains("cli_auth_credentials_store=\"file\"") && info.CreateNoWindow);
        await Throws<InvalidOperationException>(() => Task.FromResult(OfficialBackend.LoginStartInfo(executable, new string('0', 64), root)));
    });
    await Check("concurrent responses correlate by id", async () =>
    {
        await using var backend = Backend("rpc", root);
        await backend.InitializeAsync();
        var first = backend.RequestAsync("echo", JsonValue.Create("first"));
        var second = backend.RequestAsync("echo", JsonValue.Create("second"));
        Assert((await first)!.GetValue<string>() == "first" && (await second)!.GetValue<string>() == "second");
        try { await backend.RequestAsync("error", null); throw new Exception("Expected RPC error"); }
        catch (BackendRpcException error) { Assert(error.Code == -123 && !error.ToString().Contains("secret-token")); }
    });
    await Check("backend exit fails pending and later requests", async () =>
    {
        await using var backend = Backend("rpc", root);
        await backend.InitializeAsync();
        await Throws<IOException>(() => backend.RequestAsync("exit", null));
        await Throws<IOException>(() => backend.RequestAsync("after-exit", null));
    });
    foreach (var scenario in new[] { "early", "success", "cancel", "failure", "untrusted", "exit-login" })
        await Check("authorization " + scenario, async () =>
        {
            var store = new AccountStore(Path.Combine(root, scenario)); var account = store.Create("Secondary");
            var home = store.Home(account.Id);
            await using var backend = Backend(scenario, home);
            using var stop = new CancellationTokenSource();
            var prompts = 0;
            Task Show(LoginPrompt prompt) { Assert(prompt.AuthUrl.StartsWith("https://auth.openai.com/")); prompts++; if (scenario == "cancel") stop.Cancel(); return Task.CompletedTask; }
            var login = AccountLogin.RunAsync(store, account.Id, backend, Show, stop.Token);
            if (scenario is "early" or "success")
            {
                var result = await login;
                Assert(result.Status == "ready" && result.WorkspaceId == "workspace" && result.Plan == "plus" && prompts == 1);
                Assert(!File.ReadAllText(Path.Combine(Path.GetDirectoryName(home)!, "account.json")).Contains("secret-token"));
            }
            else
            {
                if (scenario == "cancel") await Throws<OperationCanceledException>(() => login);
                else if (scenario == "failure") await Throws<InvalidOperationException>(() => login);
                else if (scenario == "untrusted") await Throws<InvalidDataException>(() => login);
                else await Throws<IOException>(() => login);
                Assert(store.Get(account.Id).Status == "pending");
                if (scenario != "exit-login") Assert(File.Exists(Path.Combine(home, "cancelled")));
                if (scenario == "untrusted") Assert(prompts == 0);
            }
        });
    await Check("CC Switch import selects only the configured Responses provider", () =>
    {
        var config = "model_provider = \"custom\"\nmodel = 'test-model'\n[model_providers.other]\nexperimental_bearer_token = \"wrong-secret\"\n[model_providers.custom]\nbase_url = \"https://relay.example.invalid\" # comment\nwire_api = \"responses\"\n";
        var raw = JsonSerializer.Serialize(new { config, auth = new { OPENAI_API_KEY = "fixture-secret" } });
        var source = CcSwitchImport.Parse("source-1", "Relay", raw)!;
        Assert(source.ApiKey == "fixture-secret" && source.Model == "test-model");
        Assert(!JsonSerializer.Serialize(source).Contains("fixture-secret"));
        Assert(CcSwitchImport.Parse("official", "Official", JsonSerializer.Serialize(new { config, auth = new { tokens = new { access_token = "private-token" } } })) is null);
        return Task.CompletedTask;
    });
    await Check("relay lifecycle preserves credentials and resets a disabled default", async () =>
    {
        var store = new AccountStore(Path.Combine(root, "relay-store"));
        var source = new RelayAccountSource("source", "Relay", "https://relay.example.invalid", "test-model", "fixture-secret");
        var account = store.ImportRelay(source, "https://relay.example.invalid/v1");
        Assert(store.ImportRelay(source, "https://relay.example.invalid/v1").Id == account.Id && store.List().Count == 1);
        await Throws<InvalidOperationException>(() => Task.FromResult(store.ImportRelay(source, "https://other.example.invalid/v1")));
        store.SetDefault(account.Id);
        Assert(store.DefaultAccountId == account.Id);
        store.Disable(account.Id); Assert(store.DefaultAccountId == "primary");
        store.Enable(account.Id); store.Rename(account.Id, "Renamed");
        Assert(store.Get(account.Id).Name == "Renamed" && store.Get(account.Id).Status == "ready");
        Assert(store.DefaultAccountId == "primary");
        await using (var service = new BackendService(store))
        {
            var data = JsonSerializer.Serialize(service.Invoke("list_accounts", new JsonObject()));
            Assert(!data.Contains("fixture-secret") && data.Contains("Renamed"));
            var status = JsonSerializer.SerializeToNode(service.Invoke("status", new JsonObject()))!;
            Assert(!status["routingAvailable"]!.GetValue<bool>() && service.CanStop);
        }
        store.Remove(account.Id);
        Assert(store.List().Count == 0 && File.Exists(Path.Combine(store.Home(account.Id), "credential.json")));
    });
    await Check("connection probe sends only a synthetic request to the configured endpoint", async () =>
    {
        var store = new AccountStore(Path.Combine(root, "relay-probe"));
        var account = store.ImportRelay(new RelayAccountSource("source", "Relay", "https://relay.example.invalid/v1", "test-model", "fixture-secret"), null);
        var handler = new ProbeHttpHandler(request =>
        {
            Assert(request.RequestUri!.AbsoluteUri == "https://relay.example.invalid/v1/responses");
            Assert(request.Headers.Authorization?.Parameter == "fixture-secret");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ACCOUNT_CONNECTION_\"}\n\n" +
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n" +
                "data: {\"type\":\"response.completed\"}\n\n") };
        });
        var result = await ConnectionProbe.RelayAsync(store, account.Id, CancellationToken.None, handler);
        Assert(result.Passed && result.HttpStatus == 200 && !JsonSerializer.Serialize(result).Contains("fixture-secret"));
    });
    await Check("relay balance probe reads the provider endpoint with its credential", async () =>
    {
        var store = new AccountStore(Path.Combine(root, "relay-balance"));
        var account = store.ImportRelay(new RelayAccountSource("source", "Relay", "https://api.deepseek.com", "deepseek-flash", "fixture-secret"), null);
        var handler = new ProbeHttpHandler(request =>
        {
            Assert(request.Method == HttpMethod.Get && request.RequestUri!.AbsoluteUri == "https://api.deepseek.com/user/balance");
            Assert(request.Headers.Authorization?.Parameter == "fixture-secret");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(
                """{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"12.50"}]}""") };
        });
        var credits = await ConnectionProbe.RelayBalanceAsync(store, account.Id, CancellationToken.None, handler);
        Assert(credits is { Balance: "12.5 CNY", HasCredits: true });
        Assert(!JsonSerializer.Serialize(credits).Contains("fixture-secret"));
    });
    await Check("authentication failure exposes no provider response or credential", async () =>
    {
        var store = new AccountStore(Path.Combine(root, "relay-error"));
        var account = store.ImportRelay(new RelayAccountSource("source", "Relay", "https://relay.example.invalid", "test-model", "fixture-secret"), null);
        var handler = new ProbeHttpHandler(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("rejected fixture-secret") });
        var result = await ConnectionProbe.RelayAsync(store, account.Id, CancellationToken.None, handler);
        Assert(!result.Passed && result.ErrorCode == "AUTHENTICATION_FAILED" && !JsonSerializer.Serialize(result).Contains("fixture-secret"));
    });
    await Check("official backend discovery rejects unsigned executables", () =>
    {
        Assert(!OfficialCliLocator.IsOfficial(Environment.ProcessPath!));
        return Task.CompletedTask;
    });
    await Check("saved subscription imports redact tokens and preserve their source", () =>
    {
        var home = Path.Combine(root, "saved-source");
        Directory.CreateDirectory(Path.Combine(home, "auth_accounts"));
        var claims = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(
            "{\"email\":\"saved@example.invalid\",\"https://api.openai.com/auth\":{\"chatgpt_plan_type\":\"plus\"}}")).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var auth = JsonSerializer.Serialize(new { tokens = new { access_token = "private-access-token", refresh_token = "private-refresh",
            id_token = "header." + claims + ".signature", account_id = "saved-workspace" } });
        var source = Path.Combine(home, "auth_accounts", "Saved.json");
        File.WriteAllText(source, auth);
        var found = SavedAccountImport.Read(home).Single();
        Assert(found.Email == "saved@example.invalid" && found.Plan == "plus");
        Assert(!JsonSerializer.Serialize(found).Contains("private-access-token"));
        var store = new AccountStore(Path.Combine(root, "saved-destination"));
        var imported = store.ImportSubscription(found);
        Assert(store.ImportSubscription(found).Id == imported.Id && store.List().Count == 1);
        Assert(File.ReadAllText(source) == auth && imported.WorkspaceId == "saved-workspace");
        return Task.CompletedTask;
    });
    await Check("secondary configuration inherits settings without sharing credentials or state", () =>
    {
        var primary = Path.Combine(root, "config-primary"); var secondary = Path.Combine(root, "config-secondary");
        Directory.CreateDirectory(primary); Directory.CreateDirectory(secondary);
        File.WriteAllText(Path.Combine(primary, "config.toml"), "sandbox_mode=\"read-only\"\n");
        File.WriteAllText(Path.Combine(primary, "AGENTS.md"), "Shared instructions");
        File.WriteAllText(Path.Combine(primary, "auth.json"), "private-auth");
        File.WriteAllText(Path.Combine(primary, ".credentials.json"), "private-mcp-auth");
        RouterBackendFactory.ShareConfiguration(primary, secondary);
        Assert(File.ReadAllText(Path.Combine(secondary, "AGENTS.md")) == "Shared instructions");
        Assert(!File.Exists(Path.Combine(secondary, "auth.json")) && !File.Exists(Path.Combine(secondary, ".credentials.json")));
        File.Delete(Path.Combine(primary, "AGENTS.md"));
        RouterBackendFactory.ShareConfiguration(primary, secondary);
        Assert(!File.Exists(Path.Combine(secondary, "AGENTS.md")));
        return Task.CompletedTask;
    });
    await RouterChecks.RunAsync(root).WaitAsync(TimeSpan.FromSeconds(20));
    await ProviderChecks.RunAsync(root).WaitAsync(TimeSpan.FromSeconds(30));
    await CatalogChecks.RunAsync(root).WaitAsync(TimeSpan.FromSeconds(10));
    await StartupChecks.RunAsync(root).WaitAsync(TimeSpan.FromSeconds(30));
    Console.WriteLine("PASS: account backend and router checks");
}

finally { Directory.Delete(root, true); }

static OfficialBackend Backend(string scenario, string home)
{
    var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in new[] { "--fixture", scenario, home }) start.ArgumentList.Add(argument);
    return new OfficialBackend(start);
}
static void Assert(bool condition) { if (!condition) throw new Exception("Assertion failed"); }
static async Task Throws<T>(Func<Task> action) where T : Exception
{ try { await action().WaitAsync(TimeSpan.FromSeconds(5)); } catch (T) { return; } throw new Exception($"Expected {typeof(T).Name}"); }
static async Task Check(string name, Func<Task> action) { await action().WaitAsync(TimeSpan.FromSeconds(12)); Console.WriteLine("PASS: " + name); }
static async Task Fixture(string scenario, string home)
{
    JsonObject? held = null;
    void Send(JsonObject value) => Console.WriteLine(value.ToJsonString());
    void Reply(JsonObject request, JsonNode? value) => Send(new JsonObject { ["id"] = request["id"]!.DeepClone(), ["result"] = value });
    void Complete(bool success) => Send(new JsonObject { ["method"] = "account/login/completed", ["params"] = new JsonObject { ["loginId"] = "login", ["success"] = success, ["error"] = success ? null : "secret-token" } });
    while (await Console.In.ReadLineAsync() is { } line)
    {
        var request = JsonNode.Parse(line)!.AsObject();
        switch (request["method"]!.GetValue<string>())
        {
            case "initialize": Reply(request, new JsonObject()); break;
            case "initialized": break;
            case "echo":
                if (held == null) held = request;
                else { Reply(request, request["params"]!.DeepClone()); Reply(held, held["params"]!.DeepClone()); held = null; }
                break;
            case "error": Send(new JsonObject { ["id"] = request["id"]!.DeepClone(), ["error"] = new JsonObject { ["code"] = -123, ["message"] = "secret-token" } }); break;
            case "exit": return;
            case "account/login/start":
                Assert(request["params"]!["type"]!.GetValue<string>() == "chatgpt");
                if (scenario == "exit-login") return;
                if (scenario == "early") Complete(true);
                Reply(request, new JsonObject { ["type"] = "chatgpt", ["loginId"] = "login", ["authUrl"] = scenario == "untrusted" ? "https://auth.openai.com.evil.test/authorize" : "https://auth.openai.com/authorize?state=test" });
                if (scenario is "success" or "failure") Complete(scenario == "success");
                break;
            case "account/read":
                File.WriteAllText(Path.Combine(home, "auth.json"), "{\"tokens\":{\"account_id\":\"workspace\",\"access_token\":\"secret-token\"}}");
                Reply(request, new JsonObject { ["account"] = new JsonObject { ["type"] = "chatgpt", ["email"] = "test@example.invalid", ["planType"] = "plus" } });
                break;
            case "account/login/cancel": File.WriteAllText(Path.Combine(home, "cancelled"), "yes"); Reply(request, new JsonObject()); break;
            default: throw new Exception("Unexpected test request");
        }
    }
}
