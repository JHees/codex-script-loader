using System.Diagnostics;
using System.Text.Json.Nodes;
using CodexScriptLoader.Accounts;

internal static class StartupChecks
{
    public static async Task RunAsync(string root)
    {
        var previousHome = Environment.GetEnvironmentVariable("CODEX_HOME");
        try
        {
            foreach (var closeBootstrap in new[] { false, true })
            {
                var directory = Path.Combine(root, "startup-" + closeBootstrap);
                var home = Path.Combine(root, "startup-home-" + closeBootstrap);
                Directory.CreateDirectory(home);
                File.WriteAllText(Path.Combine(home, "config.toml"), "sandbox_mode=\"read-only\"\napproval_policy=\"on-request\"\n[features]\nplugins=false\n");
                Environment.SetEnvironmentVariable("CODEX_HOME", home);
                var store = new AccountStore(directory);
                await using var host = new RouterHost(store, directory);
                OfficialBackend Connect(string[] arguments)
                {
                    var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                    foreach (var argument in new[] { "--desktop-cli", directory, "enabled" }.Concat(arguments)) start.ArgumentList.Add(argument);
                    return new OfficialBackend(start);
                }
                // Keep the desktop's four/ten-argument startup pattern without enabling plugin downloads.
                string[] bootstrapArgs = ["-c", "features.code_mode_host=false", "app-server", "--analytics-default-enabled"];
                string[] mainArgs = [.. bootstrapArgs, "-c", "features.prefer_mxc=false",
                    "-c", "model_reasoning_effort=\"high\"", "-c", "model_context_window=64000"];
                await using var bootstrap = Connect(bootstrapArgs);
                await bootstrap.InitializeAsync();
                _ = await bootstrap.RequestAsync("config/read", new JsonObject { ["includeLayers"] = false });
                if (closeBootstrap) await bootstrap.DisposeAsync();
                await using var main = Connect(mainArgs);
                await main.InitializeAsync();
                var config = await main.RequestAsync("config/read", new JsonObject { ["includeLayers"] = false });
                if (config?["config"]?["model_reasoning_effort"]?.GetValue<string>() != "high")
                    throw new InvalidOperationException("Main desktop launch overrides were not applied");
                if (!closeBootstrap) _ = await bootstrap.RequestAsync("config/read", new JsonObject { ["includeLayers"] = false });
                var created = await main.RequestAsync("thread/start", new JsonObject { ["cwd"] = home, ["ephemeral"] = true });
                var threadId = created!["thread"]!["id"]!.GetValue<string>();
                await using var changed = Connect([.. mainArgs, "-c", "model_reasoning_effort=\"low\""]);
                try { await changed.InitializeAsync(); throw new InvalidOperationException("Changed launch settings replaced an attached chat"); }
                catch (IOException) { }
                var retained = await main.RequestAsync("thread/read", new JsonObject { ["threadId"] = threadId });
                if (retained?["thread"]?["id"]?.GetValue<string>() != threadId)
                    throw new InvalidOperationException("Rejected launch change interrupted the existing chat");
                await bootstrap.DisposeAsync();
                await main.DisposeAsync();
                var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
                while (host.Connected && DateTimeOffset.UtcNow < deadline) await Task.Delay(20);
                if (host.Connected) throw new InvalidOperationException("Disconnected desktop left its backend running");
                await using var reopened = Connect([.. mainArgs, "-c", "model_reasoning_effort=\"low\""]);
                await reopened.InitializeAsync();
                var reopenedConfig = await reopened.RequestAsync("config/read", new JsonObject { ["includeLayers"] = false });
                if (reopenedConfig?["config"]?["model_reasoning_effort"]?.GetValue<string>() != "low")
                    throw new InvalidOperationException("A fresh desktop connection retained the retired backend");
            }
        }
        catch (Exception error) { Console.Error.WriteLine("Startup check: " + error.GetType().Name + ": " + error.Message); throw; }
        finally { Environment.SetEnvironmentVariable("CODEX_HOME", previousHome); }
        Console.WriteLine("PASS: bootstrap/main arguments, attached-chat protection and last-client backend shutdown");
    }
}
