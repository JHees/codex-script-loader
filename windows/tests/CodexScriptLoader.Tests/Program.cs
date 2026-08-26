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
        True(plan.Source.Contains("runtime.runtimeVersion = \"0.3.0\"", StringComparison.Ordinal), "Runtime version source");
        True(plan.Source.Contains("__bennettUiImprovementsBigPizza", StringComparison.Ordinal), "Lifecycle source");
        True(plan.Source.Contains("installSettingsHost", StringComparison.Ordinal), "Settings host source");
        True(plan.Source.Contains("sha256-" + plan.Scripts[0].Fingerprint, StringComparison.Ordinal), "Integrity source");
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
        await registry.EnsureBundledScriptAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "bennett-ui-improvements"));
        var quarantined = await registry.QuarantineAsync("co.bennett.ui-improvements");
        True(!Directory.Exists(Path.Combine(paths.ScriptsRoot, quarantined.ScriptId)), "Quarantine removes installed path");
        Equal(1, (await registry.ListQuarantinedAsync()).Count, "Quarantine list count");
        var plan = await registry.BuildPlanAsync(force: true);
        Equal(0, plan.Scripts.Count, "Quarantined script is isolated");
        var restored = await registry.RestoreQuarantinedAsync(quarantined.Key);
        Equal(quarantined.ScriptId, restored.ScriptId, "Restored script id");
        Equal(1, (await registry.BuildPlanAsync(force: true)).Scripts.Count, "Restored script returns to plan");
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
