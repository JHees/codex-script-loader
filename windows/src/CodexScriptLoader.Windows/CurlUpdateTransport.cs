using System.Diagnostics;
using System.Globalization;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed record UpdateDownloadResult(Uri FinalUri, long BytesWritten, long DeclaredSize);

internal interface IUpdateTransport
{
    Task<GitHubReleaseInfo> ResolveLatestReleaseAsync(CancellationToken cancellationToken);

    Task<UpdateDownloadResult> DownloadAsync(
        Uri uri,
        string destination,
        long maximumBytes,
        Action<long, long> progress,
        CancellationToken cancellationToken);
}

internal sealed class CurlUpdateTransport : IUpdateTransport, IGitHubPluginInstallTransport
{
    private const string Repository = "JHees/codex-script-loader";
    private const string MarkerUrl = "CODEX_URL=";
    private const string MarkerStatus = "CODEX_STATUS=";
    private const string MarkerSize = "CODEX_SIZE=";
    private readonly string curlPath;

    public CurlUpdateTransport()
    {
        curlPath = Path.GetFullPath(Path.Combine(Environment.SystemDirectory, "curl.exe"));
        var systemRoot = Path.GetFullPath(Environment.SystemDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!curlPath.StartsWith(systemRoot, StringComparison.OrdinalIgnoreCase) || !File.Exists(curlPath))
        {
            throw new FileNotFoundException("Windows system curl is unavailable.", curlPath);
        }
    }

    public async Task<GitHubReleaseInfo> ResolveLatestReleaseAsync(CancellationToken cancellationToken)
        => await ResolveLatestReleaseAsync(Repository, cancellationToken).ConfigureAwait(false);

    public async Task<string> ReadReleaseMetadataAsync(string repository, string? tag, CancellationToken cancellationToken)
    {
        // Only this fixed REST route uses api.github.com; asset download permissions stay unchanged.
        var link = GitHubPluginLink.Parse($"https://github.com/{repository}" + (tag is null ? string.Empty : $"/releases/tag/{tag}"));
        var route = link.Tag is null ? "latest" : "tags/" + link.Tag;
        var start = CreateStartInfo();
        AddCommonArguments(start);
        start.ArgumentList.Add("--max-redirs");
        start.ArgumentList.Add("0");
        start.ArgumentList.Add("--max-filesize");
        start.ArgumentList.Add("1048576");
        start.ArgumentList.Add("--header");
        start.ArgumentList.Add("Accept: application/vnd.github+json");
        start.ArgumentList.Add("--header");
        start.ArgumentList.Add("X-GitHub-Api-Version: 2022-11-28");
        start.ArgumentList.Add($"https://api.github.com/repos/{link.Repository}/releases/{route}");
        var result = await RunAsync(start, null, 0, null, cancellationToken).ConfigureAwait(false);
        if (System.Text.Encoding.UTF8.GetByteCount(result.StandardOutput) > 1048576) throw new InvalidDataException("GitHub Release metadata exceeds 1 MiB.");
        return result.StandardOutput;
    }

    internal async Task<GitHubReleaseInfo> ResolveLatestReleaseAsync(string repository, CancellationToken cancellationToken)
    {
        var latest = new Uri($"https://github.com/{repository}/releases/latest");
        var probe = await ProbeAsync(latest, requireSize: false, cancellationToken).ConfigureAwait(false);
        var prefix = $"https://github.com/{repository}/releases/tag/v";
        if (!probe.FinalUri.AbsoluteUri.StartsWith(prefix, StringComparison.Ordinal) ||
            probe.FinalUri.Query.Length != 0 || probe.FinalUri.Fragment.Length != 0)
        {
            throw new InvalidDataException("GitHub latest release redirect is invalid.");
        }

        var version = probe.FinalUri.AbsoluteUri[prefix.Length..];
        VersionedInstallLayout.ValidateVersionAndRid(version, "win-x64");
        return new GitHubReleaseInfo($"v{version}", probe.FinalUri.AbsoluteUri);
    }

    public async Task<UpdateDownloadResult> DownloadAsync(
        Uri uri,
        string destination,
        long maximumBytes,
        Action<long, long> progress,
        CancellationToken cancellationToken)
    {
        if (maximumBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        UpdatePackageVerifier.ValidateDownloadUri(uri);
        var probe = await ProbeAsync(uri, requireSize: true, cancellationToken).ConfigureAwait(false);
        var declaredSize = probe.ContentLength!.Value;
        if (declaredSize <= 0 || declaredSize > maximumBytes) throw new InvalidDataException("Release asset size is invalid.");

        var fullDestination = Path.GetFullPath(destination);
        Directory.CreateDirectory(Path.GetDirectoryName(fullDestination)!);
        var temporary = fullDestination + $".{Guid.NewGuid():N}.partial";
        try
        {
            var start = CreateStartInfo();
            AddCommonArguments(start);
            start.ArgumentList.Add("--output");
            start.ArgumentList.Add(temporary);
            start.ArgumentList.Add("--write-out");
            start.ArgumentList.Add(WriteOutFormat);
            start.ArgumentList.Add(uri.AbsoluteUri);
            var result = await RunAsync(start, temporary, declaredSize, progress, cancellationToken).ConfigureAwait(false);
            var parsed = ParseResult(result.StandardOutput, requireSize: false);
            if (parsed.StatusCode != 200) throw new HttpRequestException($"GitHub Release download returned HTTP {parsed.StatusCode}.");
            UpdatePackageVerifier.ValidateDownloadUri(parsed.FinalUri);
            var actualSize = new FileInfo(temporary).Length;
            if (actualSize != declaredSize || actualSize > maximumBytes)
            {
                throw new InvalidDataException("Downloaded Release asset size does not match its declared size.");
            }

            File.Move(temporary, fullDestination, overwrite: true);
            progress(actualSize, declaredSize);
            return new UpdateDownloadResult(parsed.FinalUri, actualSize, declaredSize);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private async Task<CurlResult> ProbeAsync(Uri uri, bool requireSize, CancellationToken cancellationToken)
    {
        UpdatePackageVerifier.ValidateDownloadUri(uri);
        var start = CreateStartInfo();
        AddCommonArguments(start);
        start.ArgumentList.Add("--head");
        start.ArgumentList.Add("--output");
        start.ArgumentList.Add("NUL");
        start.ArgumentList.Add("--write-out");
        start.ArgumentList.Add(WriteOutFormat);
        start.ArgumentList.Add(uri.AbsoluteUri);
        var result = await RunAsync(start, null, 0, null, cancellationToken).ConfigureAwait(false);
        var parsed = ParseResult(result.StandardOutput, requireSize);
        if (parsed.StatusCode != 200) throw new HttpRequestException($"GitHub Release probe returned HTTP {parsed.StatusCode}.");
        UpdatePackageVerifier.ValidateDownloadUri(parsed.FinalUri);
        return parsed;
    }

    private ProcessStartInfo CreateStartInfo() => new(curlPath)
    {
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
    };

    private static void AddCommonArguments(ProcessStartInfo start)
    {
        start.ArgumentList.Add("--disable");
        start.ArgumentList.Add("--silent");
        start.ArgumentList.Add("--show-error");
        start.ArgumentList.Add("--fail-with-body");
        start.ArgumentList.Add("--location");
        start.ArgumentList.Add("--max-redirs");
        start.ArgumentList.Add("5");
        start.ArgumentList.Add("--proto");
        start.ArgumentList.Add("=https");
        start.ArgumentList.Add("--proto-redir");
        start.ArgumentList.Add("=https");
        start.ArgumentList.Add("--connect-timeout");
        start.ArgumentList.Add("20");
        start.ArgumentList.Add("--max-time");
        start.ArgumentList.Add("300");
        start.ArgumentList.Add("--user-agent");
        start.ArgumentList.Add($"CodexScriptLoader/{LiveSupervisor.Version}");
    }

    private static string WriteOutFormat => $"{MarkerUrl}%{{url_effective}}\n{MarkerStatus}%{{http_code}}\n{MarkerSize}%header{{content-length}}\n";

    private static async Task<ProcessResult> RunAsync(
        ProcessStartInfo start,
        string? progressPath,
        long declaredSize,
        Action<long, long>? progress,
        CancellationToken cancellationToken)
    {
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Windows system curl did not start.");
        var stdout = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = process.StandardError.ReadToEndAsync(cancellationToken);
        try
        {
            while (!process.HasExited)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (progressPath is not null && declaredSize > 0)
                {
                    var length = File.Exists(progressPath) ? Math.Min(new FileInfo(progressPath).Length, declaredSize) : 0;
                    progress?.Invoke(length, declaredSize);
                }
                await Task.Delay(200, cancellationToken).ConfigureAwait(false);
            }
            await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
            {
                try { process.Kill(entireProcessTree: false); }
                catch (InvalidOperationException) { }
            }
            throw;
        }

        var output = await stdout.ConfigureAwait(false);
        var error = await stderr.ConfigureAwait(false);
        if (process.ExitCode != 0)
        {
            throw new HttpRequestException($"Windows system curl failed with exit code {process.ExitCode}: {SanitizeCurlError(error)}");
        }
        return new ProcessResult(output);
    }

    private static CurlResult ParseResult(string output, bool requireSize)
    {
        var lines = output.Replace("\r", string.Empty, StringComparison.Ordinal).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var urlText = lines.SingleOrDefault(line => line.StartsWith(MarkerUrl, StringComparison.Ordinal))?[MarkerUrl.Length..];
        var statusText = lines.SingleOrDefault(line => line.StartsWith(MarkerStatus, StringComparison.Ordinal))?[MarkerStatus.Length..];
        var sizeText = lines.SingleOrDefault(line => line.StartsWith(MarkerSize, StringComparison.Ordinal))?[MarkerSize.Length..];
        if (!Uri.TryCreate(urlText, UriKind.Absolute, out var finalUri) ||
            !int.TryParse(statusText, NumberStyles.None, CultureInfo.InvariantCulture, out var statusCode))
        {
            throw new InvalidDataException("Windows system curl returned malformed Release metadata.");
        }
        long? contentLength = null;
        if (!string.IsNullOrWhiteSpace(sizeText))
        {
            if (!long.TryParse(sizeText, NumberStyles.None, CultureInfo.InvariantCulture, out var size) || size < 0)
            {
                throw new InvalidDataException("GitHub Release content length is invalid.");
            }
            contentLength = size;
        }
        if (requireSize && contentLength is null) throw new InvalidDataException("GitHub Release asset has no declared size.");
        return new CurlResult(finalUri, statusCode, contentLength);
    }

    private static string SanitizeCurlError(string value)
    {
        var line = value.Replace("\r", string.Empty, StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .FirstOrDefault() ?? "request failed";
        return line.Length <= 180 ? line : line[..180];
    }

    private sealed record ProcessResult(string StandardOutput);
    private sealed record CurlResult(Uri FinalUri, int StatusCode, long? ContentLength);
}
