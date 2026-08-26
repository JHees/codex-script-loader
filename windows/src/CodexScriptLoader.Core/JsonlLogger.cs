using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Core;

public sealed partial class JsonlLogger : IDisposable
{
    private const long MaxFileBytes = 10 * 1024 * 1024;
    private readonly object sync = new();
    private readonly string logsRoot;
    private StreamWriter? writer;
    private string? currentPath;

    public JsonlLogger(string logsRoot)
    {
        this.logsRoot = Path.GetFullPath(logsRoot);
        Directory.CreateDirectory(this.logsRoot);
        DeleteExpiredLogs();
    }

    public string CurrentPath
    {
        get
        {
            lock (sync)
            {
                EnsureWriter();
                return currentPath!;
            }
        }
    }

    public void Info(string eventName, object? detail = null) => Write("info", eventName, detail);

    public void Warn(string eventName, object? detail = null) => Write("warn", eventName, detail);

    public void Error(string eventName, Exception exception) => Write("error", eventName, new
    {
        type = exception.GetType().Name,
        message = Redact(exception.Message),
    });

    public static string Redact(string value)
    {
        var redacted = EndpointRegex().Replace(value, "[local-endpoint]");
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrWhiteSpace(profile))
        {
            redacted = redacted.Replace(profile, "[user-profile]", StringComparison.OrdinalIgnoreCase);
        }

        return redacted.Length <= 500 ? redacted : redacted[..500];
    }

    private void Write(string level, string eventName, object? detail)
    {
        var line = JsonSerializer.Serialize(new
        {
            at = DateTimeOffset.UtcNow,
            level,
            @event = eventName,
            detail,
        });
        lock (sync)
        {
            EnsureWriter();
            writer!.WriteLine(line);
            writer.Flush();
        }
    }

    private void EnsureWriter()
    {
        var date = DateTime.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var index = 0;
        while (true)
        {
            var name = index == 0 ? $"loader-{date}.jsonl" : $"loader-{date}-{index}.jsonl";
            var path = Path.Combine(logsRoot, name);
            if (!File.Exists(path) || new FileInfo(path).Length < MaxFileBytes)
            {
                if (!string.Equals(path, currentPath, StringComparison.OrdinalIgnoreCase))
                {
                    writer?.Dispose();
                    currentPath = path;
                    writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false));
                }

                return;
            }

            index++;
        }
    }

    private void DeleteExpiredLogs()
    {
        var cutoff = DateTime.UtcNow.AddDays(-7);
        foreach (var file in Directory.EnumerateFiles(logsRoot, "loader-*.jsonl", SearchOption.TopDirectoryOnly))
        {
            try
            {
                if (File.GetLastWriteTimeUtc(file) < cutoff)
                {
                    File.Delete(file);
                }
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    public void Dispose()
    {
        lock (sync)
        {
            writer?.Dispose();
            writer = null;
        }
    }

    [GeneratedRegex(@"\b(?:wss?|https?)://[^\s)]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex EndpointRegex();
}
