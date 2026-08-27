using System.IO.Compression;
using System.Text.Json;
using CodexScriptLoader.Core;

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
            TestLogRedaction(testRoot);
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
        True(plan.Source.Contains("runtime.runtimeVersion = \"0.4.1\"", StringComparison.Ordinal), "Runtime version source");
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
