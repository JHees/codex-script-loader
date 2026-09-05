using System.Text.Json;
using System.Text.RegularExpressions;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal interface IGitHubPluginInstallTransport
{
    Task<string> ReadReleaseMetadataAsync(string repository, string? tag, CancellationToken cancellationToken);
    Task<UpdateDownloadResult> DownloadAsync(Uri uri, string destination, long maximumBytes, Action<long, long> progress, CancellationToken cancellationToken);
}

internal sealed record GitHubPluginLink(string Repository, string? Tag, string? Asset)
{
    internal static bool SafeAsset(string value) => Regex.IsMatch(value, "\\A[A-Za-z0-9][A-Za-z0-9._-]{0,159}\\.zip\\z");

    internal static GitHubPluginLink Parse(string input)
    {
        var text = input.Trim();
        if (text.Length > 2048 || text.Contains('\\') || text.Contains('%') || text.Contains("/../", StringComparison.Ordinal) || text.Contains("/./", StringComparison.Ordinal) ||
            !Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.IdnHost != "github.com" ||
            !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new InvalidDataException("Use a public HTTPS github.com repository or Release link without query parameters.");
        var parts = uri.AbsolutePath.Trim('/').Split('/');
        if (parts.Length < 2) throw new InvalidDataException("GitHub link must identify an owner and repository.");
        if (parts.Length == 2 && parts[1].EndsWith(".git", StringComparison.Ordinal)) parts[1] = parts[1][..^4];
        if (!Regex.IsMatch(parts[0], "\\A[A-Za-z0-9][A-Za-z0-9-]{0,38}\\z") ||
            !Regex.IsMatch(parts[1], "\\A[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\z"))
            throw new InvalidDataException("Invalid GitHub owner or repository.");
        var repository = $"{parts[0]}/{parts[1]}";
        if (parts.Length == 2 || (parts.Length == 3 && parts[2] == "releases") ||
            (parts.Length == 4 && parts[2] == "releases" && parts[3] == "latest")) return new(repository, null, null);
        if (parts.Length is 5 or 6 && parts[2] == "releases" &&
            ((parts.Length == 5 && parts[3] == "tag") || (parts.Length == 6 && parts[3] == "download")))
        {
            var tag = parts[4];
            if (!tag.StartsWith('v')) throw new InvalidDataException("Release tag must use vMAJOR.MINOR.PATCH.");
            VersionedInstallLayout.ValidateVersionAndRid(tag[1..], "win-x64");
            var asset = parts.Length == 6 ? parts[5] : null;
            if (asset is not null && !SafeAsset(asset)) throw new InvalidDataException("Release asset must be a safe ZIP filename.");
            return new(repository, tag, asset);
        }
        throw new InvalidDataException("Use a repository, Release page, or Release ZIP link; source-code archive and branch links are not plugin packages.");
    }
}

internal sealed record GitHubPluginInstallResult(string ReleaseUrl, IReadOnlyList<string> Assets, PluginInstallPreview? Preview = null);

/// <summary>Downloads a verified release into the existing preview/confirmation installer.</summary>
internal sealed class GitHubPluginInstaller(LoaderPaths paths, ScriptRegistry registry, IGitHubPluginInstallTransport transport)
{
    public async Task<GitHubPluginInstallResult> PreviewAsync(string url, string? selectedAsset, CancellationToken cancellationToken)
    {
        var source = GitHubPluginLink.Parse(url);
        if (selectedAsset is not null && (!GitHubPluginLink.SafeAsset(selectedAsset) || (source.Asset is not null && source.Asset != selectedAsset)))
            throw new InvalidDataException("Selected ZIP does not match the GitHub link.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(120));
        var token = timeout.Token;
        var json = await transport.ReadReleaseMetadataAsync(source.Repository, source.Tag, token).ConfigureAwait(false);
        var release = ParseRelease(json, source);
        var candidates = release.Assets.Where(item => GitHubPluginLink.SafeAsset(item.Key) && item.Value is > 0 and <= 8 * 1024 * 1024 &&
                release.Assets.TryGetValue(item.Key + ".sha256", out var size) && size is > 0 and <= 4096)
            .Select(item => item.Key).Order(StringComparer.Ordinal).ToArray();
        if (candidates.Length == 0) throw new InvalidDataException("Release has no installable ZIP with a matching .sha256 file (maximum ZIP size: 8 MiB).");
        var asset = selectedAsset ?? source.Asset;
        if (asset is null && candidates.Length > 1) return new(release.Url, candidates);
        asset ??= candidates[0];
        if (!candidates.Contains(asset, StringComparer.Ordinal)) throw new InvalidDataException("Selected ZIP and checksum are not present in this Release.");

        var cacheRoot = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "github-install-cache", Guid.NewGuid().ToString("N")), "GitHub install download");
        Directory.CreateDirectory(cacheRoot);
        try
        {
            var archive = Path.Combine(cacheRoot, asset);
            var checksum = archive + ".sha256";
            var prefix = $"https://github.com/{source.Repository}/releases/download/{release.Tag}/";
            await transport.DownloadAsync(new Uri(prefix + asset + ".sha256"), checksum, 4096, (_, _) => { }, token).ConfigureAwait(false);
            var expectedHash = UpdatePackageVerifier.ReadUniqueSha256(await File.ReadAllTextAsync(checksum, token).ConfigureAwait(false), asset);
            await transport.DownloadAsync(new Uri(prefix + asset), archive, 8 * 1024 * 1024, (_, _) => { }, token).ConfigureAwait(false);
            if (!string.Equals(expectedHash, await UpdatePackageVerifier.ComputeSha256Async(archive, token).ConfigureAwait(false), StringComparison.Ordinal))
                throw new InvalidDataException("Downloaded plugin ZIP does not match its Release SHA-256.");
            var preview = await registry.StagePackageAsync(archive, true, token,
                new PluginReleasePackage(source.Repository, release.Tag[1..], asset, expectedHash)).ConfigureAwait(false);
            return new(release.Url, candidates, preview);
        }
        finally { Directory.Delete(cacheRoot, recursive: true); }
    }

    private static (string Tag, string Url, Dictionary<string, long> Assets) ParseRelease(string json, GitHubPluginLink source)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.GetProperty("draft").GetBoolean() || root.GetProperty("prerelease").GetBoolean()) throw new InvalidDataException("Only published stable Releases can be installed.");
            var tag = root.GetProperty("tag_name").GetString() ?? string.Empty;
            if (!tag.StartsWith('v')) throw new InvalidDataException("Release must use a stable version tag.");
            VersionedInstallLayout.ValidateVersionAndRid(tag[1..], "win-x64");
            var releaseUrl = root.GetProperty("html_url").GetString() ?? string.Empty;
            if ((source.Tag is not null && source.Tag != tag) ||
                !string.Equals(releaseUrl, $"https://github.com/{source.Repository}/releases/tag/{tag}", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Release identity does not match the requested repository and version.");
            var assets = new Dictionary<string, long>(StringComparer.Ordinal);
            foreach (var item in root.GetProperty("assets").EnumerateArray())
            {
                var name = item.GetProperty("name").GetString() ?? string.Empty;
                if (!assets.TryAdd(name, item.GetProperty("size").GetInt64()) || assets.Count > 128)
                    throw new InvalidDataException("Release asset list is ambiguous or too large.");
            }
            return (tag, releaseUrl, assets);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or OverflowException)
        { throw new InvalidDataException("GitHub Release metadata is invalid.", error); }
    }
}
