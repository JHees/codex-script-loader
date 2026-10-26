using System.Security.Cryptography;
using System.Text;
using CodexScriptLoader.Core;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task TestInstallerUpdateAsync(string testRoot)
    {
        var current = Version.Parse(LiveSupervisor.Version);
        var version = $"{current.Major}.{current.Minor}.{current.Build + 1}";
        var architecture = System.Runtime.InteropServices.RuntimeInformation.RuntimeIdentifier == "win-arm64" ? "arm64" : "x64";
        var name = $"CodexScriptLoader-{version}-windows-{architecture}-setup.exe";
        var uri = $"https://github.com/JHees/codex-script-loader/releases/download/v{version}/{name}";
        var bytes = Encoding.UTF8.GetBytes("MZ fixture installer — never executed");
        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var responses = new Dictionary<string, byte[]>
        {
            [uri] = bytes,
            [uri + ".sha256"] = Encoding.UTF8.GetBytes($"{sha}  {name}\n"),
        };
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "installer-update"));
        paths.EnsureDirectories();
        using var logger = new JsonlLogger(paths.LogsRoot);
        var transport = new FixtureUpdateTransport(new($"v{version}", $"https://github.com/JHees/codex-script-loader/releases/tag/v{version}"), responses);
        var launches = 0;
        string? launchedPath = null;
        await using var manager = new OnlineUpdateManager(paths, logger, (_, _) => throw new InvalidOperationException("Must not hot-swap"),
            hostBaseDirectory: Path.Combine(testRoot, "portable"), updateTransport: transport,
            launchInstaller: (path, _) => { launches++; launchedPath = path; return Task.CompletedTask; });
        await manager.InitializeAsync(CancellationToken.None);
        True(manager.Snapshot.InstallerUpdateSupported, "Native host advertises installer update support");
        await manager.CheckForUpdatesAsync(CancellationToken.None);
        await ThrowsAsync<InvalidOperationException>(() => manager.PrepareInstallerAsync("999.0.0", CancellationToken.None), "Installer download pins the checked version");
        await manager.PrepareInstallerAsync(version, CancellationToken.None);
        True(manager.Snapshot.InstallerReady, "Verified installer is ready for a separate confirmation");
        Equal(0, launches, "Downloading an installer never closes the app or launches it");
        await ThrowsAsync<InvalidOperationException>(() => manager.InstallPreparedAsync(version, false, CancellationToken.None), "Installation requires confirmation");
        await ThrowsAsync<InvalidOperationException>(() => manager.InstallPreparedAsync("999.0.0", true, CancellationToken.None), "Confirmation pins the prepared version");
        Equal(0, launches, "Rejected confirmation cannot launch an installer");
        await manager.PrepareInstallerAsync(version, CancellationToken.None);
        var installer = Path.Combine(paths.StateRoot, "update-cache", name);
        await File.WriteAllTextAsync(installer, "tampered");
        await ThrowsAsync<InvalidDataException>(() => manager.InstallPreparedAsync(version, true, CancellationToken.None), "Installer is rechecked immediately before launch");
        Equal(0, launches, "Tampered installers never launch");
        responses[uri] = Encoding.UTF8.GetBytes("incorrect download");
        await ThrowsAsync<InvalidDataException>(() => manager.PrepareInstallerAsync(version, CancellationToken.None), "Invalid downloaded checksums are rejected");
        True(!manager.Snapshot.InstallerReady, "Failed verification cannot enable installation");
        responses[uri] = bytes;
        await manager.PrepareInstallerAsync(version, CancellationToken.None);
        await manager.InstallPreparedAsync(version, true, CancellationToken.None);
        Equal(1, launches, "Only the verified, confirmed installer reaches the launch callback");
        Equal(installer, launchedPath, "Only the managed cache file is launched");
        await ThrowsAsync<InvalidOperationException>(() => manager.InstallPreparedAsync(version, true, CancellationToken.None), "Confirmation is consumed after launch");
    }
}
