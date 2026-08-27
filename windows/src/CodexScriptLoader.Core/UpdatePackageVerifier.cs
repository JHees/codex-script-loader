using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Core;

public static class UpdatePackageVerifier
{
    public const int MaximumFileCount = 4096;
    public const long MaximumExpandedBytes = 512L * 1024 * 1024;
    private static readonly HashSet<string> AllowedDownloadHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
    };

    public static void ValidateDownloadUri(Uri uri)
    {
        if (uri.Scheme != Uri.UriSchemeHttps || !AllowedDownloadHosts.Contains(uri.IdnHost))
        {
            throw new InvalidDataException("Update download host is not allowed.");
        }
    }

    public static string ReadUniqueSha256(string sums, string assetName)
    {
        var pattern = new Regex($"^([a-fA-F0-9]{{64}})[ \\t]+\\*?{Regex.Escape(assetName)}$", RegexOptions.CultureInvariant);
        var matches = sums.Replace("\r", string.Empty, StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => pattern.Match(line))
            .Where(match => match.Success)
            .ToArray();
        if (matches.Length != 1)
        {
            throw new InvalidDataException("Release checksum file must contain exactly one matching asset record.");
        }

        return matches[0].Groups[1].Value.ToLowerInvariant();
    }

    public static async Task<UpdateManifest> VerifyAndExtractAsync(
        string archivePath,
        string destinationRoot,
        string expectedVersion,
        string expectedRid,
        string expectedArchiveSha256,
        CancellationToken cancellationToken = default)
    {
        VersionedInstallLayout.ValidateVersionAndRid(expectedVersion, expectedRid);
        var actualArchiveHash = await ComputeSha256Async(archivePath, cancellationToken).ConfigureAwait(false);
        if (!string.Equals(actualArchiveHash, NormalizeHash(expectedArchiveSha256), StringComparison.Ordinal))
        {
            throw new InvalidDataException("Downloaded update archive SHA-256 does not match the release checksum.");
        }

        var fullDestination = Path.GetFullPath(destinationRoot);
        Directory.CreateDirectory(fullDestination);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var extractedFiles = new List<string>();
        long totalBytes = 0;
        using (var archive = ZipFile.OpenRead(archivePath))
        {
            if (archive.Entries.Count is 0 or > MaximumFileCount)
            {
                throw new InvalidDataException("Update archive file count is invalid.");
            }

            foreach (var entry in archive.Entries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var normalized = entry.FullName.Replace('\\', '/');
                if (string.IsNullOrWhiteSpace(normalized) || normalized.StartsWith("/", StringComparison.Ordinal) ||
                    normalized.Split('/').Any(part => part == "..") || Path.IsPathRooted(normalized) || !names.Add(normalized))
                {
                    throw new InvalidDataException("Update archive contains an unsafe or duplicate path.");
                }

                var unixMode = (entry.ExternalAttributes >> 16) & 0xF000;
                if (unixMode == 0xA000 || (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0)
                {
                    throw new InvalidDataException("Update archive contains a symbolic link.");
                }

                totalBytes = checked(totalBytes + entry.Length);
                if (totalBytes > MaximumExpandedBytes)
                {
                    throw new InvalidDataException("Update archive expanded size exceeds the limit.");
                }

                var destination = VersionedInstallLayout.EnsureWithin(fullDestination, Path.Combine(fullDestination, normalized.Replace('/', Path.DirectorySeparatorChar)), "archive entry");
                if (normalized.EndsWith("/", StringComparison.Ordinal))
                {
                    Directory.CreateDirectory(destination);
                    continue;
                }

                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                await using var input = entry.Open();
                await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
                await input.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
                extractedFiles.Add(normalized);
            }
        }

        var manifestPath = Path.Combine(fullDestination, "update-manifest.json");
        if (!File.Exists(manifestPath) || new FileInfo(manifestPath).Length > 4 * 1024 * 1024)
        {
            throw new InvalidDataException("Update manifest is missing or too large.");
        }
        var manifest = await AtomicJsonFile.ReadAsync<UpdateManifest>(manifestPath, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("Update archive has no update-manifest.json.");
        ValidateManifest(manifest, expectedVersion, expectedRid);

        var manifestFiles = manifest.Files.ToDictionary(file => file.Path.Replace('\\', '/'), StringComparer.OrdinalIgnoreCase);
        var payloadFiles = extractedFiles.Where(path => !string.Equals(path, "update-manifest.json", StringComparison.OrdinalIgnoreCase)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!payloadFiles.SetEquals(manifestFiles.Keys))
        {
            throw new InvalidDataException("Update manifest file list does not match archive contents.");
        }

        foreach (var item in manifestFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var filePath = VersionedInstallLayout.EnsureWithin(fullDestination, Path.Combine(fullDestination, item.Key.Replace('/', Path.DirectorySeparatorChar)), "manifest file");
            var info = new FileInfo(filePath);
            if (!info.Exists || info.Length != item.Value.Size ||
                !string.Equals(await ComputeSha256Async(filePath, cancellationToken).ConfigureAwait(false), NormalizeHash(item.Value.Sha256), StringComparison.Ordinal))
            {
                throw new InvalidDataException($"Update payload verification failed for {item.Key}.");
            }
        }

        var entryPoint = VersionedInstallLayout.EnsureWithin(fullDestination, Path.Combine(fullDestination, manifest.EntryPoint), "update entry point");
        if (!File.Exists(entryPoint))
        {
            throw new InvalidDataException("Update entry point is missing.");
        }

        return manifest;
    }

    public static void ValidateManifest(UpdateManifest manifest, string expectedVersion, string expectedRid)
    {
        if (manifest.SchemaVersion != 1 || manifest.Version != expectedVersion || manifest.Rid != expectedRid ||
            manifest.LauncherProtocol <= 0 || manifest.HandoffProtocol <= 0 || manifest.Files.Count is 0 or > MaximumFileCount)
        {
            throw new InvalidDataException("Update manifest identity or protocol is invalid.");
        }

        var normalizedEntryPoint = manifest.EntryPoint.Replace('\\', '/');
        var expectedEntryPoint = $"versions/{expectedVersion}/{expectedRid}/CodexScriptLoader.exe";
        if (!string.Equals(normalizedEntryPoint, expectedEntryPoint, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(normalizedEntryPoint) || normalizedEntryPoint.StartsWith("/", StringComparison.Ordinal) ||
            normalizedEntryPoint.Split('/').Any(part => part == "..") || Path.IsPathRooted(normalizedEntryPoint))
        {
            throw new InvalidDataException("Update manifest entry point is invalid.");
        }
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in manifest.Files)
        {
            var normalized = file.Path.Replace('\\', '/');
            if (file.Size < 0 || !paths.Add(normalized) || string.IsNullOrWhiteSpace(normalized) || normalized.StartsWith("/", StringComparison.Ordinal) ||
                normalized.Split('/').Any(part => part == "..") || !Regex.IsMatch(file.Sha256, "^[a-fA-F0-9]{64}$", RegexOptions.CultureInvariant))
            {
                throw new InvalidDataException("Update manifest contains an invalid file record.");
            }
        }
    }

    public static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken = default)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var hash = await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false);
        return Convert.ToHexStringLower(hash);
    }

    private static string NormalizeHash(string value)
    {
        if (!Regex.IsMatch(value, "^[a-fA-F0-9]{64}$", RegexOptions.CultureInvariant))
        {
            throw new InvalidDataException("SHA-256 value is invalid.");
        }

        return value.ToLowerInvariant();
    }
}
