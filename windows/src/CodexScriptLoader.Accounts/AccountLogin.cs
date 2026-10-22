using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record LoginPrompt(string AccountId, string Name, string AuthUrl);

public static class AccountLogin
{
    public static async Task<AccountEntry> RunAsync(AccountStore store, string id, OfficialBackend backend,
        Func<LoginPrompt, Task> showPrompt, CancellationToken cancellation, bool initialized = false)
    {
        var finished = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        string? loginId = null;
        var completions = new Dictionary<string, bool>(StringComparer.Ordinal);
        var sync = new object();
        void OnNotification(JsonObject message)
        {
            if (message["method"]?.GetValue<string>() != "account/login/completed") return;
            var parameters = message["params"];
            if (parameters?["loginId"]?.GetValue<string>() is not { } eventId) return;
            lock (sync)
            {
                var success = parameters["success"]?.GetValue<bool>() == true;
                completions[eventId] = success;
                if (eventId == loginId) finished.TrySetResult(success);
            }
        }
        void OnDisconnected(Exception error) => finished.TrySetException(error);
        backend.Notification += OnNotification;
        backend.Disconnected += OnDisconnected;
        try
        {
            if (!initialized) await backend.InitializeAsync(cancellation);
            var response = await backend.RequestAsync("account/login/start", new JsonObject { ["type"] = "chatgpt" }, cancellation)
                ?? throw new InvalidDataException("No login response.");
            loginId = response["loginId"]!.GetValue<string>();
            var url = response["authUrl"]?.GetValue<string>() ?? "";
            if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme != "https" || parsed.Host != "auth.openai.com"
                || parsed.UserInfo.Length != 0 || parsed.Port != 443)
                throw new InvalidDataException("Unexpected verification origin.");
            lock (sync)
            {
                if (completions.TryGetValue(loginId, out var success)) finished.TrySetResult(success);
            }
            await showPrompt(new(id, store.Get(id).Name, url));
            if (!await finished.Task.WaitAsync(TimeSpan.FromMinutes(15), cancellation)) throw new InvalidOperationException("Account authorization was not completed.");
            var status = await backend.RequestAsync("account/read", new JsonObject { ["refreshToken"] = false }, cancellation);
            if (status?["account"] is not JsonObject account) throw new InvalidOperationException("No authenticated account returned.");
            using var document = JsonDocument.Parse(account.ToJsonString());
            store.MarkAuthenticated(id, document.RootElement);
            return store.Get(id);
        }
        catch
        {
            if (loginId != null)
            {
                try { await backend.RequestAsync("account/login/cancel", new JsonObject { ["loginId"] = loginId }); }
                catch (Exception error) when (error is IOException or BackendRpcException or TimeoutException) { }
            }
            throw;
        }
        finally { backend.Notification -= OnNotification; backend.Disconnected -= OnDisconnected; }
    }
}
