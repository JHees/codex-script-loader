using CodexScriptLoader.Core;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task TestComposerInterfaceAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "composer-interface"));
        await CreateTestPluginAsync(paths, "local.composer-example", permissions: ["composer"]);
        var fixtures = Path.Combine(AppContext.BaseDirectory, "fixtures");
        var registry = new ScriptRegistry(paths, Path.Combine(fixtures, "settings-host.mjs"));
        await registry.InitializeAsync();
        var plan = await registry.BuildPlanAsync(force: true);
        True(plan.Source.Contains("function installComposerHost()", StringComparison.Ordinal), "Native plan loads generic composer host");
        True(plan.Source.Contains("apiExtensions.composer", StringComparison.Ordinal), "Native wrapper provides permission-gated composer interface");
        True(plan.Source.Contains("handle.unregister()", StringComparison.Ordinal), "Native wrapper owns accessory cleanup");
        True(plan.Source.Contains("COMPOSER_UNAVAILABLE", StringComparison.Ordinal), "Native composer detects unavailable App support");
        var settings = await File.ReadAllTextAsync(Path.Combine(fixtures, "settings-host.mjs"));
        var composer = await File.ReadAllTextAsync(Path.Combine(fixtures, "composer-host.mjs"));
        var source = InjectionSourceBuilder.Build(plan.Scripts, settings, new HashSet<string>(), composer);
        True(!source.Contains("export function buildComposerHostSource", StringComparison.Ordinal), "Native extraction excludes module export syntax");
        var rejected = false;
        try { InjectionSourceBuilder.Build(plan.Scripts, settings, new HashSet<string>(), "invalid module"); }
        catch (InvalidDataException) { rejected = true; }
        True(rejected, "Malformed composer resource is rejected");
        True(InjectionSourceBuilder.Build(plan.Scripts, settings, force: false).Length > 0, "Existing native build overload remains compatible");
    }
}
