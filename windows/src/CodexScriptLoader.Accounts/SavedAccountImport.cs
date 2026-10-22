using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace CodexScriptLoader.Accounts;

public sealed record SavedAccountSource(string Id, string Name, string? Email, string? Plan, string? WorkspaceId,
    [property: JsonIgnore] string AuthJson)
{
    public string Kind => "chatgpt";
    public string Model => "订阅账号";
}

public static class SavedAccountImport
{
    public static IReadOnlyList<SavedAccountSource> Read(string? home = null)
    {
        home ??= Environment.GetEnvironmentVariable("CODEX_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        var directory = Path.Combine(home, "auth_accounts");
        if (!Directory.Exists(directory)) return [];
        var result = new List<SavedAccountSource>();
        foreach (var file in new DirectoryInfo(directory).EnumerateFiles("*.json"))
        {
            if (file.Length > 1024 * 1024 || file.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
            try
            {
                var auth = File.ReadAllText(file.FullName);
                if (JsonNode.Parse(auth)?["tokens"] is not JsonObject tokens ||
                    string.IsNullOrWhiteSpace(tokens["access_token"]?.GetValue<string>())) continue;
                JsonObject? claims = null;
                if (tokens["id_token"]?.GetValue<string>()?.Split('.') is { Length: 3 } parts)
                {
                    var payload = parts[1].Replace('-', '+').Replace('_', '/');
                    payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
                    claims = JsonNode.Parse(Convert.FromBase64String(payload))?.AsObject();
                }
                var id = "saved:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(file.Name)));
                result.Add(new(id, Path.GetFileNameWithoutExtension(file.Name), claims?["email"]?.GetValue<string>(),
                    (claims?["https://api.openai.com/auth"] as JsonObject)?["chatgpt_plan_type"]?.GetValue<string>(),
                    tokens["account_id"]?.GetValue<string>(), auth));
            }
            catch (Exception error) when (error is System.Text.Json.JsonException or FormatException or InvalidOperationException) { }
        }
        return result;
    }
}
