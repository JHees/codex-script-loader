using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
using CodexScriptLoader.Accounts;

internal static class RouterChecks
{
    public static async Task RunAsync(string root)
    {
        var directory = Path.Combine(root, "router");
        var store = new AccountStore(directory);
        var a = store.ImportRelay(new("a", "A", "https://a.invalid", "model", "private-a"), null);
        var b = store.ImportRelay(new("b", "B", "https://b.invalid", "model", "private-b"), null);
        var ownership = new ThreadOwnership(directory);
        var primary = Path.Combine(directory, "primary"); Directory.CreateDirectory(primary);
        var history = Path.Combine(directory, "history"); Directory.CreateDirectory(history);
        string Home(string id) => id == "primary" ? primary : store.Home(id);
        OfficialBackend Start(string id)
        {
            var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { "--router-fixture", Home(id), history }) info.ArgumentList.Add(arg);
            return new(info);
        }
        await using var router = new AccountRouter(store, ownership, Start, Home);
        var outbound = new ConcurrentQueue<(string? Client, JsonObject Message)>();
        router.Outgoing += (client, message) => outbound.Enqueue((client, message));
        async Task<JsonObject> Request(string client, string method, JsonObject? parameters = null)
            => (await router.HandleAsync(client, new JsonObject { ["id"] = 1, ["method"] = method, ["params"] = parameters ?? new() }))!;
        void Assert(bool value) { if (!value) throw new Exception("Router assertion failed"); }
        await Request("one", "initialize", new JsonObject { ["clientInfo"] = new JsonObject { ["name"] = "fixture", ["version"] = "1" } });
        store.SetDefault(a.Id);
        var created = await Request("one", "thread/start");
        var thread = created["result"]!["thread"]!["id"]!.GetValue<string>();
        var firstTurn = await Request("one", "turn/start", new() { ["threadId"] = thread });
        var empty = await Request("one", "thread/start");
        var emptyThread = empty["result"]!["thread"]!["id"]!.GetValue<string>();
        Assert(!File.Exists(Path.Combine(history, "sessions", emptyThread + ".jsonl")));
        store.SetDefault(b.Id);
        var other = await Request("two", "thread/start");
        var second = other["result"]!["thread"]!["id"]!.GetValue<string>();
        Assert(ownership.Get(thread).AccountId == a.Id && ownership.Get(second).AccountId == b.Id);
        var turns = new[] { firstTurn, await Request("two", "turn/start", new() { ["threadId"] = second }) };
        Assert(turns.All(result => result["id"]!.GetValue<int>() == 1 && result["error"] is null));
        Assert(outbound.Where(item => item.Message["method"]?.GetValue<string>() == "turn/started")
            .All(item => item.Client == (item.Message["params"]!["threadId"]!.GetValue<string>() == thread ? "one" : "two")));
        Assert(!router.CanStop);
        try { await router.SwitchAsync(thread, b.Id); throw new Exception("Busy switch accepted"); }
        catch (InvalidOperationException error) { Assert(error.Message == "THREAD_BUSY"); }
        await router.ReconcileGlobalAsync(CancellationToken.None);
        Assert(ownership.Get(thread).AccountId == a.Id);
        Assert(ownership.Get(emptyThread).AccountId == b.Id);
        Assert(!Directory.Exists(Path.Combine(Home(a.Id), "sessions")) && !Directory.Exists(Path.Combine(Home(b.Id), "sessions")));
        Assert(router.GlobalStatus() is { PendingThreads: 1, BusyThreads: 1, FailedThreads: 0 });
        var deadline = DateTimeOffset.UtcNow.AddSeconds(3);
        while (outbound.Count(item => item.Message["method"]?.GetValue<string>() == "item/commandExecution/requestApproval") < 2 && DateTimeOffset.UtcNow < deadline)
            await Task.Delay(10);
        var requests = outbound.Where(item => item.Message["method"]?.GetValue<string>() == "item/commandExecution/requestApproval").ToArray();
        Assert(requests.Length == 2 && requests[0].Message["id"]!.ToJsonString() != requests[1].Message["id"]!.ToJsonString());
        foreach (var request in requests)
        {
            var response = new JsonObject { ["id"] = request.Message["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "decline" } };
            try { await router.HandleAsync("wrong-client", response); throw new Exception("Cross-client approval accepted"); }
            catch (InvalidOperationException error) { Assert(error.Message == "APPROVAL_NOT_OWNED"); }
            await router.HandleAsync(request.Client!, response);
        }
        await Request("one", "turn/interrupt", new() { ["threadId"] = thread });
        Assert(!router.CanStop);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        Assert(ownership.Get(thread).AccountId == b.Id);
        Assert(new ThreadOwnership(directory).Get(thread).AccountId == b.Id);
        Assert(router.GlobalStatus().PendingThreads == 0);
        Assert(File.ReadAllText(Path.Combine(history, "sessions", thread + ".jsonl")) == "fixture-history");
        File.WriteAllText(Path.Combine(Home(a.Id), "reject-resume"), "yes");
        try { await router.SwitchAsync(thread, a.Id); throw new Exception("Rejected resume accepted"); }
        catch (BackendRpcException) { }
        store.SetDefault(a.Id);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        Assert(router.GlobalStatus().FailedThreads == 2);
        store.SetDefault(b.Id);
        router.RetryGlobalSwitch();
        Assert(ownership.Get(thread).AccountId == b.Id);
        Assert(File.ReadAllText(Path.Combine(history, "sessions", thread + ".jsonl")) == "fixture-history");
        await Request("two", "turn/interrupt", new() { ["threadId"] = second });
        Assert(router.CanStop);
        var resolved = outbound.Where(item => item.Message["method"]?.GetValue<string>() == "serverRequest/resolved").ToArray();
        Assert(resolved.Length == 2 && resolved.All(item => item.Message["params"]!["requestId"]!.GetValue<string>().StartsWith("account-router:")));
        try { Console.Error.WriteLine("LISTTHREADS " + System.Text.Json.JsonSerializer.Serialize(await router.ListThreadsAsync(null, 30, CancellationToken.None))); }
        catch (Exception ex) { Console.Error.WriteLine("LISTTHREADS_FAIL " + ex); }
        var page = await Request("one", "thread/list", new() { ["limit"] = 1 });
        var cursor = page["result"]!["nextCursor"]!.GetValue<string>();
        var next = await Request("one", "thread/list", new() { ["cursor"] = cursor });
        var retry = await Request("one", "thread/list", new() { ["cursor"] = cursor });
        Assert(page["result"]!["data"]!.AsArray().Count == 1 && next["result"]!["data"]!.AsArray().Count == 1);
        Assert(next["result"]!["data"]!.ToJsonString() == retry["result"]!["data"]!.ToJsonString());
        Assert(page["result"]!["data"]![0]!["id"]!.GetValue<string>() != next["result"]!["data"]![0]!["id"]!.GetValue<string>());
        var loaded = await Request("one", "thread/loaded/list", new() { ["limit"] = 1 });
        Assert(loaded["result"]!["data"]!.AsArray().Count == 1);
        Assert((await Request("one", "thread/loaded/list", new() { ["cursor"] = cursor }))["error"] is not null);
        await Request("one", "turn/start", new() { ["threadId"] = thread });
        Assert((await Request("one", "exit", new() { ["threadId"] = thread }))["error"] is not null);
        Assert(router.CanStop);
        Assert((await Request("one", "thread/read", new() { ["threadId"] = thread }))["result"]!["thread"]!["id"]!.GetValue<string>() == thread);
        Assert(ownership.Get(thread).AccountId == b.Id);
        await Request("one", "thread/delete", new() { ["threadId"] = thread });
        var afterDelete = await Request("one", "thread/list");
        Assert(afterDelete["result"]!["data"]!.AsArray().All(item => item!["id"]!.GetValue<string>() != thread));
        var profile = store.SaveProviderConfiguration("Model profile",
            new("custom", "https://model.invalid/v1", "model-v1", 64000, "high"), "fixture-profile-key");
        store.SetDefault(profile.Id);
        var modelCatalog = (await Request("one", "model/list"))["result"]!;
        Assert(modelCatalog["data"]!.AsArray().Count(item => item!["id"]!.GetValue<string>() == AccountRouter.SyntheticModelId(profile.Id, "model-v1")) == 1);
        var profileThread = (await Request("one", "thread/start"))["result"]!["thread"]!["id"]!.GetValue<string>();
        var profileTurn = await Request("one", "turn/start", new()
        {
            ["threadId"] = profileThread, ["effort"] = "ultra",
            ["collaborationMode"] = new JsonObject { ["mode"] = "plan",
                    ["settings"] = new JsonObject { ["model"] = AccountRouter.SyntheticModelId(profile.Id, "model-v1"), ["reasoning_effort"] = "ultra", ["developer_instructions"] = "fixture instructions" } },
        });
        Assert(profileTurn["result"]!["effort"]!.GetValue<string>() == "ultra");
        var collaboration = profileTurn["result"]!["collaborationMode"]!;
        Assert(collaboration["mode"]!.GetValue<string>() == "plan"
            && collaboration["settings"]!["model"]!.GetValue<string>() == "model-v1"
            && collaboration["settings"]!["reasoning_effort"]!.GetValue<string>() == "ultra"
            && collaboration["settings"]!["developer_instructions"]!.GetValue<string>() == "fixture instructions");
        var revised = store.SaveProviderConfiguration("Model profile",
            new("custom", "https://model.invalid/v1", "model-v2", 64000), null, profile.Id);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        Assert(ownership.Get(profileThread).AccountId == profile.Id && router.GlobalStatus().BusyThreads == 1);
        var duringRevision = await Request("one", "thread/list");
        Assert(duringRevision["result"]!["data"]!.AsArray().Any(item => item!["id"]!.GetValue<string>() == profileThread));
        var approval = outbound.Last(item => item.Message["method"]?.GetValue<string>() == "item/commandExecution/requestApproval"
            && item.Message["params"]!["threadId"]!.GetValue<string>() == profileThread);
        await router.HandleAsync("one", new JsonObject { ["id"] = approval.Message["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "decline" } });
        await Request("one", "turn/interrupt", new() { ["threadId"] = profileThread });
        await router.ReconcileGlobalAsync(CancellationToken.None);
        Assert(ownership.Get(profileThread).AccountId == revised.Id);
        Assert(File.ReadAllText(Path.Combine(history, "sessions", profileThread + ".jsonl")) == "fixture-history");
        store.ActivateProviderConfiguration(revised.Id, 1);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        Assert(ownership.Get(profileThread).AccountId == profile.Id);
        Console.WriteLine("PASS: router IDs, scoped approvals and resolution, paging, busy guards, handoff, rollback and same-account recovery");
        Console.WriteLine("PASS: model catalog routing, reasoning override, busy configuration revision, visible history and rollback");
        await CheckEphemeralAsync(root);
        await CheckModelRoutingAsync(root);
        await CheckNativeRouteIsolationAsync(root);
        await CheckCatalogRecoveryAsync(root);
        await CheckChatGptSwitchAsync(root);
    }

    private static async Task CheckEphemeralAsync(string root)
    {
        var directory = Path.Combine(root, "ephemeral-routing");
        var store = new AccountStore(directory);
        var a = store.ImportRelay(new("a", "A", "https://a.invalid", "model", "fixture-a"), null);
        var b = store.ImportRelay(new("b", "B", "https://b.invalid", "model", "fixture-b"), null);
        var ownership = new ThreadOwnership(directory);
        var primary = Path.Combine(directory, "primary"); Directory.CreateDirectory(primary);
        var history = Path.Combine(directory, "history"); Directory.CreateDirectory(history);
        string Home(string id) => id == "primary" ? primary : store.Home(id);
        OfficialBackend Start(string id)
        {
            var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var value in new[] { "--router-fixture", Home(id), history }) start.ArgumentList.Add(value);
            return new(start);
        }
        await using var router = new AccountRouter(store, ownership, Start, Home);
        async Task<JsonObject> Request(string method, JsonObject? parameters = null) =>
            (await router.HandleAsync("ephemeral-client", new() { ["id"] = 1, ["method"] = method, ["params"] = parameters ?? new() }))!;
        await Request("initialize", new() { ["clientInfo"] = new JsonObject { ["name"] = "fixture", ["version"] = "1" } });
        store.SetDefault(a.Id);
        var temporary = (await Request("thread/start", new() { ["ephemeral"] = true }))["result"]!["thread"]!["id"]!.GetValue<string>();
        var persistent = (await Request("thread/start"))["result"]!["thread"]!["id"]!.GetValue<string>();
        store.SetDefault(b.Id);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        if (router.GlobalStatus() is not { PendingThreads: 0, FailedThreads: 0 } || ownership.Get(temporary).AccountId != a.Id || ownership.Get(persistent).AccountId != b.Id)
            throw new Exception("Temporary metadata threads must not fail global account switching");
        if ((await Request("thread/resume", new() { ["threadId"] = temporary }))["error"] is not null)
            throw new Exception("An existing ephemeral thread must stay with its original backend");
        ownership.Set(temporary, new(a.Id));
        await router.ReconcileGlobalAsync(CancellationToken.None);
        if (new ThreadOwnership(directory).AllThreads().Contains(temporary)) throw new Exception("Ephemeral classification must survive restart");
        var pathlessThread = (await Request("thread/start", new() { ["pathless"] = true }))["result"]!["thread"]!["id"]!.GetValue<string>();
        File.WriteAllText(Path.Combine(Home(a.Id), "reject-resume"), "1");
        store.SetDefault(a.Id);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        if (router.GlobalStatus().FailedThreads == 0) throw new Exception("Missing history must report failures without terminating reconciliation");
        File.Delete(Path.Combine(Home(a.Id), "reject-resume"));
        store.SetDefault(b.Id);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        if (router.GlobalStatus().PendingThreads != 0) throw new Exception("Later global changes must still reconcile after a missing-history failure");
        Console.WriteLine("PASS: ephemeral title threads stay pinned while persistent chats switch globally");
    }

    private const string FixtureClient = "router-client";

    private static void Ensure(bool value) { if (!value) throw new Exception("Router assertion failed"); }

    private sealed class RouterHarness : IAsyncDisposable
    {
        private readonly AccountRouter router;
        private readonly Func<string, string> home;
        private readonly string history;
        public ConcurrentQueue<(string? Client, JsonObject Message)> Outbound { get; }
        public RouterHarness(AccountRouter router, Func<string, string> home, string history, ConcurrentQueue<(string? Client, JsonObject Message)> outbound)
        { this.router = router; this.home = home; this.history = history; Outbound = outbound; }
        public AccountRouter Router => router;
        public string Home(string id) => home(id);
        public string HistoryRoot => history;
        public async Task<JsonObject> Request(string method, JsonObject? parameters = null) =>
            (await router.HandleAsync(FixtureClient, new JsonObject { ["id"] = 1, ["method"] = method, ["params"] = parameters ?? new() }))!;
        public async ValueTask DisposeAsync() => await router.DisposeAsync();
    }

    private static async Task<RouterHarness> StartRouterAsync(AccountStore store, ThreadOwnership ownership, string directory, bool primaryOnly = false)
    {
        var primary = Path.Combine(directory, "primary"); Directory.CreateDirectory(primary);
        var history = Path.Combine(directory, "history"); Directory.CreateDirectory(history);
        string Home(string id) => id == "primary" ? primary : store.Home(id);
        OfficialBackend Start(string id)
        {
            var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var argument in new[] { "--router-fixture", Home(id), history }) info.ArgumentList.Add(argument);
            return new(info);
        }
        var router = new AccountRouter(store, ownership, Start, Home, primaryOnly);
        var outbound = new ConcurrentQueue<(string? Client, JsonObject Message)>();
        router.Outgoing += (client, message) => outbound.Enqueue((client, message));
        var harness = new RouterHarness(router, Home, history, outbound);
        await harness.Request("initialize", new JsonObject { ["clientInfo"] = new JsonObject { ["name"] = "fixture", ["version"] = "1" } });
        return harness;
    }

    private static async Task AnswerApprovalAsync(RouterHarness harness, string threadId)
    {
        var approval = harness.Outbound.LastOrDefault(item => item.Message["method"]?.GetValue<string>() == "item/commandExecution/requestApproval"
            && item.Message["params"]?["threadId"]?.GetValue<string>() == threadId);
        if (approval.Message is null) return;
        await harness.Router.HandleAsync(FixtureClient, new JsonObject { ["id"] = approval.Message["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "decline" } });
    }

    private static async Task CheckModelRoutingAsync(string root)
    {
        var directory = Path.Combine(root, "model-routing");
        var store = new AccountStore(directory);
        var ownership = new ThreadOwnership(directory);
        var relay = store.ImportRelay(new("relay", "Relay", "https://relay.invalid", "relay-model", "fixture-relay"), null);
        var other = store.ImportRelay(new("other", "Other", "https://other.invalid", "other-model", "fixture-other"), null);
        var profile = store.SaveProviderConfiguration("DeepSeek", new("deepseek", "https://api.deepseek.com", "deepseek-flash", 1048576, "high", true), "fixture-profile");
        var harness = await StartRouterAsync(store, ownership, directory);
        await using (harness)
        {
            store.SetDefault("primary");
            var models = (await harness.Request("model/list"))["result"]!;
            var entries = models["data"]!.AsArray();
            Ensure(entries.Count(item => item!["isDefault"]?.GetValue<bool>() == true) == 1);
            Ensure(entries.Single(item => item!["id"]!.GetValue<string>() == "codex-fixture")!["isDefault"]!.GetValue<bool>());
            var deepseekId = AccountRouter.SyntheticModelId(profile.Id, "deepseek-flash");
            var relayId = AccountRouter.SyntheticModelId(relay.Id, "relay-model");
            var deepseek = entries.Single(item => item!["id"]!.GetValue<string>() == deepseekId)!;
            Ensure(deepseek["description"]!.GetValue<string>() == "DeepSeek");
            Ensure(deepseek["displayName"]!.GetValue<string>() == "deepseek-flash · DeepSeek" && deepseek["model"]!.GetValue<string>() == deepseekId);
            Ensure(deepseek["isDefault"]!.GetValue<bool>() == false && deepseek["defaultReasoningEffort"]!.GetValue<string>() == "high");
            Ensure(deepseek["supportedReasoningEfforts"]!.AsArray().Select(item => item!["reasoningEffort"]!.GetValue<string>()).SequenceEqual(new[] { "low", "high", "max" }));
            Ensure(deepseek["inputModalities"]!.AsArray().Select(item => item!.GetValue<string>()).SequenceEqual(new[] { "text", "image" }));
            Ensure(entries.Single(item => item!["id"]!.GetValue<string>() == AccountRouter.SyntheticModelId(relay.Id, "relay-model"))!["description"]!.GetValue<string>() == "Relay");
            var first = (await harness.Request("model/list", new() { ["limit"] = 1 }))["result"]!;
            var firstId = first["data"]!.AsArray().Single()!["id"]!.GetValue<string>();
            var cursor = first["nextCursor"]!.GetValue<string>();
            var second = (await harness.Request("model/list", new() { ["cursor"] = cursor }))["result"]!;
            Ensure(second["data"]!.AsArray().Single()!["id"]!.GetValue<string>() != firstId);
            Ensure((await harness.Request("model/list", new() { ["cursor"] = cursor }))["result"]!["data"]!.ToJsonString() == second["data"]!.ToJsonString());
            // A relay default keeps the Codex catalog as the base and marks its own entry as default;
            // the relay backend itself is never asked for the base catalog.
            store.SetDefault(profile.Id);
            File.WriteAllText(Path.Combine(harness.Home(profile.Id), "fail-model-list"), "1");
            var relayDefault = (await harness.Request("model/list"))["result"]!;
            Ensure(relayDefault["data"]!.AsArray().Any(item => item!["id"]!.GetValue<string>() == "codex-fixture"));
            Ensure(relayDefault["data"]!.AsArray().Single(item => item!["id"]!.GetValue<string>() == AccountRouter.SyntheticModelId(profile.Id, "deepseek-flash"))!["isDefault"]!.GetValue<bool>());
            Ensure(relayDefault["data"]!.AsArray().Count(item => item!["isDefault"]?.GetValue<bool>() == true) == 1);
            store.SetDefault("primary");

            // Selecting a relay model starts the thread on that relay without changing the global account.
            var thread = (await harness.Request("thread/start", new() { ["model"] = relayId }))["result"]!["thread"]!["id"]!.GetValue<string>();
            Ensure(ownership.Get(thread) is { Pinned: true } && ownership.Get(thread).AccountId == relay.Id);
            Ensure(store.DefaultAccountId == "primary");
            var start = JsonNode.Parse(File.ReadAllText(Path.Combine(harness.Home(relay.Id), "last-start.json")))!;
            Ensure(start["model"]!.GetValue<string>() == "relay-model");
            Ensure(start["modelProvider"]!.GetValue<string>() == ProviderRuntime.ProviderId(store.Get(relay.Id)));
            var codexThread = (await harness.Request("thread/start", new() { ["model"] = "codex-fixture", ["modelProvider"] = "account_relay" }))["result"]!["thread"]!["id"]!.GetValue<string>();
            Ensure(ownership.Get(codexThread) is { Pinned: false, AccountId: "primary" });
            Ensure(JsonNode.Parse(File.ReadAllText(Path.Combine(harness.Home("primary"), "last-start.json")))!["modelProvider"]!.GetValue<string>() == "openai");

            await harness.Request("turn/start", new() { ["threadId"] = thread, ["model"] = relayId, ["effort"] = "low" });
            var settingsNotification = harness.Outbound.Last(item =>
                item.Message["method"]?.GetValue<string>() == "thread/settings/applied");
            Ensure(settingsNotification.Message["params"]?["thread_settings"]?["model"]?.GetValue<string>() ==
                AccountRouter.SyntheticModelId(relay.Id, "relay-model"));
            // The picker's explicit reasoning effort must win over the provider profile default.
            Ensure(JsonNode.Parse(File.ReadAllText(Path.Combine(harness.Home(relay.Id), "last-turn.json")))!["effort"]!.GetValue<string>() == "low");
            await AnswerApprovalAsync(harness, thread);
            await harness.Request("turn/interrupt", new() { ["threadId"] = thread });
            Ensure(File.Exists(Path.Combine(harness.HistoryRoot, "sessions", thread + ".jsonl")));
            Directory.CreateDirectory(Path.Combine(harness.HistoryRoot, "attachments", thread));
            File.WriteAllText(Path.Combine(harness.HistoryRoot, "attachments", thread, "note.txt"), "fixture-attachment");
            Directory.CreateDirectory(Path.Combine(harness.HistoryRoot, "codex-remote-attachments", thread));
            File.WriteAllText(Path.Combine(harness.HistoryRoot, "codex-remote-attachments", thread, "remote.txt"), "fixture-remote");

            // Requesting a Codex model on a pinned relay thread migrates it back to the desktop account.
            await harness.Request("turn/start", new() { ["threadId"] = thread, ["model"] = "codex-fixture" });
            Ensure(ownership.Get(thread) is { Pinned: false, AccountId: "primary" });
            Ensure(File.Exists(Path.Combine(harness.HistoryRoot, "sessions", thread + ".jsonl")));
            Ensure(File.ReadAllText(Path.Combine(harness.HistoryRoot, "attachments", thread, "note.txt")) == "fixture-attachment");
            Ensure(File.ReadAllText(Path.Combine(harness.HistoryRoot, "codex-remote-attachments", thread, "remote.txt")) == "fixture-remote");
            Ensure(File.ReadAllText(Path.Combine(harness.HistoryRoot, "attachments", thread, "note.txt")) == "fixture-attachment");
            await AnswerApprovalAsync(harness, thread);
            await harness.Request("turn/interrupt", new() { ["threadId"] = thread });

            // Selecting the relay model again migrates back and pins the thread.
            await harness.Request("turn/start", new() { ["threadId"] = thread, ["model"] = relayId });
            Ensure(ownership.Get(thread) is { Pinned: true } && ownership.Get(thread).AccountId == relay.Id);
            await AnswerApprovalAsync(harness, thread);
            await harness.Request("turn/interrupt", new() { ["threadId"] = thread });

            // A native model selected through collaboration settings must leave the relay.
            var nativeThread = (await harness.Request("thread/start", new() { ["model"] = relayId }))["result"]!["thread"]!["id"]!.GetValue<string>();
            await harness.Request("turn/start", new()
            {
                ["threadId"] = nativeThread,
                ["collaborationMode"] = new JsonObject { ["mode"] = "default",
                    ["settings"] = new JsonObject { ["model"] = "codex-fixture" } },
            });
            Ensure(ownership.Get(nativeThread) is { Pinned: false, AccountId: "primary" });
            var nativeTurn = JsonNode.Parse(File.ReadAllText(Path.Combine(harness.Home("primary"), "last-turn.json")))!;
            Ensure(nativeTurn["collaborationMode"]?["settings"]?["model"]?.GetValue<string>() == "codex-fixture");
            await AnswerApprovalAsync(harness, nativeThread);
            await harness.Request("turn/interrupt", new() { ["threadId"] = nativeThread });

            // The desktop can change a chat's model through thread/settings/update before the next turn.
            var settingsThread = (await harness.Request("thread/start", new() { ["model"] = relayId }))["result"]!["thread"]!["id"]!.GetValue<string>();
            Ensure(ownership.Get(settingsThread) is { Pinned: true } && ownership.Get(settingsThread).AccountId == relay.Id);
            await harness.Request("thread/settings/update", new() { ["threadId"] = settingsThread, ["model"] = "codex-fixture", ["effort"] = "high" });
            Ensure(ownership.Get(settingsThread) is { Pinned: false, AccountId: "primary" });
            Ensure(JsonNode.Parse(File.ReadAllText(Path.Combine(harness.Home("primary"), "last-settings.json")))!["model"]!.GetValue<string>() == "codex-fixture");
            await harness.Request("thread/settings/update", new() { ["threadId"] = settingsThread, ["model"] = relayId });
            Ensure(ownership.Get(settingsThread) is { Pinned: true } && ownership.Get(settingsThread).AccountId == relay.Id);
            Ensure(JsonNode.Parse(File.ReadAllText(Path.Combine(harness.Home(relay.Id), "last-settings.json")))!["model"]!.GetValue<string>() == "relay-model");
            await harness.Request("thread/settings/update", new() { ["threadId"] = settingsThread, ["effort"] = "low" });
            Ensure(ownership.Get(settingsThread) is { Pinned: true } && ownership.Get(settingsThread).AccountId == relay.Id);
            Ensure(JsonNode.Parse(File.ReadAllText(Path.Combine(harness.Home(relay.Id), "last-settings.json")))!["effort"]!.GetValue<string>() == "low");

            // Global reconciliation never migrates a pinned thread.
            store.SetDefault(other.Id);
            await harness.Router.ReconcileGlobalAsync(CancellationToken.None);
            Ensure(ownership.Get(thread) is { Pinned: true } && ownership.Get(thread).AccountId == relay.Id);
            Ensure(harness.Router.GlobalStatus() is { PinnedThreads: 2, PendingThreads: 0 });
            Ensure(ownership.Get(codexThread).AccountId == other.Id);

            // An explicit global selection unpins threads that now belong to the new default.
            store.SetDefault(relay.Id);
            harness.Router.RetryGlobalSwitch();
            Ensure(ownership.Get(thread) is { Pinned: false });
            Ensure(harness.Router.GlobalStatus().PinnedThreads == 0);

            // A relay-model chat is model-bound: a global account switch pins it to its
            // relay instead of migrating it (and rewriting its model) to the new account.
            store.SetDefault(relay.Id);
            var unpinnedRelayThread = (await harness.Request("thread/start"))["result"]!["thread"]!["id"]!.GetValue<string>();
            Ensure(!ownership.Get(unpinnedRelayThread).Pinned && ownership.Get(unpinnedRelayThread).AccountId == relay.Id);
            store.SetDefault("primary");
            await harness.Router.ReconcileGlobalAsync(CancellationToken.None);
            Ensure(ownership.Get(unpinnedRelayThread).Pinned && ownership.Get(unpinnedRelayThread).AccountId == relay.Id);

            // A synthetic model nested only in collaborationMode is still a real picker choice.
            var collaborationThread = (await harness.Request("thread/start"))["result"]!["thread"]!["id"]!.GetValue<string>();
            await harness.Request("turn/start", new()
            {
                ["threadId"] = collaborationThread,
                ["collaborationMode"] = new JsonObject { ["mode"] = "default",
                    ["settings"] = new JsonObject { ["model"] = AccountRouter.SyntheticModelId(relay.Id, "relay-model") } },
            });
            Ensure(ownership.Get(collaborationThread).AccountId == relay.Id);
            await AnswerApprovalAsync(harness, collaborationThread);
            await harness.Request("turn/interrupt", new() { ["threadId"] = collaborationThread });

            // A relay model that duplicates a Codex model stays a separate synthetic entry.
            var shadow = store.ImportRelay(new("shadow", "Shadow", "https://shadow.invalid", "codex-fixture", "fixture-shadow"), null);
            var deduped = (await harness.Request("model/list"))["result"]!["data"]!.AsArray();
            Ensure(deduped.Count(item => item!["id"]!.GetValue<string>() == "codex-fixture") == 1);
            Ensure(deduped.Single(item => item!["id"]!.GetValue<string>() == "codex-fixture")!["description"]!.GetValue<string>() == "fixture codex");
            Ensure(deduped.Any(item => item!["id"]!.GetValue<string>() == AccountRouter.SyntheticModelId(shadow.Id, "codex-fixture")));

            // Newer Codex builds can carry the selected model in thread settings.
            var nestedThread = (await harness.Request("thread/start", new() { ["settings"] = new JsonObject { ["model"] = relayId } }))["result"]!["thread"]!["id"]!.GetValue<string>();
            Ensure(ownership.Get(nestedThread) is { Pinned: true } && ownership.Get(nestedThread).AccountId == relay.Id);
        }
        // primaryOnly (account module disabled) must forward model/list paging to the backend.
        var primaryOnlyHarness = await StartRouterAsync(store, new ThreadOwnership(directory), directory, primaryOnly: true);
        await using (primaryOnlyHarness)
        {
            var pageOne = (await primaryOnlyHarness.Request("model/list", new() { ["limit"] = 1 }))["result"]!;
            Ensure(pageOne["data"]!.AsArray().Count == 1);
            var pageCursor = pageOne["nextCursor"]!.GetValue<string>();
            var pageTwo = (await primaryOnlyHarness.Request("model/list", new() { ["limit"] = 1, ["cursor"] = pageCursor }))["result"]!;
            Ensure(pageTwo["data"]!.AsArray().Single()!["id"]!.GetValue<string>() == "codex-extra");
        }
        Console.WriteLine("PASS: model catalog aggregation, model-level routing and pin lifecycle");
    }

    private static async Task CheckChatGptSwitchAsync(string root)
    {
        var directory = Path.Combine(root, "chatgpt-switch");
        var store = new AccountStore(directory);
        var secondary = store.Create("Secondary ChatGPT");
        store.Save(secondary with { Status = "ready", Kind = "chatgpt" });
        var ownership = new ThreadOwnership(directory);
        await using var harness = await StartRouterAsync(store, ownership, directory);
        store.SetDefault("primary");
        var thread = (await harness.Request("thread/start"))["result"]!["thread"]!["id"]!.GetValue<string>();
        await harness.Request("turn/start", new() { ["threadId"] = thread });
        await AnswerApprovalAsync(harness, thread);
        await harness.Request("turn/interrupt", new() { ["threadId"] = thread });
        // Switching to another ChatGPT account moves the idle chat with its history.
        store.SetDefault(secondary.Id);
        await harness.Router.ReconcileGlobalAsync(CancellationToken.None);
        Ensure(ownership.Get(thread).AccountId == secondary.Id && !ownership.Get(thread).Pinned);
        Ensure(File.Exists(Path.Combine(harness.HistoryRoot, "sessions", thread + ".jsonl")));
        Ensure(harness.Router.GlobalStatus() is { PendingThreads: 0, FailedThreads: 0 });
        Console.WriteLine("PASS: switching to another ChatGPT account migrates an idle chat");
    }

    private static async Task CheckNativeRouteIsolationAsync(string root)
    {
        var directory = Path.Combine(root, "native-route-isolation");
        var store = new AccountStore(directory);
        var relay = store.SaveProviderConfiguration("Shadow", new("custom", "https://shadow.invalid", "codex-fixture", 64000,
            Models: [new("codex-fixture", ContextWindow: 64000), new("second-model", ContextWindow: 64000)]), "fixture-only");
        var owners = new ThreadOwnership(directory);
        await using var h = await StartRouterAsync(store, owners, directory);
        store.SetDefault(relay.Id);
        var native = (await h.Request("thread/start", new() { ["model"] = "codex-fixture" }))["result"]!["thread"]!["id"]!.GetValue<string>();
        Ensure(owners.Get(native).AccountId == "primary");
        await h.Request("turn/start", new() { ["threadId"] = native, ["model"] = "codex-fixture" });
        Ensure(owners.Get(native).AccountId == "primary");
        await AnswerApprovalAsync(h, native);
        await h.Request("turn/interrupt", new() { ["threadId"] = native });
        var routedModel = AccountRouter.SyntheticModelId(relay.Id, "second-model");
        var routed = (await h.Request("thread/start", new() { ["model"] = routedModel }))["result"]!["thread"]!["id"]!.GetValue<string>();
        await h.Request("thread/settings/update", new() { ["threadId"] = routed, ["effort"] = "low" });
        var effortOnly = JsonNode.Parse(File.ReadAllText(Path.Combine(h.Home(relay.Id), "last-settings.json")))!;
        Ensure(effortOnly["model"]!.GetValue<string>() == "second-model");
        await h.Request("turn/start", new() { ["threadId"] = routed, ["model"] = routedModel });
        var changed = h.Outbound.Last(item => item.Message["method"]?.GetValue<string>() == "thread/settings/updated").Message["params"]!["settings"]!;
        Ensure(changed["model"]!.GetValue<string>() == routedModel && changed["collaborationMode"]!["settings"]!["model"]!.GetValue<string>() == routedModel);
        var busy = await h.Request("thread/settings/update", new() { ["threadId"] = routed, ["model"] = "codex-fixture" });
        Ensure(busy["error"]?["message"]?.GetValue<string>() == "THREAD_BUSY");
        await AnswerApprovalAsync(h, routed);
        await h.Request("turn/interrupt", new() { ["threadId"] = routed });
        await h.Request("turn/start", new()
        {
            ["threadId"] = routed, ["model"] = routedModel,
            ["collaborationMode"] = new JsonObject { ["mode"] = "default", ["settings"] = new JsonObject { ["model"] = "codex-fixture" } },
        });
        Ensure(owners.Get(routed).AccountId == "primary");
        await AnswerApprovalAsync(h, routed);
        await h.Request("turn/interrupt", new() { ["threadId"] = routed });
        foreach (var model in new[] { "loader/bad", AccountRouter.SyntheticModelId(relay.Id, "not-configured") })
            Ensure((await h.Request("thread/start", new() { ["model"] = model }))["error"]?["message"]?.GetValue<string>() == "MODEL_ROUTE_UNAVAILABLE");
        Console.WriteLine("PASS: native model collisions, collaboration precedence, sticky relay model, current settings notifications and invalid-route rejection");
    }

    private static async Task CheckCatalogRecoveryAsync(string root)
    {
        var directory = Path.Combine(root, "catalog-recovery");
        var store = new AccountStore(directory);
        var ownership = new ThreadOwnership(directory);
        var relay = store.ImportRelay(new("recovery", "Recovery", "https://recovery.invalid", "recovery-model", "fixture-recovery"), null);
        var harness = await StartRouterAsync(store, ownership, directory);
        await using (harness)
        {
            store.SetDefault(relay.Id);
            var thread = (await harness.Request("thread/start"))["result"]!["thread"]!["id"]!.GetValue<string>();
            await harness.Request("turn/start", new() { ["threadId"] = thread });
            await AnswerApprovalAsync(harness, thread);
            await harness.Request("turn/interrupt", new() { ["threadId"] = thread });
            // A catalog read must reach the owning backend instead of migrating the chat globally.
            store.SetDefault("primary");
            await harness.Request("thread/read", new() { ["threadId"] = thread });
            await harness.Request("thread/list");
            Ensure(ownership.Get(thread).AccountId == relay.Id && !ownership.Get(thread).Pinned);
            // The target backend keeps no session row for a migrated rollout; simulate that by hiding
            // the file from thread/list while thread/read can still resolve it.
            Directory.CreateDirectory(Path.Combine(harness.HistoryRoot, "archived_sessions"));
            File.Move(Path.Combine(harness.HistoryRoot, "sessions", thread + ".jsonl"), Path.Combine(harness.HistoryRoot, "archived_sessions", thread + ".jsonl"));
            Directory.CreateDirectory(Path.Combine(harness.Home(relay.Id), "sessions"));
            File.WriteAllLines(Path.Combine(harness.Home(relay.Id), "hidden-threads.txt"), new[] { thread! });
            var active = (await harness.Request("thread/list"))["result"]!["data"]!.AsArray();
            Ensure(active.All(item => item!["id"]!.GetValue<string>() != thread));
            var archived = (await harness.Request("thread/list", new() { ["archived"] = true }))["result"]!["data"]!.AsArray();
            Ensure(archived.Any(item => item!["id"]!.GetValue<string>() == thread));
            var archivedAgain = (await harness.Request("thread/list", new() { ["archived"] = true }))["result"]!["data"]!.AsArray();
            Ensure(archivedAgain.Any(item => item!["id"]!.GetValue<string>() == thread));
            // Recovered threads must not leak into a filtered catalog query such as the Pinned section.
            var pinnedSection = (await harness.Request("thread/list", new()
            {
                ["archived"] = true, ["sectionId"] = "01984de2-8f74-7c91-a3b2-5c5e937cf318",
            }))["result"]!["data"]!.AsArray();
            Ensure(pinnedSection.All(item => item!["id"]!.GetValue<string>() != thread));
            var otherProject = (await harness.Request("thread/list", new() { ["archived"] = true, ["projectId"] = "missing-project" }))["result"]!["data"]!.AsArray();
            Ensure(otherProject.All(item => item!["id"]!.GetValue<string>() != thread));
        }
        Console.WriteLine("PASS: catalog recovery reads migrated threads and honors archive filtering");
    }

    public static async Task FixtureAsync(string home, string history)
    {
        var loaded = new HashSet<string>();
        var ephemeral = new HashSet<string>();
        var pathless = new HashSet<string>();
        var outstanding = new Queue<string>();
        void Send(JsonObject value) => Console.WriteLine(value.ToJsonString());
        void Reply(JsonObject request, JsonNode? value) => Send(new() { ["id"] = request["id"]!.DeepClone(), ["result"] = value });
        JsonObject Thread(string id)
        {
            var archived = File.Exists(Path.Combine(history, "archived_sessions", id + ".jsonl"));
            return new() { ["id"] = id, ["cwd"] = home, ["ephemeral"] = ephemeral.Contains(id), ["path"] = ephemeral.Contains(id) || pathless.Contains(id) ? null : @"\\?\" + Path.Combine(history, archived ? "archived_sessions" : "sessions", id + ".jsonl"), ["status"] = new JsonObject { ["type"] = "idle" }, ["createdAt"] = 1, ["updatedAt"] = 2 };
        }
        while (await Console.In.ReadLineAsync() is { } line)
        {
            var request = JsonNode.Parse(line)!.AsObject();
            var method = request["method"]?.GetValue<string>();
            var id = request["params"]?["threadId"]?.GetValue<string>();
            switch (method)
            {
                case null:
                    if (request["id"]!.GetValue<int>() != 7 || outstanding.Count == 0) throw new Exception("Approval routed incorrectly");
                    var resolvedThread = outstanding.Dequeue();
                    Send(new() { ["method"] = "serverRequest/resolved", ["params"] = new JsonObject
                    { ["threadId"] = resolvedThread, ["requestId"] = 7 } });
                    break;
                case "initialize": Reply(request, new JsonObject()); break;
                case "initialized": break;
                case "config/read": Reply(request, new JsonObject { ["config"] = new JsonObject() }); break;
                case "model/list":
                    if (File.Exists(Path.Combine(home, "fail-model-list")))
                    { Send(new() { ["id"] = request["id"]!.DeepClone(), ["error"] = new JsonObject { ["code"] = -32000, ["message"] = "fixture model failure" } }); break; }
                    var firstModel = new JsonObject { ["id"] = "codex-fixture", ["model"] = "codex-fixture", ["displayName"] = "Codex Fixture", ["description"] = "fixture codex", ["hidden"] = false, ["isDefault"] = true };
                    var secondModel = new JsonObject { ["id"] = "codex-extra", ["model"] = "codex-extra", ["displayName"] = "Codex Extra", ["description"] = "fixture codex", ["hidden"] = false, ["isDefault"] = false };
                    var modelCursor = request["params"]?["cursor"]?.GetValue<string>();
                    var modelLimit = request["params"]?["limit"]?.GetValue<int>();
                    if (modelCursor == "model-page-2")
                        Reply(request, new JsonObject { ["home"] = home, ["data"] = new JsonArray(secondModel.DeepClone()), ["nextCursor"] = null });
                    else if (modelLimit == 1)
                        Reply(request, new JsonObject { ["home"] = home, ["data"] = new JsonArray(firstModel.DeepClone()), ["nextCursor"] = "model-page-2" });
                    else
                        Reply(request, new JsonObject { ["home"] = home, ["data"] = new JsonArray(firstModel.DeepClone(), secondModel.DeepClone()), ["nextCursor"] = null });
                    break;
                case "exit": return;
                case "thread/list":
                    var archivedRequest = request["params"]?["archived"]?.GetValue<bool>() == true;
                    var hiddenFile = Path.Combine(home, "hidden-threads.txt");
                    var hidden = File.Exists(hiddenFile) ? File.ReadAllLines(hiddenFile).ToHashSet(StringComparer.Ordinal) : new HashSet<string>(StringComparer.Ordinal);
                    var historyDir = Path.Combine(history, archivedRequest ? "archived_sessions" : "sessions");
                    var records = Directory.Exists(historyDir)
                        ? Directory.EnumerateFiles(historyDir, "*.jsonl")
                            .Where(path => !hidden.Contains(Path.GetFileNameWithoutExtension(path)))
                            .Select(path =>
                            {
                                var item = Thread(Path.GetFileNameWithoutExtension(path)); item["createdAt"] = 1; item["updatedAt"] = 1; return (JsonNode?)item;
                            }).ToArray() : [];
                    Reply(request, new JsonObject { ["data"] = new JsonArray(records), ["nextCursor"] = null }); break;
                case "thread/start":
                    File.WriteAllText(Path.Combine(home, "last-start.json"), request["params"]?.ToJsonString() ?? "{}");
                    id = Guid.NewGuid().ToString(); loaded.Add(id);
                    if (request["params"]?["ephemeral"]?.GetValue<bool>() == true) ephemeral.Add(id);
                    if (request["params"]?["pathless"]?.GetValue<bool>() == true) pathless.Add(id);
                    Directory.CreateDirectory(Path.Combine(history, "sessions"));
                    Send(new() { ["method"] = "thread/started", ["params"] = new JsonObject { ["thread"] = Thread(id) } });
                    Reply(request, new JsonObject { ["thread"] = Thread(id) }); break;
                case "turn/start":
                    File.WriteAllText(Path.Combine(home, "last-turn.json"), request["params"]?.ToJsonString() ?? "{}");
                    File.WriteAllText(Path.Combine(history, "sessions", id + ".jsonl"), "fixture-history");
                    Send(new() { ["method"] = "turn/started", ["params"] = new JsonObject { ["threadId"] = id } });
                    Send(new() { ["method"] = "thread/settings/applied", ["params"] = new JsonObject
                    {
                        ["threadId"] = id,
                        ["thread_settings"] = new JsonObject
                        {
                            ["model"] = request["params"]?["model"]?.DeepClone(),
                            ["model_provider_id"] = request["params"]?["modelProvider"]?.DeepClone(),
                        },
                    } });
                    Send(new() { ["method"] = "thread/settings/updated", ["params"] = new JsonObject
                    {
                        ["threadId"] = id,
                        ["settings"] = new JsonObject
                        {
                            ["model"] = request["params"]?["model"]?.DeepClone(), ["modelProvider"] = "fixture",
                            ["collaborationMode"] = new JsonObject { ["mode"] = "default", ["settings"] = new JsonObject { ["model"] = request["params"]?["model"]?.DeepClone() } },
                        },
                    } });
                    outstanding.Enqueue(id!);
                    Send(new() { ["id"] = 7, ["method"] = "item/commandExecution/requestApproval", ["params"] = new JsonObject { ["threadId"] = id } });
                    Reply(request, new JsonObject { ["turn"] = new JsonObject { ["id"] = "turn" },
                        ["effort"] = request["params"]?["effort"]?.DeepClone(), ["collaborationMode"] = request["params"]?["collaborationMode"]?.DeepClone() }); break;
                case "turn/interrupt":
                    Send(new() { ["method"] = "turn/completed", ["params"] = new JsonObject { ["threadId"] = id } });
                    Reply(request, new JsonObject()); break;
                case "thread/read": Reply(request, new JsonObject { ["thread"] = Thread(id!) }); break;
                case "thread/archive":
                    File.WriteAllText(Path.Combine(history, "sessions", id + ".jsonl"), "fixture-history");
                    loaded.Remove(id!); Reply(request, new JsonObject()); break;
                case "thread/unarchive": Reply(request, new JsonObject { ["thread"] = Thread(id!) }); break;
                case "thread/delete":
                    File.Delete(Path.Combine(history, "sessions", id + ".jsonl")); loaded.Remove(id!);
                    Send(new() { ["method"] = "thread/deleted", ["params"] = new JsonObject { ["threadId"] = id } });
                    Reply(request, new JsonObject()); break;
                case "thread/unsubscribe":
                    if (!loaded.Remove(id!))
                        Send(new() { ["id"] = request["id"]!.DeepClone(), ["error"] = new JsonObject { ["code"] = -32600, ["message"] = "thread not loaded" } });
                    else Reply(request, new JsonObject { ["status"] = "unsubscribed" });
                    break;
                case "thread/loaded/list": Reply(request, new JsonObject { ["data"] = new JsonArray(loaded.Select(item => (JsonNode?)JsonValue.Create(item)).ToArray()) }); break;
                case "thread/settings/update":
                    File.WriteAllText(Path.Combine(home, "last-settings.json"), request["params"]?.ToJsonString() ?? "{}");
                    Reply(request, new JsonObject()); break;
                case "thread/resume":
                    if (File.Exists(Path.Combine(home, "reject-resume")))
                    { Send(new() { ["id"] = request["id"]!.DeepClone(), ["error"] = new JsonObject { ["code"] = -32600, ["message"] = "fixture failure" } }); break; }
                    loaded.Add(id!); Reply(request, new JsonObject { ["thread"] = Thread(id!) }); break;
                default: throw new Exception("Unexpected router fixture method");
            }
        }
    }
}
