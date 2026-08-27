using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Launcher;

internal static partial class Program
{
    private const int SupportedLauncherProtocol = 1;
    private static readonly Regex VersionPattern = VersionRegex();

    private static int Main(string[] args)
    {
        try
        {
            var root = Path.GetFullPath(AppContext.BaseDirectory);
            var activePath = Path.Combine(root, "active.json");
            var previousPath = Path.Combine(root, "previous.json");
            InstallPointer? active = null;
            string? activeError = null;
            try { active = ReadPointer(activePath); }
            catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException or UnauthorizedAccessException) { activeError = exception.Message; }
            InstallPointer? previous = null;
            string? previousError = "No previous healthy version is installed.";
            try { if (File.Exists(previousPath)) previous = ReadPointer(previousPath); }
            catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException or UnauthorizedAccessException) { previousError = exception.Message; }

            var recoverFirst = active is null || HasIncompleteTransaction(active);
            if (recoverFirst && previous is not null && (active is null || !SameTarget(active, previous)) && TryLaunch(root, previous, args, out previousError))
            {
                WritePointer(activePath, previous);
                return 0;
            }
            if (active is not null && TryLaunch(root, active, args, out activeError))
            {
                return 0;
            }

            if (!recoverFirst && previous is not null && active is not null && !SameTarget(active, previous) && TryLaunch(root, previous, args, out previousError))
            {
                WritePointer(activePath, previous);
                return 0;
            }

            ShowError($"Script-Loader could not start the active version.\n\n{activeError}\n{previousError}");
            return 1;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException or JsonException or ArgumentException)
        {
            ShowError($"Script-Loader launcher could not read the installed version.\n\n{exception.Message}");
            return 1;
        }
    }

    private static bool TryLaunch(string root, InstallPointer pointer, string[] args, out string? error)
    {
        error = null;
        try
        {
            var hostPath = ResolveHostPath(root, pointer);
            if (!File.Exists(hostPath))
            {
                throw new FileNotFoundException("The versioned Loader host is missing.", hostPath);
            }

            var pipeName = $"CodexScriptLoader.launcher-ready.{Environment.ProcessId}.{Guid.NewGuid():N}";
            using var readyPipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            var start = new ProcessStartInfo(hostPath)
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(hostPath)!,
            };
            foreach (var argument in args)
            {
                start.ArgumentList.Add(argument);
            }
            start.ArgumentList.Add("--launcher-ready-pipe");
            start.ArgumentList.Add(pipeName);
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Versioned Loader host did not start.");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
            var ready = WaitForReadyAsync(readyPipe, timeout.Token);
            var exited = process.WaitForExitAsync(timeout.Token);
            var winner = Task.WhenAny(ready, exited).GetAwaiter().GetResult();
            if (winner != ready || !ready.GetAwaiter().GetResult())
            {
                throw new InvalidOperationException(process.HasExited
                    ? $"Versioned Loader host exited with code {process.ExitCode} before reporting healthy."
                    : "Versioned Loader host did not report healthy before the timeout.");
            }

            timeout.Cancel();
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException or InvalidOperationException or TimeoutException or OperationCanceledException)
        {
            error = exception.Message;
            return false;
        }
    }

    private static async Task<bool> WaitForReadyAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
    {
        await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
        using var reader = new StreamReader(pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        return string.Equals(await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false), "healthy", StringComparison.Ordinal);
    }

    private static InstallPointer ReadPointer(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = document.RootElement;
        var pointer = new InstallPointer(
            root.GetProperty("schemaVersion").GetInt32(),
            root.GetProperty("version").GetString() ?? string.Empty,
            root.GetProperty("rid").GetString() ?? string.Empty,
            root.GetProperty("entryPoint").GetString() ?? string.Empty,
            root.GetProperty("launcherProtocol").GetInt32(),
            root.GetProperty("handoffProtocol").GetInt32());
        ValidatePointer(pointer);
        return pointer;
    }

    private static void WritePointer(string path, InstallPointer pointer)
    {
        var temporary = Path.Combine(Path.GetDirectoryName(path)!, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Indented = true }))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schemaVersion", pointer.SchemaVersion);
                writer.WriteString("version", pointer.Version);
                writer.WriteString("rid", pointer.Rid);
                writer.WriteString("entryPoint", pointer.EntryPoint);
                writer.WriteNumber("launcherProtocol", pointer.LauncherProtocol);
                writer.WriteNumber("handoffProtocol", pointer.HandoffProtocol);
                writer.WriteEndObject();
            }
            File.WriteAllBytes(temporary, buffer.ToArray());
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static string ResolveHostPath(string root, InstallPointer pointer)
    {
        ValidatePointer(pointer);
        var versionsRoot = Path.GetFullPath(Path.Combine(root, "versions")).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var versionRoot = Path.GetFullPath(Path.Combine(versionsRoot, pointer.Version, pointer.Rid)).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var hostPath = Path.GetFullPath(Path.Combine(versionRoot, pointer.EntryPoint));
        if (!versionRoot.StartsWith(versionsRoot, StringComparison.OrdinalIgnoreCase) || !hostPath.StartsWith(versionRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Installed Loader path escapes the version directory.");
        }

        return hostPath;
    }

    private static void ValidatePointer(InstallPointer pointer)
    {
        if (pointer.SchemaVersion != 1 || pointer.LauncherProtocol > SupportedLauncherProtocol || pointer.LauncherProtocol <= 0 || pointer.HandoffProtocol <= 0 ||
            !VersionPattern.IsMatch(pointer.Version) || pointer.Rid is not ("win-x64" or "win-arm64") ||
            string.IsNullOrWhiteSpace(pointer.EntryPoint) || Path.IsPathRooted(pointer.EntryPoint) || pointer.EntryPoint.Contains("..", StringComparison.Ordinal))
        {
            throw new InvalidDataException("Installed Loader pointer is invalid or requires a newer launcher.");
        }
    }

    private static bool SameTarget(InstallPointer left, InstallPointer right) =>
        left.Version == right.Version && left.Rid == right.Rid && left.EntryPoint == right.EntryPoint;

    private static bool HasIncompleteTransaction(InstallPointer active)
    {
        try
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var path = Path.Combine(localAppData, "CodexScriptLoader", "state", "update-transaction.json");
            if (!File.Exists(path)) return false;
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            var root = document.RootElement;
            return root.TryGetProperty("state", out var state) && state.GetString() == "switching" &&
                root.TryGetProperty("targetVersion", out var target) && target.GetString() == active.Version;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return true;
        }
    }

    private static void ShowError(string message) => MessageBox(IntPtr.Zero, message, "Codex Script Loader", 0x10);

    [LibraryImport("user32.dll", EntryPoint = "MessageBoxW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int MessageBox(IntPtr window, string text, string caption, uint type);

    [GeneratedRegex("^[0-9]+\\.[0-9]+\\.[0-9]+$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionRegex();

    private sealed record InstallPointer(int SchemaVersion, string Version, string Rid, string EntryPoint, int LauncherProtocol, int HandoffProtocol);
}
