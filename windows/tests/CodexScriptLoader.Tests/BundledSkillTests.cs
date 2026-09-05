using System.Text.Json.Nodes;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task TestBundledSkillInstallAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "skill-install"));
        var skillRoot = Path.Combine(testRoot, "user-skills");
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"), skillRoot, DirectoryJunction.Create);
        await registry.InitializeAsync();
        var source = LoaderPaths.FromRoot(Path.Combine(testRoot, "skill-package"));
        await CreateTestPluginAsync(source, "local.skill-example");
        var package = Path.Combine(source.ScriptsRoot, "local.skill-example");
        var manifestPath = Path.Combine(package, "manifest.json");
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(manifestPath))!;
        manifest["schemaVersion"] = 2;
        manifest["agentSkill"] = "loader-example";
        manifest["permissions"] = new JsonArray("agent-skills");
        await File.WriteAllTextAsync(manifestPath, manifest.ToJsonString());
        var skill = Path.Combine(package, "skills", "loader-example");
        Directory.CreateDirectory(Path.Combine(skill, "references"));
        const string content = "---\nname: loader-example\ndescription: A generic Loader test workflow.\n---\nRead references/details.md.\n";
        await File.WriteAllTextAsync(Path.Combine(skill, "SKILL.md"), content);
        await File.WriteAllTextAsync(Path.Combine(skill, "references", "details.md"), "fixture");

        manifest["schemaVersion"] = 1;
        await File.WriteAllTextAsync(manifestPath, manifest.ToJsonString());
        await ThrowsAsync<InvalidDataException>(() => registry.StagePackageAsync(package, false), "Bundled skills cannot silently use schema v1");
        manifest["schemaVersion"] = 2;
        await File.WriteAllTextAsync(manifestPath, manifest.ToJsonString());
        await File.WriteAllTextAsync(Path.Combine(skill, "SKILL.md"), content.Replace("name: loader-example", "name: wrong-name"));
        await ThrowsAsync<InvalidDataException>(() => registry.StagePackageAsync(package, false), "Skill name must match its declaration");
        await File.WriteAllTextAsync(Path.Combine(skill, "SKILL.md"), content);

        var rejected = await registry.StagePackageAsync(package, false);
        await ThrowsAsync<InvalidOperationException>(() => registry.InstallPendingAsync(rejected.Token, true,
            activate: (_, _) => throw new InvalidOperationException("fixture activation failure")), "A failed first activation rolls back installation");
        True(!Directory.Exists(Path.Combine(paths.ScriptsRoot, "local.skill-example")), "Failed activation leaves no installed package");
        True(!Directory.Exists(Path.Combine(skillRoot, "loader-example")), "Failed activation leaves no skill entry");

        var preview = await registry.StagePackageAsync(package, false);
        Equal("loader-example", preview.AgentSkill!, "Install preview declares the bundled skill");
        await registry.InstallPendingAsync(preview.Token, true);
        var installedSkill = Path.Combine(skillRoot, "loader-example");
        Equal(content, await File.ReadAllTextAsync(Path.Combine(installedSkill, "SKILL.md")), "One package install makes the skill discoverable");
        Equal("fixture", await File.ReadAllTextAsync(Path.Combine(installedSkill, "references", "details.md")), "Skill references remain self-contained");
        True(new DirectoryInfo(installedSkill).LinkTarget is not null, "The skill entry is a managed directory link, not a second source copy");
        Directory.Delete(installedSkill, recursive: false);
        registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"), skillRoot, DirectoryJunction.Create);
        await registry.InitializeAsync();
        Equal(content, await File.ReadAllTextAsync(Path.Combine(installedSkill, "SKILL.md")), "Startup restores a missing owned skill entry");
        var originalConfig = await File.ReadAllTextAsync(paths.ConfigPath);
        await File.WriteAllTextAsync(paths.ConfigPath, "{\"schemaVersion\":1,\"globalEnabled\":false}");
        await registry.ReconcileSkillEntriesAsync();
        True(!Directory.Exists(installedSkill), "Global disable removes the skill entry on reload");
        await File.WriteAllTextAsync(paths.ConfigPath, originalConfig);
        await registry.ReconcileSkillEntriesAsync();
        Equal(content, await File.ReadAllTextAsync(Path.Combine(installedSkill, "SKILL.md")), "Reload restores the entry after global enable");
        await registry.SetEnabledAsync("local.skill-example", false);
        True(!Directory.Exists(installedSkill), "Disabling a plugin removes its skill entry");
        registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"), skillRoot, (link, target) =>
        {
            DirectoryJunction.Create(link, target);
            // A settings refresh can arrive between skill publication and config persistence.
            _ = registry.ListPluginsAsync().GetAwaiter().GetResult();
            _ = registry.BuildPlanAsync(false).GetAwaiter().GetResult();
        });
        await registry.InitializeAsync();
        await registry.SetEnabledAsync("local.skill-example", true);
        True((await registry.ListPluginsAsync()).Single().Enabled, "Status reads during activation cannot overwrite a pending enable change");
        var quarantined = await registry.QuarantineAsync("local.skill-example");
        True(!Directory.Exists(installedSkill), "Removing a plugin removes its skill entry");
        await registry.RestoreQuarantinedAsync(quarantined.Key);
        Equal(content, await File.ReadAllTextAsync(Path.Combine(installedSkill, "SKILL.md")), "Restoring a plugin restores its skill entry");

        manifest["version"] = "1.1.0";
        await File.WriteAllTextAsync(manifestPath, manifest.ToJsonString());
        await File.WriteAllTextAsync(Path.Combine(skill, "SKILL.md"), content + "Updated workflow.\n");
        var updatePreview = await registry.StagePackageAsync(package, false);
        Equal("1.0.0", updatePreview.ReplacesVersion!, "A local update previews the version being replaced");
        await ThrowsAsync<InvalidOperationException>(() => registry.InstallPendingAsync(updatePreview.Token, true,
            activate: async (id, ct) =>
            {
                if ((await ScriptRegistry.LoadDescriptorAsync(Path.Combine(paths.ScriptsRoot, id), ct)).Version == "1.1.0")
                    throw new InvalidOperationException("fixture lifecycle failure");
            }), "Failed local update rolls back the whole package");
        Equal(content, await File.ReadAllTextAsync(Path.Combine(installedSkill, "SKILL.md")), "Skill content rolls back with its plugin");
        updatePreview = await registry.StagePackageAsync(package, false);
        await registry.InstallPendingAsync(updatePreview.Token, true);
        Equal(content + "Updated workflow.\n", await File.ReadAllTextAsync(Path.Combine(installedSkill, "SKILL.md")), "A local upgrade updates the skill without another installation");

        await registry.SetEnabledAsync("local.skill-example", false);
        Directory.CreateDirectory(installedSkill);
        await File.WriteAllTextAsync(Path.Combine(installedSkill, "SKILL.md"), "user-owned");
        await ThrowsAsync<IOException>(() => registry.SetEnabledAsync("local.skill-example", true), "Existing user skill is never overwritten");
        Equal("user-owned", await File.ReadAllTextAsync(Path.Combine(installedSkill, "SKILL.md")), "Conflict preserves the user's skill content");
        True(!(await registry.ListPluginsAsync()).Single().Enabled, "A failed skill activation rolls back plugin enabled state");

        // Simulate a previously enabled entry replaced by user content while Loader was stopped.
        await File.WriteAllTextAsync(paths.ConfigPath, "{\"schemaVersion\":1,\"scripts\":{}}");
        registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"), skillRoot, DirectoryJunction.Create);
        await registry.InitializeAsync();
        Equal("conflict", (await registry.ListPluginsAsync()).Single().AgentSkillStatus!, "Startup reports a conflicting user skill without stopping Loader");
        Equal("user-owned", await File.ReadAllTextAsync(Path.Combine(installedSkill, "SKILL.md")), "Startup never takes over an unowned entry");
    }
}
