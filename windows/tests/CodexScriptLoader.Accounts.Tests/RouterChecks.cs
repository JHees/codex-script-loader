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
        string Home(string id) => id == "primary" ? primary : store.Home(id);
        OfficialBackend Start(string id)
        {
            var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { "--router-fixture", Home(id) }) info.ArgumentList.Add(arg);
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
        Assert(!File.Exists(Path.Combine(Home(a.Id), "sessions", emptyThread + ".jsonl")));
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
        Assert(File.Exists(Path.Combine(Home(b.Id), "sessions", emptyThread + ".jsonl")));
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
        Assert(File.ReadAllText(Path.Combine(Home(b.Id), "sessions", thread + ".jsonl")) == "fixture-history");
        File.WriteAllText(Path.Combine(Home(a.Id), "reject-resume"), "yes");
        try { await router.SwitchAsync(thread, a.Id); throw new Exception("Rejected resume accepted"); }
        catch (BackendRpcException) { }
        store.SetDefault(a.Id);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        Assert(router.GlobalStatus().FailedThreads == 2);
        store.SetDefault(b.Id);
        router.RetryGlobalSwitch();
        Assert(ownership.Get(thread).AccountId == b.Id);
        Assert(File.ReadAllText(Path.Combine(Home(a.Id), "sessions", thread + ".jsonl")) == "fixture-history");
        await Request("two", "turn/interrupt", new() { ["threadId"] = second });
        Assert(router.CanStop);
        var resolved = outbound.Where(item => item.Message["method"]?.GetValue<string>() == "serverRequest/resolved").ToArray();
        Assert(resolved.Length == 2 && resolved.All(item => item.Message["params"]!["requestId"]!.GetValue<string>().StartsWith("account-router:")));
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
        Assert((await Request("one", "model/list"))["result"]!["home"]!.GetValue<string>() == Home(profile.Id));
        var profileThread = (await Request("one", "thread/start"))["result"]!["thread"]!["id"]!.GetValue<string>();
        var profileTurn = await Request("one", "turn/start", new()
        {
            ["threadId"] = profileThread, ["effort"] = "ultra",
            ["collaborationMode"] = new JsonObject { ["mode"] = "plan",
                ["settings"] = new JsonObject { ["model"] = "previous-model", ["reasoning_effort"] = "ultra", ["developer_instructions"] = "fixture instructions" } },
        });
        Assert(profileTurn["result"]!["effort"]!.GetValue<string>() == "high");
        var collaboration = profileTurn["result"]!["collaborationMode"]!;
        Assert(collaboration["mode"]!.GetValue<string>() == "plan"
            && collaboration["settings"]!["model"]!.GetValue<string>() == "model-v1"
            && collaboration["settings"]!["reasoning_effort"]!.GetValue<string>() == "high"
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
        Assert(File.ReadAllText(Path.Combine(Home(revised.Id), "sessions", profileThread + ".jsonl")) == "fixture-history");
        store.ActivateProviderConfiguration(revised.Id, 1);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        Assert(ownership.Get(profileThread).AccountId == profile.Id);
        Console.WriteLine("PASS: router IDs, scoped approvals and resolution, paging, busy guards, handoff, rollback and same-account recovery");
        Console.WriteLine("PASS: model catalog routing, reasoning override, busy configuration revision, visible history and rollback");
        await CheckEphemeralAsync(root);
    }

    private static async Task CheckEphemeralAsync(string root)
    {
        var directory = Path.Combine(root, "ephemeral-routing");
        var store = new AccountStore(directory);
        var a = store.ImportRelay(new("a", "A", "https://a.invalid", "model", "fixture-a"), null);
        var b = store.ImportRelay(new("b", "B", "https://b.invalid", "model", "fixture-b"), null);
        var ownership = new ThreadOwnership(directory);
        var primary = Path.Combine(directory, "primary"); Directory.CreateDirectory(primary);
        string Home(string id) => id == "primary" ? primary : store.Home(id);
        OfficialBackend Start(string id)
        {
            var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var value in new[] { "--router-fixture", Home(id) }) start.ArgumentList.Add(value);
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
        await Request("thread/start", new() { ["pathless"] = true });
        store.SetDefault(a.Id);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        if (router.GlobalStatus().FailedThreads != 1) throw new Exception("Missing history must report one failure without terminating reconciliation");
        store.SetDefault(b.Id);
        await router.ReconcileGlobalAsync(CancellationToken.None);
        if (router.GlobalStatus().PendingThreads != 0) throw new Exception("Later global changes must still reconcile after a missing-history failure");
        Console.WriteLine("PASS: ephemeral title threads stay pinned while persistent chats switch globally");
    }

    public static async Task FixtureAsync(string home)
    {
        var loaded = new HashSet<string>();
        var ephemeral = new HashSet<string>();
        var pathless = new HashSet<string>();
        var outstanding = new Queue<string>();
        void Send(JsonObject value) => Console.WriteLine(value.ToJsonString());
        void Reply(JsonObject request, JsonNode? value) => Send(new() { ["id"] = request["id"]!.DeepClone(), ["result"] = value });
        JsonObject Thread(string id) => new() { ["id"] = id, ["cwd"] = home, ["ephemeral"] = ephemeral.Contains(id), ["path"] = ephemeral.Contains(id) || pathless.Contains(id) ? null : @"\\?\" + Path.Combine(home, "sessions", id + ".jsonl"), ["status"] = new JsonObject { ["type"] = "idle" } };
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
                case "model/list": Reply(request, new JsonObject { ["home"] = home }); break;
                case "exit": return;
                case "thread/list":
                    var records = Directory.Exists(Path.Combine(home, "sessions"))
                        ? Directory.EnumerateFiles(Path.Combine(home, "sessions"), "*.jsonl").Select(path =>
                        {
                            var item = Thread(Path.GetFileNameWithoutExtension(path)); item["createdAt"] = 1; item["updatedAt"] = 1; return (JsonNode?)item;
                        }).ToArray() : [];
                    Reply(request, new JsonObject { ["data"] = new JsonArray(records), ["nextCursor"] = null }); break;
                case "thread/start":
                    id = Guid.NewGuid().ToString(); loaded.Add(id);
                    if (request["params"]?["ephemeral"]?.GetValue<bool>() == true) ephemeral.Add(id);
                    if (request["params"]?["pathless"]?.GetValue<bool>() == true) pathless.Add(id);
                    Directory.CreateDirectory(Path.Combine(home, "sessions"));
                    Send(new() { ["method"] = "thread/started", ["params"] = new JsonObject { ["thread"] = Thread(id) } });
                    Reply(request, new JsonObject { ["thread"] = Thread(id) }); break;
                case "turn/start":
                    File.WriteAllText(Path.Combine(home, "sessions", id + ".jsonl"), "fixture-history");
                    Send(new() { ["method"] = "turn/started", ["params"] = new JsonObject { ["threadId"] = id } });
                    outstanding.Enqueue(id!);
                    Send(new() { ["id"] = 7, ["method"] = "item/commandExecution/requestApproval", ["params"] = new JsonObject { ["threadId"] = id } });
                    Reply(request, new JsonObject { ["turn"] = new JsonObject { ["id"] = "turn" },
                        ["effort"] = request["params"]?["effort"]?.DeepClone(), ["collaborationMode"] = request["params"]?["collaborationMode"]?.DeepClone() }); break;
                case "turn/interrupt":
                    Send(new() { ["method"] = "turn/completed", ["params"] = new JsonObject { ["threadId"] = id } });
                    Reply(request, new JsonObject()); break;
                case "thread/read": Reply(request, new JsonObject { ["thread"] = Thread(id!) }); break;
                case "thread/archive":
                    File.WriteAllText(Path.Combine(home, "sessions", id + ".jsonl"), "fixture-history");
                    loaded.Remove(id!); Reply(request, new JsonObject()); break;
                case "thread/unarchive": Reply(request, new JsonObject { ["thread"] = Thread(id!) }); break;
                case "thread/delete":
                    File.Delete(Path.Combine(home, "sessions", id + ".jsonl")); loaded.Remove(id!);
                    Send(new() { ["method"] = "thread/deleted", ["params"] = new JsonObject { ["threadId"] = id } });
                    Reply(request, new JsonObject()); break;
                case "thread/unsubscribe":
                    if (!loaded.Remove(id!))
                        Send(new() { ["id"] = request["id"]!.DeepClone(), ["error"] = new JsonObject { ["code"] = -32600, ["message"] = "thread not loaded" } });
                    else Reply(request, new JsonObject { ["status"] = "unsubscribed" });
                    break;
                case "thread/loaded/list": Reply(request, new JsonObject { ["data"] = new JsonArray(loaded.Select(item => (JsonNode?)JsonValue.Create(item)).ToArray()) }); break;
                case "thread/resume":
                    if (File.Exists(Path.Combine(home, "reject-resume")))
                    { Send(new() { ["id"] = request["id"]!.DeepClone(), ["error"] = new JsonObject { ["code"] = -32600, ["message"] = "fixture failure" } }); break; }
                    loaded.Add(id!); Reply(request, new JsonObject { ["thread"] = Thread(id!) }); break;
                default: throw new Exception("Unexpected router fixture method");
            }
        }
    }
}
