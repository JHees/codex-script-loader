using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Accounts;

public sealed record RelayAccountSource(string Id, string Name, string BaseUrl, string Model, [property: JsonIgnore] string ApiKey)
{
    public static string ValidateEndpoint(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var endpoint) || endpoint.Scheme != "https" ||
            endpoint.UserInfo.Length != 0 || endpoint.Query.Length != 0 || endpoint.Fragment.Length != 0)
            throw new InvalidDataException("ENDPOINT_INVALID");
        return endpoint.AbsoluteUri.TrimEnd('/');
    }
}

public static partial class CcSwitchImport
{
    public static string DatabasePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cc-switch", "cc-switch.db");

    public static IReadOnlyList<RelayAccountSource> Read(string? databasePath = null)
    {
        databasePath ??= DatabasePath;
        if (!File.Exists(databasePath)) return [];
        nint database = 0, statement = 0;
        try
        {
            if (Open(databasePath, out database, 1, 0) != 0) throw new IOException("IMPORT_SOURCE_UNAVAILABLE");
            BusyTimeout(database, 1000);
            if (Prepare(database, "SELECT id,name,settings_config FROM providers WHERE app_type='codex' ORDER BY sort_index", -1, out statement, 0) != 0)
                throw new InvalidDataException("IMPORT_SOURCE_UNSUPPORTED");
            var result = new List<RelayAccountSource>();
            int step;
            while ((step = Step(statement)) == 100)
            {
                if (result.Count >= 64) throw new InvalidDataException("IMPORT_SOURCE_TOO_LARGE");
                var raw = Marshal.PtrToStringUTF8(ColumnText(statement, 2)) ?? "";
                if (raw.Length > 1024 * 1024) throw new InvalidDataException("IMPORT_SOURCE_TOO_LARGE");
                var candidate = Parse(Marshal.PtrToStringUTF8(ColumnText(statement, 0)) ?? "",
                    Marshal.PtrToStringUTF8(ColumnText(statement, 1)) ?? "", raw);
                if (candidate is not null) result.Add(candidate);
            }
            if (step != 101) throw new IOException("IMPORT_SOURCE_BUSY");
            return result;
        }
        finally { if (statement != 0) Finalize(statement); if (database != 0) Close(database); }
    }

    public static RelayAccountSource? Parse(string id, string name, string settingsJson)
    {
        using var document = JsonDocument.Parse(settingsJson);
        var root = document.RootElement;
        if (!root.TryGetProperty("config", out var configValue) || configValue.ValueKind != JsonValueKind.String) return null;
        var config = configValue.GetString()!;
        var provider = ReadString(config, "", "model_provider");
        if (provider is null || !ProviderName().IsMatch(provider)) return null;
        var section = "model_providers." + provider;
        if (ReadString(config, section, "wire_api") != "responses") return null;
        var endpoint = ReadString(config, section, "base_url");
        var model = ReadString(config, "", "model");
        var secret = ReadString(config, section, "experimental_bearer_token");
        if (string.IsNullOrWhiteSpace(secret) && root.TryGetProperty("auth", out var auth) &&
            auth.ValueKind == JsonValueKind.Object && auth.TryGetProperty("OPENAI_API_KEY", out var key) && key.ValueKind == JsonValueKind.String)
            secret = key.GetString();
        if (string.IsNullOrWhiteSpace(endpoint) || string.IsNullOrWhiteSpace(model) || string.IsNullOrWhiteSpace(secret)) return null;
        if (id.Length is < 1 or > 128 || name.Length is < 1 or > 80 || model.Length > 128 || secret.Length > 8192) return null;
        return new RelayAccountSource(id, name, RelayAccountSource.ValidateEndpoint(endpoint), model, secret);
    }

    // Import only quoted scalar fields needed for a Responses account; do not copy unrelated configuration.
    private static string? ReadString(string source, string table, string key)
    {
        var current = "";
        foreach (var rawLine in source.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.StartsWith('['))
            {
                var end = line.IndexOf(']');
                current = end > 0 ? line[1..end].Trim().Replace("\"", "", StringComparison.Ordinal) : "";
                continue;
            }
            if (current != table) continue;
            var match = Scalar().Match(line);
            if (!match.Success || match.Groups[1].Value != key) continue;
            var value = match.Groups[2].Value;
            return value[0] == '\'' ? value[1..^1] : JsonSerializer.Deserialize<string>(value);
        }
        return null;
    }

    [GeneratedRegex("^[a-zA-Z0-9_-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex ProviderName();
    [GeneratedRegex("""^([a-zA-Z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$""", RegexOptions.CultureInvariant)]
    private static partial Regex Scalar();

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_open_v2", CallingConvention = CallingConvention.Cdecl)]
    private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string filename, out nint database, int flags, nint vfs);
    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_prepare_v2", CallingConvention = CallingConvention.Cdecl)]
    private static extern int Prepare(nint database, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, int length, out nint statement, nint tail);
    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_step", CallingConvention = CallingConvention.Cdecl)]
    private static extern int Step(nint statement);
    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_column_text", CallingConvention = CallingConvention.Cdecl)]
    private static extern nint ColumnText(nint statement, int index);
    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_finalize", CallingConvention = CallingConvention.Cdecl)]
    private static extern int Finalize(nint statement);
    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_close", CallingConvention = CallingConvention.Cdecl)]
    private static extern int Close(nint database);
    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_busy_timeout", CallingConvention = CallingConvention.Cdecl)]
    private static extern int BusyTimeout(nint database, int milliseconds);
}
