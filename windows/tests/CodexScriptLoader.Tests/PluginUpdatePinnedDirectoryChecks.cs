using System.ComponentModel;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Tests;

internal static class PluginUpdatePinnedDirectoryChecks
{
    private const uint GenericRead = 0x80000000;
    private const uint ShareRead = 1;
    private const uint ShareWrite = 2;
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle OpenDirectory(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    public static async Task RunAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "plugin-update-pinned"));
        var target = Path.Combine(paths.ScriptsRoot, "local.pinned-update");
        await CreatePackageAsync(paths, "local.pinned-update", "1.0.0", "old source", includeObsolete: true);
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        await registry.SetEnabledAsync("local.pinned-update", true);
        var oldFingerprint = await registry.ComputePackageFingerprintAsync("local.pinned-update");

        var candidatePaths = LoaderPaths.FromRoot(Path.Combine(testRoot, "plugin-update-pinned-candidate"));
        await CreatePackageAsync(candidatePaths, "local.pinned-update", "1.1.0", "new source", includeObsolete: false);
        var archive = Path.Combine(testRoot, "pinned-plugin-1.1.0.zip");
        ZipFile.CreateFromDirectory(Path.Combine(candidatePaths.ScriptsRoot, "local.pinned-update"), archive);

        var moveProbe = Path.Combine(testRoot, "pinned-update-move-probe");
        CopyFiles(target, moveProbe);
        using (var pinnedDirectory = OpenDirectory(moveProbe, GenericRead, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero))
        {
            if (pinnedDirectory.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not pin the plugin directory for the update regression test.");
            var movedProbe = moveProbe + "-moved";
            try
            {
                Directory.Move(moveProbe, movedProbe);
                Directory.Move(movedProbe, moveProbe);
                throw new InvalidOperationException("A directory opened without delete sharing should not be movable.");
            }
            catch (IOException)
            {
                if (!Directory.Exists(moveProbe) || Directory.Exists(movedProbe)) throw;
            }
        }

        using (var pinnedDirectory = OpenDirectory(target, GenericRead, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero))
        {
            if (pinnedDirectory.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not pin the installed plugin directory for its update regression test.");
            var failedPreview = await registry.StagePackageAsync(archive, archive: true);
            var activations = 0;
            await ThrowsAsync<InvalidOperationException>(
                () => registry.InstallPendingAsync(failedPreview.Token, true, CancellationToken.None, (_, _) => ++activations == 1
                    ? throw new InvalidOperationException("candidate activation failed") : Task.CompletedTask),
                "Candidate activation rollback works while the installed directory is pinned");
            Equal(oldFingerprint, await registry.ComputePackageFingerprintAsync("local.pinned-update"), "Pinned rollback restores every old plugin file");
            Equal("1.0.0", (await ScriptRegistry.LoadDescriptorAsync(target)).Version, "Pinned rollback keeps the installed root and old descriptor");

            var preview = await registry.StagePackageAsync(archive, archive: true);
            await registry.InstallPendingAsync(preview.Token, true, CancellationToken.None, (_, _) => Task.CompletedTask);
            Equal("1.1.0", (await ScriptRegistry.LoadDescriptorAsync(target)).Version, "Pinned update replaces files in place");
            True(!File.Exists(Path.Combine(target, "obsolete.txt")), "Pinned update removes files no longer in the package");
            True(File.Exists(Path.Combine(target, "README.md")), "Pinned update retains package-relative documentation");
            True(File.Exists(Path.Combine(target, "type-change.js", "child.js")), "Update replaces a file with a directory");
            True(File.Exists(Path.Combine(target, "type-directory")), "Update replaces a directory with a file");
        }
    }

    public static async Task RunRecoveryAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "plugin-update-pinned-recovery"));
        await CreatePackageAsync(paths, "local.pinned-recovery", "1.0.0", "original bytes", includeObsolete: false);
        var target = Path.Combine(paths.ScriptsRoot, "local.pinned-recovery");
        var token = new string('a', 36);
        var pending = Path.Combine(paths.StateRoot, "pending");
        var backup = Path.Combine(pending, $"rollback-{token}");
        var stage = Path.Combine(pending, token);
        Directory.CreateDirectory(backup);
        Directory.CreateDirectory(stage);
        CopyFiles(target, backup);
        var originalRegistry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        var backupFingerprint = await originalRegistry.ComputePackageFingerprintAsync("local.pinned-recovery");
        await File.WriteAllTextAsync(Path.Combine(target, "index.js"), "partially replaced bytes", Encoding.UTF8);
        await File.WriteAllTextAsync(paths.PluginUpdateTransactionPath, JsonSerializer.Serialize(new
        {
            schemaVersion = 2,
            token,
            pluginId = "local.pinned-recovery",
            target,
            backup,
            stageRoot = stage,
            packageRoot = stage,
            state = "candidate-installed",
            backupFingerprint,
        }));

        using var pinnedDirectory = OpenDirectory(target, GenericRead, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero);
        if (pinnedDirectory.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not pin the plugin directory for update recovery.");
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        Equal("original bytes", await File.ReadAllTextAsync(Path.Combine(target, "index.js")), "Interrupted update restores the package inside its pinned directory");
        True(!File.Exists(paths.PluginUpdateTransactionPath), "Recovered update clears its journal");
        True(!Directory.Exists(backup) && !Directory.Exists(stage), "Recovered update removes its rollback and stage copies");
    }

    private static void CopyFiles(string source, string target)
    {
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(source, directory)));
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var destination = Path.Combine(target, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file, destination);
        }
    }

    private static async Task CreatePackageAsync(LoaderPaths paths, string id, string version, string source, bool includeObsolete)
    {
        paths.EnsureDirectories();
        var package = Path.Combine(paths.ScriptsRoot, id);
        Directory.CreateDirectory(package);
        var manifest = $$"""
        {
          "schemaVersion": 1,
          "id": "{{id}}",
          "name": "Pinned update fixture",
          "version": "{{version}}",
          "main": "index.js",
          "scope": "renderer",
          "runAt": "document-start",
          "documentation": "README.md",
          "settings": { "mode": "none" },
          "permissions": [],
          "update": { "provider": "github-releases", "repository": "Example/plugin-repository", "asset": "pinned-plugin-{version}.zip" }
        }
        """;
        await File.WriteAllTextAsync(Path.Combine(package, "manifest.json"), manifest, Encoding.UTF8);
        await File.WriteAllTextAsync(Path.Combine(package, "index.js"), source, Encoding.UTF8);
        await File.WriteAllTextAsync(Path.Combine(package, "README.md"), "# Pinned update fixture\n", Encoding.UTF8);
        if (includeObsolete)
        {
            await File.WriteAllTextAsync(Path.Combine(package, "obsolete.txt"), "old package file\n", Encoding.UTF8);
            await File.WriteAllTextAsync(Path.Combine(package, "type-change.js"), "old file\n", Encoding.UTF8);
            var directory = Path.Combine(package, "type-directory");
            Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(Path.Combine(directory, "child.js"), "old child\n", Encoding.UTF8);
        }
        else
        {
            var directory = Path.Combine(package, "type-change.js");
            Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(Path.Combine(directory, "child.js"), "new child\n", Encoding.UTF8);
            await File.WriteAllTextAsync(Path.Combine(package, "type-directory"), "new file\n", Encoding.UTF8);
        }
    }

    private static async Task ThrowsAsync<T>(Func<Task> action, string message) where T : Exception
    {
        try { await action(); }
        catch (T) { return; }
        throw new InvalidOperationException(message);
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new InvalidOperationException(message);
    }

    private static void True(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
    }
}
