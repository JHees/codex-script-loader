using System.IO.Compression;
using System.Text;
using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static class Program
{
    private static int passed;

    private static async Task<int> Main()
    {
        var testRoot = Path.Combine(Path.GetTempPath(), $"codex-loader-tests-{Guid.NewGuid():N}");
        try
        {
            await TestDescriptorAndInjectionAsync(testRoot);
            await TestInvalidConfigForcesSafeModeAsync(testRoot);
            await TestQuarantineRoundTripAsync(testRoot);
            await TestPluginManagementAsync(testRoot);
            await TestArchiveSafetyAsync(testRoot);
            TestPathBoundary(testRoot);
            TestPackageProcessTerminationBoundary();
            TestLogRedaction(testRoot);
            await TestAtomicUpdateStateAsync(testRoot);
            await TestUpdatePackageVerificationAsync(testRoot);
            await TestOnlineUpdatePipelineAsync(testRoot);
            TestUpdateTrustBoundaries();
            await TestSingleInstanceLockTransferAsync(testRoot);
            Console.WriteLine($"PASS {passed} tests");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"FAIL {exception}");
            return 1;
        }
        finally
        {
            if (Directory.Exists(testRoot))
            {
                Directory.Delete(testRoot, recursive: true);
            }
        }
    }

    private static async Task TestDescriptorAndInjectionAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "healthy"));
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        await registry.EnsureBundledScriptAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "bennett-ui-improvements"));
        var plan = await registry.BuildPlanAsync(force: true);
        Equal(1, plan.Scripts.Count, "Bundled script count");
        Equal("co.bennett.ui-improvements", plan.Scripts[0].Id, "Bundled script id");
        True(plan.Source.Contains("runtime.runtimeVersion = \"0.5.2\"", StringComparison.Ordinal), "Runtime version source");
        True(plan.Source.Contains("__bennettUiImprovementsBigPizza", StringComparison.Ordinal), "Lifecycle source");
        True(plan.Source.Contains("installSettingsHost", StringComparison.Ordinal), "Settings host source");
        True(plan.Source.Contains("sha256-" + plan.Scripts[0].Fingerprint, StringComparison.Ordinal), "Integrity source");
        Equal("page", plan.Scripts[0].SettingsMode, "Bundled settings declaration");
        Equal("README.md", plan.Scripts[0].Documentation, "Bundled documentation declaration");
    }

    private static async Task TestInvalidConfigForcesSafeModeAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "invalid-config"));
        paths.EnsureDirectories();
        await File.WriteAllTextAsync(paths.ConfigPath, "{\"schemaVersion\":2}");
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        await registry.EnsureBundledScriptAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "bennett-ui-improvements"));
        var plan = await registry.BuildPlanAsync(force: true);
        True(plan.SafeMode, "Invalid config safe mode");
        Equal(0, plan.Scripts.Count, "Safe mode script count");
    }

    private static async Task TestQuarantineRoundTripAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "quarantine"));
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        await CreateTestPluginAsync(paths, "local.removable");
        var quarantined = await registry.QuarantineAsync("local.removable");
        True(!Directory.Exists(Path.Combine(paths.ScriptsRoot, quarantined.ScriptId)), "Quarantine removes installed path");
        Equal(1, (await registry.ListQuarantinedAsync()).Count, "Quarantine list count");
        var plan = await registry.BuildPlanAsync(force: true);
        Equal(0, plan.Scripts.Count, "Quarantined script is isolated");
        var restored = await registry.RestoreQuarantinedAsync(quarantined.Key);
        Equal(quarantined.ScriptId, restored.ScriptId, "Restored script id");
        Equal(1, (await registry.BuildPlanAsync(force: true)).Scripts.Count, "Restored script returns to plan");
    }

    private static async Task TestPluginManagementAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "management"));
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        await registry.EnsureBundledScriptAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "bennett-ui-improvements"));
        Throws<InvalidOperationException>(() => registry.QuarantineAsync("co.bennett.ui-improvements").GetAwaiter().GetResult(), "Bundled plugin removal rejected");
        var bundled = (await registry.ListPluginsAsync()).Single();
        True(bundled.Bundled, "Bundled plugin marker");
        True(!bundled.Legacy, "Bundled plugin follows current contract");
        await registry.SetEnabledAsync(bundled.Id, false);
        Equal(0, (await registry.BuildPlanAsync(force: false)).Scripts.Count, "Disabled plugin leaves injection plan");
        await registry.SetEnabledAsync(bundled.Id, true);
        Equal(1, (await registry.BuildPlanAsync(force: false)).Scripts.Count, "Enabled plugin returns to injection plan");

        var source = Path.Combine(testRoot, "install-source");
        var sourcePaths = LoaderPaths.FromRoot(source);
        sourcePaths.EnsureDirectories();
        await CreateTestPluginAsync(sourcePaths, "local.installable");
        var preview = await registry.StagePackageAsync(Path.Combine(sourcePaths.ScriptsRoot, "local.installable"), archive: false);
        Equal("local.installable", preview.Id, "Install preview id");
        var installed = await registry.InstallPendingAsync(preview.Token, enabled: false);
        Equal("disabled", installed.Status, "Installed plugin disabled state");
    }

    private static async Task CreateTestPluginAsync(LoaderPaths paths, string id)
    {
        paths.EnsureDirectories();
        var directory = Path.Combine(paths.ScriptsRoot, id);
        Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(Path.Combine(directory, "manifest.json"), $$"""
        {
          "schemaVersion": 1,
          "id": "{{id}}",
          "name": "Test plugin",
          "version": "1.0.0",
          "main": "index.js",
          "scope": "renderer",
          "runAt": "document-start",
          "documentation": "README.md",
          "settings": { "mode": "none" },
          "permissions": []
        }
        """);
        await File.WriteAllTextAsync(Path.Combine(directory, "index.js"), "module.exports = { start() {}, stop() {} };\n");
        await File.WriteAllTextAsync(Path.Combine(directory, "README.md"), "# Test plugin\n");
    }

    private static async Task TestArchiveSafetyAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "archive-safety"));
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        var archivePath = Path.Combine(testRoot, "traversal.zip");
        using (var archive = ZipFile.Open(archivePath, ZipArchiveMode.Create))
        {
            var entry = archive.CreateEntry("../escape.txt");
            await using var writer = new StreamWriter(entry.Open());
            await writer.WriteAsync("escape");
        }

        Throws<InvalidDataException>(() => registry.StagePackageAsync(archivePath, archive: true).GetAwaiter().GetResult(), "ZIP traversal rejected");
        True(!File.Exists(Path.Combine(testRoot, "escape.txt")), "ZIP traversal wrote no file");
    }

    private static void TestPathBoundary(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "paths"));
        var inside = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, "script"), "test");
        True(inside.EndsWith("script", StringComparison.Ordinal), "Inside path accepted");
        Throws<InvalidOperationException>(() => paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, "..", "escape"), "test"), "Escaping path rejected");
    }

    private static void TestPackageProcessTerminationBoundary()
    {
        var nonexistentFamily = $"CodexScriptLoader.Tests_{Guid.NewGuid():N}";
        var result = ProcessIdentity.TerminateProcessesByPackageFamily(nonexistentFamily);
        Equal(0, result.MatchedProcessIds.Count, "Unknown package family matches no processes");
        Equal(0, result.TerminatedProcessIds.Count, "Unknown package family terminates no processes");
        Equal(0, result.FailureCodes.Count, "Unknown package family reports no termination failures");
    }

    private static void TestLogRedaction(string testRoot)
    {
        var logs = Path.Combine(testRoot, "logs");
        using var logger = new JsonlLogger(logs);
        logger.Info("test", new { value = "ok" });
        True(File.Exists(logger.CurrentPath), "JSONL log created");
        True(JsonlLogger.Redact("ws://127.0.0.1:9229/devtools/page/secret") == "[local-endpoint]", "Endpoint redacted");
        using var stream = new FileStream(logger.CurrentPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        using var document = JsonDocument.Parse(reader.ReadLine() ?? throw new InvalidDataException("JSONL log is empty."));
        Equal("test", document.RootElement.GetProperty("event").GetString(), "JSONL event");
    }

    private static async Task TestAtomicUpdateStateAsync(string testRoot)
    {
        var path = Path.Combine(testRoot, "atomic", "preferences.json");
        await AtomicJsonFile.WriteAsync(path, new UpdatePreferences());
        var preferences = await AtomicJsonFile.ReadAsync<UpdatePreferences>(path);
        True(preferences is { SchemaVersion: 1, AutoUpdate: true, Channel: "stable" }, "Default update preferences round trip");
        await AtomicJsonFile.WriteAsync(path, new UpdatePreferences(AutoUpdate: false));
        Equal(false, (await AtomicJsonFile.ReadAsync<UpdatePreferences>(path))!.AutoUpdate, "Atomic update preference replacement");
    }

    private static async Task TestUpdatePackageVerificationAsync(string testRoot)
    {
        var source = Path.Combine(testRoot, "update-source");
        var host = Path.Combine(source, "versions", "0.5.1", "win-x64");
        Directory.CreateDirectory(host);
        await File.WriteAllTextAsync(Path.Combine(source, "CodexScriptLoader.exe"), "launcher");
        await File.WriteAllTextAsync(Path.Combine(source, "active.json"), "{}");
        await File.WriteAllTextAsync(Path.Combine(host, "CodexScriptLoader.exe"), "candidate-host");
        var prefix = Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var files = new List<UpdateManifestFile>();
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
        {
            files.Add(new UpdateManifestFile(
                Path.GetFullPath(file)[prefix.Length..].Replace(Path.DirectorySeparatorChar, '/'),
                new FileInfo(file).Length,
                await UpdatePackageVerifier.ComputeSha256Async(file)));
        }
        var manifest = new UpdateManifest(1, "0.5.1", "win-x64", "versions/0.5.1/win-x64/CodexScriptLoader.exe", 1, 1, files);
        await AtomicJsonFile.WriteAsync(Path.Combine(source, "update-manifest.json"), manifest);
        var archivePath = Path.Combine(testRoot, "update.zip");
        ZipFile.CreateFromDirectory(source, archivePath);
        var archiveHash = await UpdatePackageVerifier.ComputeSha256Async(archivePath);
        var extracted = Path.Combine(testRoot, "update-extracted");
        var verified = await UpdatePackageVerifier.VerifyAndExtractAsync(archivePath, extracted, "0.5.1", "win-x64", archiveHash);
        Equal("0.5.1", verified.Version, "Update package version verified");
        True(File.Exists(Path.Combine(extracted, "versions", "0.5.1", "win-x64", "CodexScriptLoader.exe")), "Update package extracted safely");
        Throws<InvalidDataException>(() => UpdatePackageVerifier.ValidateManifest(manifest with { EntryPoint = "CodexScriptLoader.exe" }, "0.5.1", "win-x64"), "Update manifest alternate entry point rejected");
        Throws<InvalidDataException>(() => UpdatePackageVerifier.VerifyAndExtractAsync(archivePath, Path.Combine(testRoot, "bad-hash"), "0.5.1", "win-x64", new string('0', 64)).GetAwaiter().GetResult(), "Update archive bad hash rejected");
        Throws<InvalidDataException>(() => UpdatePackageVerifier.VerifyAndExtractAsync(archivePath, Path.Combine(testRoot, "bad-rid"), "0.5.1", "win-arm64", archiveHash).GetAwaiter().GetResult(), "Update archive wrong architecture rejected");

        var traversalArchive = Path.Combine(testRoot, "update-traversal.zip");
        using (var archive = ZipFile.Open(traversalArchive, ZipArchiveMode.Create))
        {
            archive.CreateEntry("../escape.exe");
        }
        var traversalHash = await UpdatePackageVerifier.ComputeSha256Async(traversalArchive);
        Throws<InvalidDataException>(() => UpdatePackageVerifier.VerifyAndExtractAsync(traversalArchive, Path.Combine(testRoot, "update-traversal"), "0.5.1", "win-x64", traversalHash).GetAwaiter().GetResult(), "Update ZIP traversal rejected");
    }

    private static void TestUpdateTrustBoundaries()
    {
        UpdatePackageVerifier.ValidateDownloadUri(new Uri("https://github.com/JHees/codex-script-loader/releases/download/v0.5.1/test.zip"));
        Throws<InvalidDataException>(() => UpdatePackageVerifier.ValidateDownloadUri(new Uri("http://github.com/JHees/codex-script-loader/test.zip")), "Non-HTTPS update rejected");
        Throws<InvalidDataException>(() => UpdatePackageVerifier.ValidateDownloadUri(new Uri("https://example.com/test.zip")), "Unofficial update host rejected");
        var checksum = new string('a', 64);
        Equal(checksum, UpdatePackageVerifier.ReadUniqueSha256($"{checksum}  package.zip\n", "package.zip"), "Unique release checksum parsed");
        Throws<InvalidDataException>(() => UpdatePackageVerifier.ReadUniqueSha256($"{checksum}  package.zip\n{checksum}  package.zip\n", "package.zip"), "Duplicate release checksum rejected");
        True(VersionedInstallLayout.CompareVersions("0.5.1", "0.5.0") > 0, "Upgrade version accepted");
        True(VersionedInstallLayout.CompareVersions("0.5.0", "0.5.0") == 0, "Same version identified");
        True(VersionedInstallLayout.CompareVersions("0.4.9", "0.5.0") < 0, "Downgrade identified");
        OnlineUpdateManager.ValidateRelease(new GitHubReleaseInfo("v0.5.1", "https://github.com/JHees/codex-script-loader/releases/tag/v0.5.1"));
        Throws<InvalidDataException>(() => OnlineUpdateManager.ValidateRelease(new GitHubReleaseInfo("v0.5.1", "https://github.com/other/repository/releases/tag/v0.5.1")), "Wrong release repository rejected");
        Throws<InvalidDataException>(() => OnlineUpdateManager.ValidateRelease(new GitHubReleaseInfo("v0.5.1-beta", "https://github.com/JHees/codex-script-loader/releases/tag/v0.5.1-beta")), "Prerelease-style tag rejected");
    }

    private static async Task TestOnlineUpdatePipelineAsync(string testRoot)
    {
        const string nextVersion = "0.5.3";
        var fixtureRoot = Path.Combine(testRoot, "online-update");
        var installRoot = Path.Combine(fixtureRoot, "install");
        var currentHostRoot = Path.Combine(installRoot, "versions", LiveSupervisor.Version, "win-x64");
        Directory.CreateDirectory(currentHostRoot);
        await File.WriteAllTextAsync(Path.Combine(installRoot, ".codex-script-loader-install"), "fixture");
        var source = Path.Combine(fixtureRoot, "source");
        var nextHost = Path.Combine(source, "versions", nextVersion, "win-x64");
        Directory.CreateDirectory(nextHost);
        await File.WriteAllTextAsync(Path.Combine(source, "CodexScriptLoader.exe"), "launcher");
        await File.WriteAllTextAsync(Path.Combine(source, "active.json"), "{}");
        await File.WriteAllTextAsync(Path.Combine(source, "previous.json"), "{}");
        await File.WriteAllTextAsync(Path.Combine(nextHost, "CodexScriptLoader.exe"), "candidate-host");
        var prefix = Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var files = new List<UpdateManifestFile>();
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
        {
            files.Add(new UpdateManifestFile(
                Path.GetFullPath(file)[prefix.Length..].Replace(Path.DirectorySeparatorChar, '/'),
                new FileInfo(file).Length,
                await UpdatePackageVerifier.ComputeSha256Async(file)));
        }
        var manifest = new UpdateManifest(1, nextVersion, "win-x64", $"versions/{nextVersion}/win-x64/CodexScriptLoader.exe", 1, 1, files);
        await AtomicJsonFile.WriteAsync(Path.Combine(source, "update-manifest.json"), manifest);
        var archiveName = $"CodexScriptLoader-{nextVersion}-windows-x64.zip";
        var archive = Path.Combine(fixtureRoot, archiveName);
        ZipFile.CreateFromDirectory(source, archive);
        var archiveBytes = await File.ReadAllBytesAsync(archive);
        var archiveHash = await UpdatePackageVerifier.ComputeSha256Async(archive);
        var checksumName = archiveName + ".sha256";
        var checksumBytes = Encoding.UTF8.GetBytes($"{archiveHash}  {archiveName}\n");
        var responses = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            [$"https://github.com/JHees/codex-script-loader/releases/download/v{nextVersion}/{archiveName}"] = archiveBytes,
            [$"https://github.com/JHees/codex-script-loader/releases/download/v{nextVersion}/{checksumName}"] = checksumBytes,
        };
        var transport = new FixtureUpdateTransport(
            new GitHubReleaseInfo($"v{nextVersion}", $"https://github.com/JHees/codex-script-loader/releases/tag/v{nextVersion}"),
            responses);
        var paths = LoaderPaths.FromRoot(Path.Combine(fixtureRoot, "data"));
        paths.EnsureDirectories();
        using var logger = new JsonlLogger(paths.LogsRoot);
        StagedUpdate? staged = null;
        await using var manager = new OnlineUpdateManager(paths, logger, (candidate, _) =>
        {
            staged = candidate;
            return Task.CompletedTask;
        }, currentHostRoot, transport);
        await manager.InitializeAsync(CancellationToken.None);
        var available = await manager.CheckForUpdatesAsync(CancellationToken.None);
        Equal(UpdateStage.Available, available.State, "Online update fixture discovers newer stable release");
        var completed = await manager.StartUpdateAsync(CancellationToken.None);
        Equal(UpdateStage.Succeeded, completed.State, "Online update fixture completes download and staging");
        Equal(nextVersion, staged?.Manifest.Version, "Online update switch receives verified version");
        True(File.Exists(Path.Combine(installRoot, "versions", nextVersion, "win-x64", "CodexScriptLoader.exe")), "Online update stages candidate in version directory");
        Equal(1, transport.ResolveCalls, "Online update resolves the stable GitHub Release once");
        Equal(2, transport.DownloadCalls, "Online update downloads the checksum and archive directly");
    }

    private static async Task TestSingleInstanceLockTransferAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "instance-lock"));
        await using var first = SingleInstanceCoordinator.Create(paths);
        True(first.IsPrimary, "First host acquires releasable instance lock");
        await using var candidate = SingleInstanceCoordinator.Create(paths);
        True(!candidate.IsPrimary, "Candidate waits without owning instance lock");
        await first.ReleaseOwnershipAsync();
        True(await candidate.TryAcquireAsync(TimeSpan.FromSeconds(2), CancellationToken.None), "Candidate acquires released instance lock");
        True(candidate.IsPrimary, "Candidate becomes primary after lock transfer");
    }

    private sealed class FixtureUpdateTransport(GitHubReleaseInfo release, IReadOnlyDictionary<string, byte[]> responses) : IUpdateTransport
    {
        public int ResolveCalls { get; private set; }
        public int DownloadCalls { get; private set; }

        public Task<GitHubReleaseInfo> ResolveLatestReleaseAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ResolveCalls++;
            return Task.FromResult(release);
        }

        public async Task<UpdateDownloadResult> DownloadAsync(
            Uri uri,
            string destination,
            long maximumBytes,
            Action<long, long> progress,
            CancellationToken cancellationToken)
        {
            DownloadCalls++;
            UpdatePackageVerifier.ValidateDownloadUri(uri);
            var bytes = responses[uri.AbsoluteUri];
            if (bytes.LongLength <= 0 || bytes.LongLength > maximumBytes) throw new InvalidDataException("Fixture response exceeded limit.");
            await File.WriteAllBytesAsync(destination, bytes, cancellationToken);
            progress(bytes.LongLength, bytes.LongLength);
            return new UpdateDownloadResult(uri, bytes.LongLength, bytes.LongLength);
        }
    }

    private static void True(bool condition, string name)
    {
        if (!condition)
        {
            throw new InvalidOperationException(name);
        }

        passed++;
    }

    private static void Equal<T>(T expected, T actual, string name)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{name}: expected={expected}; actual={actual}");
        }

        passed++;
    }

    private static void Throws<T>(Action action, string name) where T : Exception
    {
        try
        {
            action();
        }
        catch (T)
        {
            passed++;
            return;
        }

        throw new InvalidOperationException(name);
    }
}
