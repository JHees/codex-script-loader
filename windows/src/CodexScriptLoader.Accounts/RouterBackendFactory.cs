using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace CodexScriptLoader.Accounts;

public sealed class RouterBackendFactory(AccountStore store, OfficialCli cli, string primaryHome,
    string? primarySqliteHome, IReadOnlyList<string> arguments, string? packageFamily)
{
    private readonly string primaryDirectory = new DirectoryInfo(primaryHome).ResolveLinkTarget(true)?.FullName ?? Path.GetFullPath(primaryHome);
    public string Home(string id) => id == "primary" ? primaryDirectory : store.Home(id);

    public OfficialBackend Start(string id) => new(CreateStartInfo(id));

    public ProcessStartInfo CreateStartInfo(string id)
    {
        var home = Home(id);
        if (id != "primary") ShareConfiguration(primaryDirectory, home);
        var start = OfficialBackend.LoginStartInfo(cli.Executable, cli.Sha256, home);
        start.ArgumentList.Clear();
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        if (packageFamily is not null) start.Environment["CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY"] = packageFamily;
        foreach (var key in new[] { "CODEX_SCRIPT_LOADER_ACCOUNTS", "CODEX_ACCOUNT_ROUTER_CONNECTION", "CODEX_SCRIPT_LOADER_CLI_DESCRIPTOR", "CODEX_APP_SERVER_WS_URL", "CODEX_APP_SERVER_FORCE_CLI", AccountBackendHost.WorkerAssemblyVariable, AccountBackendHost.CommandVariable })
            start.Environment.Remove(key);
        if (id == "primary")
        {
            foreach (var key in new[] { "OPENAI_API_KEY", "CODEX_API_KEY" })
                if (Environment.GetEnvironmentVariable(key) is { } value) start.Environment[key] = value;
            if (primarySqliteHome is not null) start.Environment["CODEX_SQLITE_HOME"] = primarySqliteHome;
            else start.Environment.Remove("CODEX_SQLITE_HOME");
            return start;
        }
        // Append overrides after desktop arguments so a desktop keyring setting cannot defeat isolation.
        foreach (var option in new[] { "cli_auth_credentials_store=\"file\"", "mcp_oauth_credentials_store=\"file\"",
            "thread_unload_delay_secs=1", "sqlite_home=" + JsonSerializer.Serialize(Path.Combine(home, "sqlite")),
            "log_dir=" + JsonSerializer.Serialize(Path.Combine(home, "logs")) })
        { start.ArgumentList.Add("-c"); start.ArgumentList.Add(option); }
        var account = store.Get(id);
        if (account.Kind == "relay")
        {
            var profile = store.ReadProviderSettings(id);
            var settings = profile is not null ? ProviderRuntime.Overrides(account, profile, home) : new[]
            {
                "model_provider=\"account_relay\"", "model=" + JsonSerializer.Serialize(account.Model),
                "model_providers.account_relay.name=\"Account relay\"",
                "model_providers.account_relay.base_url=" + JsonSerializer.Serialize(account.BaseUrl),
                "model_providers.account_relay.wire_api=\"responses\"",
                "model_providers.account_relay.env_key=\"ACCOUNT_SWITCHER_RELAY_KEY\"",
                "model_providers.account_relay.requires_openai_auth=false",
            };
            foreach (var option in settings) { start.ArgumentList.Add("-c"); start.ArgumentList.Add(option); }
            start.Environment["ACCOUNT_SWITCHER_RELAY_KEY"] = store.ReadRelayKey(id);
        }
        return start;
    }

    public static void ShareConfiguration(string primaryHome, string destination)
    {
        var source = Path.Combine(primaryHome, "config.toml");
        var target = Path.Combine(destination, "config.toml");
        if (File.Exists(target) && File.GetAttributes(target).HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("CONFIGURATION_LINK_UNSUPPORTED");
        if (File.Exists(source)) File.Copy(source, target, true);
        else if (File.Exists(target)) File.Delete(target);
        var instructions = Path.Combine(primaryHome, "AGENTS.md");
        var targetInstructions = Path.Combine(destination, "AGENTS.md");
        if (File.Exists(targetInstructions) && File.GetAttributes(targetInstructions).HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("CONFIGURATION_LINK_UNSUPPORTED");
        if (File.Exists(instructions)) File.Copy(instructions, targetInstructions, true);
        else if (File.Exists(targetInstructions)) File.Delete(targetInstructions);
    }
}
