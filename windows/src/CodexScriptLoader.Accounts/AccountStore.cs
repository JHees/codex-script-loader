using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace CodexScriptLoader.Accounts;

public sealed record AccountEntry(string Id, string Name, string Status, string? Email = null, string? Plan = null,
    string? WorkspaceId = null, string Kind = "chatgpt", string? BaseUrl = null, string? Model = null,
    string? SourceId = null, DateTimeOffset? LastCheckedAt = null, string? LastError = null, IReadOnlyList<UsageWindow>? Usage = null,
    AccountCredits? Credits = null, string? ConfigurationGroup = null, int ConfigurationVersion = 0, string? Provider = null);

public sealed partial class AccountStore
{
    private const string Marker = ".codex-account-switcher-store";
    private readonly string root;
    public static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    public AccountStore(string directory)
    {
        root = Path.GetFullPath(directory);
        if (root == Path.GetPathRoot(root) || (Directory.Exists(root) && File.GetAttributes(root).HasFlag(FileAttributes.ReparsePoint)))
            throw new InvalidOperationException("The account store must be a dedicated ordinary directory.");
        if (Directory.Exists(root) && Directory.EnumerateFileSystemEntries(root).Any() && !File.Exists(Path.Combine(root, Marker)))
            throw new InvalidOperationException("The selected directory is not an account-switcher store.");
        Directory.CreateDirectory(root);
        var user = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Current Windows identity unavailable.");
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(root).SetAccessControl(security);
        if (!File.Exists(Path.Combine(root, Marker))) File.WriteAllText(Path.Combine(root, Marker), "1\n");
    }

    public string Home(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Invalid account identifier.");
        return Path.Combine(root, "accounts", id, "home");
    }

    private string Metadata(string id) => Path.Combine(Path.GetDirectoryName(Home(id))!, "account.json");

    public AccountEntry Create(string name)
    {
        name = name.Trim();
        if (name.Length is < 1 or > 80 || name.Any(char.IsControl)) throw new ArgumentException("Account name must contain 1–80 characters.");
        var account = new AccountEntry(Guid.NewGuid().ToString("N"), name, "pending");
        Directory.CreateDirectory(Home(account.Id));
        Save(account);
        return account;
    }

    public AccountEntry Get(string id) => JsonSerializer.Deserialize<AccountEntry>(File.ReadAllText(Metadata(id)), JsonOptions)
        ?? throw new InvalidOperationException("Invalid account metadata.");

    public IReadOnlyList<AccountEntry> List(bool includeRemoved = false)
    {
        var accounts = Path.Combine(root, "accounts");
        if (!Directory.Exists(accounts)) return [];
        return Directory.EnumerateDirectories(accounts).Where(path => Guid.TryParseExact(Path.GetFileName(path), "N", out _))
            .Where(path => File.Exists(Path.Combine(path, "account.json")))
            .Select(path => Get(Path.GetFileName(path))).Where(account => includeRemoved || account.Status != "removed" && IsCurrentConfiguration(account))
            .OrderBy(account => account.Name, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public void Save(AccountEntry account)
    {
        WritePrivateJson(Metadata(account.Id), account);
    }

    // Removing a selectable account never deletes its credentials or conversation history.
    public void Disable(string id)
    {
        var wasDefault = DefaultAccountId == id;
        Save(Get(id) with { Status = "disabled" });
        if (wasDefault) SetDefault("primary");
    }

    public void Enable(string id)
    {
        var account = Get(id);
        if (account.Status != "disabled") throw new InvalidOperationException("ACCOUNT_NOT_DISABLED");
        Save(account with { Status = File.Exists(Path.Combine(Home(id), account.Kind == "relay" ? "credential.json" : "auth.json")) ? "ready" : "pending" });
    }

    public void Rename(string id, string name)
    {
        name = name.Trim();
        if (name.Length is < 1 or > 80 || name.Any(char.IsControl)) throw new ArgumentException("ACCOUNT_NAME_INVALID");
        Save(Get(id) with { Name = name });
    }

    public void Remove(string id)
    {
        var wasDefault = DefaultAccountId == id;
        Save(Get(id) with { Status = "removed" });
        if (wasDefault) SetDefault("primary");
    }

    public string DefaultAccountId
    {
        get
        {
            var path = Path.Combine(root, "preferences.json");
            if (!File.Exists(path)) return "primary";
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var id = document.RootElement.GetProperty("defaultAccountId").GetString() ?? "primary";
            if (id == "primary") return id;
            if (!Guid.TryParseExact(id, "N", out _) || !File.Exists(Metadata(id))) return "primary";
            var account = Get(id);
            if (account.ConfigurationGroup is { } group)
            {
                var configuration = ReadProviderGroup(group);
                account = Get(configuration.Versions.Single(version => version.Version == configuration.ActiveVersion).AccountId);
            }
            return account.Status == "ready" ? account.Id : "primary";
        }
    }

    public void SetDefault(string id)
    {
        if (id != "primary" && Get(id).Status != "ready") throw new InvalidOperationException("ACCOUNT_NOT_READY");
        WritePrivateJson(Path.Combine(root, "preferences.json"), new { defaultAccountId = id });
    }

    public AccountEntry ImportRelay(RelayAccountSource source, string? baseUrl)
    {
        var endpoint = RelayAccountSource.ValidateEndpoint(baseUrl ?? source.BaseUrl);
        if (new Uri(endpoint).GetLeftPart(UriPartial.Authority) != new Uri(source.BaseUrl).GetLeftPart(UriPartial.Authority))
            throw new InvalidOperationException("IMPORT_ORIGIN_CHANGED");
        var previous = List().FirstOrDefault(account => account.SourceId == source.Id && account.Kind == "relay");
        if (previous?.ConfigurationGroup is not null) throw new InvalidOperationException("PROVIDER_CONFIGURATION_MANAGED");
        var account = previous ?? Create(source.Name);
        WritePrivateJson(Path.Combine(Home(account.Id), "credential.json"), new { apiKey = source.ApiKey });
        account = account with { Kind = "relay", Status = "ready", BaseUrl = endpoint, Model = source.Model,
            SourceId = source.Id, LastCheckedAt = null, LastError = null };
        Save(account);
        return account;
    }

    public AccountEntry ImportSubscription(SavedAccountSource source)
    {
        var account = List().FirstOrDefault(item => item.SourceId == source.Id ||
            item.Kind == "chatgpt" && source.WorkspaceId is not null && item.WorkspaceId == source.WorkspaceId && item.Email == source.Email)
            ?? Create(source.Name);
        using var auth = JsonDocument.Parse(source.AuthJson);
        WritePrivateJson(Path.Combine(Home(account.Id), "auth.json"), auth.RootElement);
        account = account with { Status = "ready", Kind = "chatgpt", Email = source.Email, Plan = source.Plan,
            WorkspaceId = source.WorkspaceId, SourceId = source.Id, LastCheckedAt = null, LastError = null };
        Save(account);
        return account;
    }

    internal string ReadRelayKey(string id)
    {
        if (Get(id).Kind != "relay") throw new InvalidOperationException("ACCOUNT_TYPE_MISMATCH");
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Home(id), "credential.json")));
        return document.RootElement.GetProperty("apiKey").GetString() ?? throw new InvalidDataException("CREDENTIAL_UNAVAILABLE");
    }

    private static void WritePrivateJson<T>(string path, T value)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, JsonSerializer.Serialize(value, JsonOptions)); File.Move(temporary, path, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public void MarkAuthenticated(string id, JsonElement account)
    {
        if (account.GetProperty("type").GetString() != "chatgpt") throw new InvalidOperationException("A ChatGPT subscription login is required.");
        using var auth = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Home(id), "auth.json")));
        var workspace = auth.RootElement.TryGetProperty("tokens", out var tokens) && tokens.TryGetProperty("account_id", out var value)
            ? value.GetString() : null;
        var emailValue = account.TryGetProperty("email", out var email) ? email.GetString() : null;
        if (workspace is not null && List().Any(item => item.Id != id && item.Kind == "chatgpt" && item.WorkspaceId == workspace && item.Email == emailValue))
            throw new InvalidOperationException("ACCOUNT_ALREADY_EXISTS");
        Save(Get(id) with
        {
            Status = "ready",
            Email = emailValue,
            Plan = account.GetProperty("planType").GetString(), WorkspaceId = workspace
        });
    }
}
