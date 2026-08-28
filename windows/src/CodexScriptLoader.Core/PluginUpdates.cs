using System.Security.Cryptography;
using System.Text;

namespace CodexScriptLoader.Core;

public sealed class PluginUpdateRollbackException(string message, Exception innerException) : Exception(message, innerException);
public sealed class PluginUpdateStateChangedException(string message) : InvalidOperationException(message);

public sealed partial class ScriptRegistry
{
    public async Task<string> ComputePackageFingerprintAsync(string id, CancellationToken cancellationToken = default)
    {
        if (!ScriptIdRegex().IsMatch(id)) throw new ArgumentException("Invalid plugin id.", nameof(id));
        var directory = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, id), "Installed plugin");
        _ = await LoadDescriptorAsync(directory, cancellationToken).ConfigureAwait(false);
        return await ComputeDirectoryFingerprintAsync(directory, cancellationToken).ConfigureAwait(false);
    }

    public async Task<PluginUpdatePreview> StageUpdatePackageAsync(
        string archivePath,
        string expectedId,
        string expectedVersion,
        PluginUpdateDescriptor expectedUpdate,
        string expectedArchiveHash,
        CancellationToken cancellationToken = default)
    {
        if (!ScriptIdRegex().IsMatch(expectedId)) throw new ArgumentException("Invalid plugin id.", nameof(expectedId));
        if (bundledIds.Contains(expectedId)) throw new InvalidOperationException("Bundled plugins are updated with the Loader.");
        var actualHash = await UpdatePackageVerifier.ComputeSha256Async(archivePath, cancellationToken).ConfigureAwait(false);
        if (!string.Equals(actualHash, expectedArchiveHash, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Plugin update archive SHA-256 does not match.");

        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            CleanupExpiredPendingPackages();
            var installedDirectory = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, expectedId), "Installed plugin");
            var installed = await LoadDescriptorAsync(installedDirectory, cancellationToken).ConfigureAwait(false);
            if (installed.Update is null || installed.Update != expectedUpdate) throw new InvalidDataException("Installed plugin update source changed.");
            if (VersionedInstallLayout.CompareVersions(expectedVersion, installed.Version) <= 0) throw new InvalidDataException("Plugin update must be newer than the installed version.");
            var currentFingerprint = await ComputeDirectoryFingerprintAsync(installedDirectory, cancellationToken).ConfigureAwait(false);

            var pendingRoot = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "pending"), "Pending package root");
            Directory.CreateDirectory(pendingRoot);
            var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(18));
            var stageRoot = paths.EnsureWithin(pendingRoot, Path.Combine(pendingRoot, token), "Pending plugin update");
            Directory.CreateDirectory(stageRoot);
            try
            {
                await ExtractArchiveAsync(archivePath, stageRoot, cancellationToken).ConfigureAwait(false);
                var packageRoot = FindPackageRoot(stageRoot);
                var candidate = await LoadDescriptorAsync(packageRoot, cancellationToken).ConfigureAwait(false);
                if (!string.Equals(candidate.Id, expectedId, StringComparison.Ordinal) ||
                    !string.Equals(candidate.Version, expectedVersion, StringComparison.Ordinal) ||
                    candidate.Update != expectedUpdate)
                {
                    throw new InvalidDataException("Plugin update identity, version, or source does not match the installed package.");
                }

                var pending = new PendingPackage(token, stageRoot, packageRoot, candidate, DateTimeOffset.UtcNow);
                pendingPackages[token] = pending;
                var newPermissions = candidate.Permissions.Except(installed.Permissions, StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray();
                return new PluginUpdatePreview(token, expectedId, installed.Version, candidate.Version, actualHash, currentFingerprint, newPermissions);
            }
            catch
            {
                if (Directory.Exists(stageRoot)) Directory.Delete(stageRoot, recursive: true);
                throw;
            }
        }
        finally
        {
            registryMutation.Release();
        }
    }

    public async Task ApplyPendingUpdateAsync(
        string token,
        string expectedInstalledFingerprint,
        Func<CancellationToken, Task> activateCandidate,
        Func<CancellationToken, Task> restorePreviousRuntime,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(activateCandidate);
        ArgumentNullException.ThrowIfNull(restorePreviousRuntime);
        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!pendingPackages.Remove(token, out var pending))
            {
                throw new PluginUpdateStateChangedException("Plugin update preview expired.");
            }
            if (DateTimeOffset.UtcNow - pending.CreatedAt > TimeSpan.FromMinutes(10))
            {
                if (Directory.Exists(pending.StageRoot)) Directory.Delete(pending.StageRoot, recursive: true);
                throw new PluginUpdateStateChangedException("Plugin update preview expired.");
            }

            var target = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, pending.Descriptor.Id), "Plugin update target");
            var actualFingerprint = await ComputeDirectoryFingerprintAsync(target, cancellationToken).ConfigureAwait(false);
            if (!string.Equals(actualFingerprint, expectedInstalledFingerprint, StringComparison.Ordinal))
            {
                if (Directory.Exists(pending.StageRoot)) Directory.Delete(pending.StageRoot, recursive: true);
                throw new PluginUpdateStateChangedException("Installed plugin changed after the update was prepared.");
            }

            var backup = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, $"plugin-update-backup-{token}"), "Plugin update backup");
            var transaction = new PluginUpdateTransaction(1, token, pending.Descriptor.Id, target, backup, pending.StageRoot, pending.PackageRoot, "prepared");
            await AtomicJsonFile.WriteAsync(paths.PluginUpdateTransactionPath, transaction, cancellationToken).ConfigureAwait(false);
            var candidateActivationAttempted = false;
            try
            {
                Directory.Move(target, backup);
                transaction = transaction with { State = "backup-created" };
                await AtomicJsonFile.WriteAsync(paths.PluginUpdateTransactionPath, transaction, cancellationToken).ConfigureAwait(false);
                Directory.Move(pending.PackageRoot, target);
                transaction = transaction with { State = "candidate-installed" };
                await AtomicJsonFile.WriteAsync(paths.PluginUpdateTransactionPath, transaction, cancellationToken).ConfigureAwait(false);
                candidateActivationAttempted = true;
                await activateCandidate(cancellationToken).ConfigureAwait(false);
                transaction = transaction with { State = "committed" };
                await AtomicJsonFile.WriteAsync(paths.PluginUpdateTransactionPath, transaction, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception updateException)
            {
                try
                {
                    if (Directory.Exists(backup))
                    {
                        if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
                        Directory.Move(backup, target);
                    }
                    else if (!Directory.Exists(target))
                    {
                        throw new IOException("Plugin update backup is unavailable.");
                    }
                }
                catch (Exception restorePackageException)
                {
                    throw new PluginUpdateRollbackException(
                        "The previous plugin package could not be restored.",
                        new AggregateException(updateException, restorePackageException));
                }
                Exception? restoreException = null;
                try
                {
                    if (candidateActivationAttempted) await restorePreviousRuntime(CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception exception) { restoreException = exception; }
                finally
                {
                    TryDeleteDirectory(pending.StageRoot);
                    TryDeleteFile(paths.PluginUpdateTransactionPath);
                }
                if (restoreException is not null)
                {
                    throw new PluginUpdateRollbackException(
                        "The previous plugin package was restored, but its runtime could not be restarted.",
                        new AggregateException(updateException, restoreException));
                }
                throw;
            }
            var backupRemoved = TryDeleteDirectory(backup);
            var stageRemoved = TryDeleteDirectory(pending.StageRoot);
            if (backupRemoved && stageRemoved) TryDeleteFile(paths.PluginUpdateTransactionPath);
        }
        finally
        {
            registryMutation.Release();
        }
    }

    public async Task CancelPendingUpdateAsync(string token, CancellationToken cancellationToken = default)
    {
        await registryMutation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (pendingPackages.Remove(token, out var pending) && Directory.Exists(pending.StageRoot))
            {
                Directory.Delete(pending.StageRoot, recursive: true);
            }
        }
        finally
        {
            registryMutation.Release();
        }
    }

    private async Task RecoverPendingPluginUpdateAsync(CancellationToken cancellationToken)
    {
        var transaction = await AtomicJsonFile.ReadAsync<PluginUpdateTransaction>(paths.PluginUpdateTransactionPath, cancellationToken).ConfigureAwait(false);
        if (transaction is null) return;
        if (transaction.SchemaVersion != 1 || !ScriptIdRegex().IsMatch(transaction.PluginId) || transaction.Token.Length != 36 ||
            transaction.Token.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')) ||
            transaction.State is not ("prepared" or "backup-created" or "candidate-installed" or "committed"))
        {
            throw new InvalidDataException("Plugin update transaction journal is invalid.");
        }
        var target = paths.EnsureWithin(paths.ScriptsRoot, transaction.Target, "Recovered plugin target");
        var backup = paths.EnsureWithin(paths.StateRoot, transaction.Backup, "Recovered plugin backup");
        var stageRoot = paths.EnsureWithin(paths.StateRoot, transaction.StageRoot, "Recovered plugin stage");
        var expectedTarget = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, transaction.PluginId), "Expected plugin target");
        var expectedBackup = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, $"plugin-update-backup-{transaction.Token}"), "Expected plugin backup");
        var pendingRoot = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "pending"), "Pending package root");
        var expectedStageRoot = paths.EnsureWithin(pendingRoot, Path.Combine(pendingRoot, transaction.Token), "Expected plugin stage");
        var packageRoot = Path.GetFullPath(transaction.PackageRoot);
        if (!string.Equals(target, expectedTarget, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(backup, expectedBackup, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(stageRoot, expectedStageRoot, StringComparison.OrdinalIgnoreCase) ||
            (!string.Equals(packageRoot, stageRoot, StringComparison.OrdinalIgnoreCase) &&
             !packageRoot.StartsWith(stageRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidDataException("Plugin update transaction paths do not match its identity.");
        }
        if (transaction.State == "committed")
        {
            var backupRemoved = TryDeleteDirectory(backup);
            var stageRemoved = TryDeleteDirectory(stageRoot);
            if (backupRemoved && stageRemoved) TryDeleteFile(paths.PluginUpdateTransactionPath);
            return;
        }
        if (Directory.Exists(backup))
        {
            if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
            Directory.Move(backup, target);
        }
        if (Directory.Exists(stageRoot)) Directory.Delete(stageRoot, recursive: true);
        File.Delete(paths.PluginUpdateTransactionPath);
    }

    private void CleanupOrphanedPendingPackages()
    {
        var pendingRoot = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "pending"), "Pending package root");
        if (!Directory.Exists(pendingRoot)) return;
        foreach (var directory in Directory.EnumerateDirectories(pendingRoot))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static async Task<string> ComputeDirectoryFingerprintAsync(string directory, CancellationToken cancellationToken)
    {
        var root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var path in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories).OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var info = new FileInfo(path);
            if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("Plugin packages cannot contain links or reparse points.");
            var relative = Path.GetFullPath(path)[root.Length..].Replace('\\', '/');
            hash.AppendData(Encoding.UTF8.GetBytes(relative));
            hash.AppendData([0]);
            await using var stream = info.OpenRead();
            var buffer = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0) hash.AppendData(buffer.AsSpan(0, read));
            hash.AppendData([0]);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static bool TryDeleteDirectory(string directory)
    {
        try
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
            return !Directory.Exists(directory);
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private sealed record PluginUpdateTransaction(
        int SchemaVersion,
        string Token,
        string PluginId,
        string Target,
        string Backup,
        string StageRoot,
        string PackageRoot,
        string State);
}
