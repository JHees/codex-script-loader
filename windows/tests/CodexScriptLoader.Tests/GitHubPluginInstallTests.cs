using System.IO.Compression;
using System.Text;
using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task TestGitHubPluginInstallAsync(string testRoot)
    {
        const string repository = "Example/plugin-repository";
        const string url = "https://github.com/" + repository;
        const string asset = "example-plugin-1.0.0.zip";
        Equal(repository, GitHubPluginLink.Parse(" " + url + ".git ").Repository, "GitHub repository link normalized");
        Equal(null, GitHubPluginLink.Parse(url + "/releases/latest").Tag, "GitHub latest release accepted");
        Equal("v1.0.0", GitHubPluginLink.Parse(url + "/releases/tag/v1.0.0").Tag, "GitHub pinned release accepted");
        Equal(asset, GitHubPluginLink.Parse(url + "/releases/download/v1.0.0/" + asset).Asset, "GitHub asset link accepted");
        foreach (var invalid in new[] {
            "http://github.com/Example/plugin-repository", "https://github.com.evil.test/Example/repository",
            "https://user@github.com/Example/repository", "https://github.com:444/Example/repository",
            url + "?token=secret", url + "#readme", url + "/archive/refs/tags/v1.0.0.zip", url + "/tree/main",
            url + "/releases/tag/v1.0.0-beta", url + "/releases/download/v1.0.0/../evil.zip",
            url + "/releases/download/v1.0.0/%2e%2e.zip", "https://github.com/Example" })
            await ThrowsAsync<Exception>(() => Task.FromResult(GitHubPluginLink.Parse(invalid)), "Unsafe/non-release link rejected: " + invalid);

        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "github-install"));
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        var candidatePaths = LoaderPaths.FromRoot(Path.Combine(testRoot, "github-install-candidate"));
        await CreateTestPluginAsync(candidatePaths, "local.github-install", updateAware: true);
        var archive = Path.Combine(candidatePaths.StateRoot, asset);
        ZipFile.CreateFromDirectory(Path.Combine(candidatePaths.ScriptsRoot, "local.github-install"), archive);
        var bytes = await File.ReadAllBytesAsync(archive);
        var hash = await UpdatePackageVerifier.ComputeSha256Async(archive);
        var transport = new FakeGitHubInstallTransport(repository, asset, bytes, hash);
        var installer = new GitHubPluginInstaller(paths, registry, transport);
        using var logger = new JsonlLogger(paths.LogsRoot);
        await using var manager = new PluginUpdateManager(paths, registry, logger, (_, _) => Task.CompletedTask, () => false);
        await manager.InitializeAsync(CancellationToken.None);

        var first = (await installer.PreviewAsync(url, null, CancellationToken.None)).Preview!;
        Equal(hash, first.ArchiveSha256, "GitHub preview shows verified SHA-256");
        Equal(url + "/releases/tag/v1.0.0", first.SourceUrl, "GitHub preview shows pinned source");
        Equal(false, Directory.Exists(Path.Combine(paths.ScriptsRoot, "local.github-install")), "Preview does not install live code");
        await registry.CancelPendingPackageAsync(first.Token);
        Equal(false, Directory.EnumerateDirectories(Path.Combine(paths.StateRoot, "github-install-cache")).Any(), "Download cache cleaned after preview");

        var preview = (await installer.PreviewAsync(url, null, CancellationToken.None)).Preview!;
        await registry.InstallPendingAsync(preview.Token, false);
        await manager.RecordInstallationAsync(preview.Id, CancellationToken.None);
        Equal(true, manager.SnapshotFor(preview.Id).Supported, "New GitHub install immediately supports updates");
        Equal(false, manager.SnapshotFor(preview.Id).Automatic, "GitHub install does not silently opt in to updates");
        await manager.SetAutomaticAsync(preview.Id, true, CancellationToken.None);
        var replacement = (await installer.PreviewAsync(url, null, CancellationToken.None)).Preview!;
        Equal("1.0.0", replacement.ReplacesVersion, "Existing local ID is replaced without uninstall");
        var fingerprint = await registry.ComputePackageFingerprintAsync(preview.Id);
        await registry.InstallPendingAsync(replacement.Token, true);
        await manager.RecordInstallationAsync(preview.Id, CancellationToken.None);
        Equal(false, (await registry.ListPluginsAsync()).Single(item => item.Id == preview.Id).Enabled, "Same-ID replacement preserves disabled state");
        Equal(true, manager.SnapshotFor(preview.Id).Automatic, "Explicit update preference survives replacement");

        transport.ExtraAsset = "other-plugin-1.0.0.zip";
        var beforeDownloads = transport.Downloads;
        var choice = await installer.PreviewAsync(url, null, CancellationToken.None);
        Equal(null, choice.Preview, "Multiple packages require explicit selection");
        Equal(2, choice.Assets.Count, "All eligible packages offered");
        Equal(beforeDownloads, transport.Downloads, "Ambiguous release downloads no package");
        var chosen = (await installer.PreviewAsync(choice.ReleaseUrl, asset, CancellationToken.None)).Preview!;
        Equal("v1.0.0", transport.LastTag, "Asset choice remains pinned to displayed release");
        await registry.CancelPendingPackageAsync(chosen.Token);
        await ThrowsAsync<InvalidDataException>(() => installer.PreviewAsync(url, "missing.zip", CancellationToken.None), "Asset outside selected release rejected");
        transport.ExtraAsset = null;

        transport.BadChecksum = true;
        await ThrowsAsync<InvalidDataException>(() => installer.PreviewAsync(url, null, CancellationToken.None), "Checksum mismatch rejects downloaded package");
        transport.BadChecksum = false;
        transport.OmitChecksum = true;
        await ThrowsAsync<InvalidDataException>(() => installer.PreviewAsync(url, null, CancellationToken.None), "Release without checksum rejected");
        transport.OmitChecksum = false;
        transport.Prerelease = true;
        await ThrowsAsync<InvalidDataException>(() => installer.PreviewAsync(url, null, CancellationToken.None), "Prerelease rejected");
        transport.Prerelease = false;
        transport.Repository = "Other/plugin-repository";
        await ThrowsAsync<InvalidDataException>(() => installer.PreviewAsync(url, null, CancellationToken.None), "Metadata repository mismatch rejected");
        transport.Repository = repository;
        await ThrowsAsync<InvalidDataException>(() => installer.PreviewAsync(url + "/releases/tag/v2.0.0", null, CancellationToken.None), "Metadata tag mismatch rejected");
        transport.CancelDownload = true;
        await ThrowsAsync<OperationCanceledException>(() => installer.PreviewAsync(url, null, CancellationToken.None), "Cancelled download never stages package");
        transport.CancelDownload = false;

        // A correctly hashed ZIP from an unrelated repository must still be rejected.
        transport.Repository = "Other/plugin-repository";
        await ThrowsAsync<InvalidDataException>(() => installer.PreviewAsync("https://github.com/Other/plugin-repository", null, CancellationToken.None), "Manifest update source must match selected release");
        var wrongVersion = new FakeGitHubInstallTransport(repository, "example-plugin-2.0.0.zip", bytes, hash) { Tag = "v2.0.0" };
        await ThrowsAsync<InvalidDataException>(() => new GitHubPluginInstaller(paths, registry, wrongVersion).PreviewAsync(url, null, CancellationToken.None), "Manifest version must match release tag");
        Equal(fingerprint, await registry.ComputePackageFingerprintAsync(preview.Id), "All rejected downloads preserve installed package");
        Equal(false, Directory.EnumerateDirectories(Path.Combine(paths.StateRoot, "github-install-cache")).Any(), "Rejected downloads cleaned up");
    }

    private sealed class FakeGitHubInstallTransport(string repository, string asset, byte[] archive, string hash) : IGitHubPluginInstallTransport
    {
        public string Repository { get; set; } = repository;
        public string Tag { get; set; } = "v1.0.0";
        public string? ExtraAsset { get; set; }
        public string? LastTag { get; private set; }
        public bool BadChecksum { get; set; }
        public bool OmitChecksum { get; set; }
        public bool Prerelease { get; set; }
        public bool CancelDownload { get; set; }
        public int Downloads { get; private set; }

        public Task<string> ReadReleaseMetadataAsync(string requestedRepository, string? tag, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            LastTag = tag;
            var assets = new List<object> { new { name = asset, size = archive.Length } };
            if (!OmitChecksum) assets.Add(new { name = asset + ".sha256", size = 100 });
            if (ExtraAsset is not null) { assets.Add(new { name = ExtraAsset, size = 100 }); assets.Add(new { name = ExtraAsset + ".sha256", size = 100 }); }
            return Task.FromResult(JsonSerializer.Serialize(new {
                draft = false, prerelease = Prerelease, tag_name = Tag,
                html_url = $"https://github.com/{Repository}/releases/tag/{Tag}", assets,
            }));
        }

        public async Task<UpdateDownloadResult> DownloadAsync(Uri uri, string destination, long maximumBytes, Action<long, long> progress, CancellationToken cancellationToken)
        {
            Downloads++;
            if (CancelDownload) throw new OperationCanceledException();
            var bytes = uri.AbsolutePath.EndsWith(".sha256", StringComparison.Ordinal)
                ? Encoding.UTF8.GetBytes($"{(BadChecksum ? new string('0', 64) : hash)}  {asset}\n") : archive;
            if (bytes.LongLength > maximumBytes) throw new InvalidDataException("Download exceeds limit.");
            await File.WriteAllBytesAsync(destination, bytes, cancellationToken);
            return new UpdateDownloadResult(uri, bytes.LongLength, bytes.LongLength);
        }
    }
}
