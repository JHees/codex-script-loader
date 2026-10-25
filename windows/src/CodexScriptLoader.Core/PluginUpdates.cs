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
                await CheckSkillAsync(candidate, cancellationToken).ConfigureAwait(false);
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
            await ReloadConfigAsync(cancellationToken).ConfigureAwait(false);
            if (configInvalid) throw new InvalidDataException("Loader configuration is invalid; refusing to update a plugin.");
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
            var previousDescriptor = await LoadDescriptorAsync(target, cancellationToken).ConfigureAwait(false);
            var actualFingerprint = await ComputeDirectoryFingerprintAsync(target, cancellationToken).ConfigureAwait(false);
            var candidateFingerprint = await ComputeDirectoryFingerprintAsync(pending.PackageRoot, cancellationToken).ConfigureAwait(false);
            if (!string.Equals(actualFingerprint, expectedInstalledFingerprint, StringComparison.Ordinal))
            {
                if (Directory.Exists(pending.StageRoot)) Directory.Delete(pending.StageRoot, recursive: true);
                throw new PluginUpdateStateChangedException("Installed plugin changed after the update was prepared.");
            }

            var pendingRoot = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "pending"), "Pending package root");
            var backup = paths.EnsureWithin(pendingRoot, Path.Combine(pendingRoot, $"rollback-{token}"), "Plugin update backup");
            try { CopyPackageFiles(target, backup, replace: false, cancellationToken); }
            catch { TryDeleteDirectory(backup); TryDeleteDirectory(pending.StageRoot); throw; }
            if (!string.Equals(await ComputeDirectoryFingerprintAsync(backup, cancellationToken).ConfigureAwait(false), expectedInstalledFingerprint, StringComparison.Ordinal))
            {
                TryDeleteDirectory(backup);
                TryDeleteDirectory(pending.StageRoot);
                throw new InvalidDataException("Plugin backup differs from the verified installed package.");
            }
            var transaction = new PluginUpdateTransaction(2, token, pending.Descriptor.Id, target, backup, pending.StageRoot, pending.PackageRoot, "prepared", expectedInstalledFingerprint);
            try { await AtomicJsonFile.WriteAsync(paths.PluginUpdateTransactionPath, transaction, cancellationToken).ConfigureAwait(false); }
            catch { TryDeleteDirectory(backup); throw; }
            var candidateActivationAttempted = false;
            var filesStarted = false;
            try
            {
                var unchangedFingerprint = await ComputeDirectoryFingerprintAsync(target, cancellationToken).ConfigureAwait(false);
                if (!string.Equals(unchangedFingerprint, expectedInstalledFingerprint, StringComparison.Ordinal))
                    throw new PluginUpdateStateChangedException("Installed plugin changed while its rollback copy was made.");
                filesStarted = true;
                ReplacePackageFiles(pending.PackageRoot, target, cancellationToken);
                var installedCandidateFingerprint = await ComputeDirectoryFingerprintAsync(target, cancellationToken).ConfigureAwait(false);
                if (!string.Equals(installedCandidateFingerprint, candidateFingerprint, StringComparison.Ordinal))
                    throw new InvalidDataException("Installed plugin files differ from the verified candidate.");
                transaction = transaction with { State = "candidate-installed" };
                await AtomicJsonFile.WriteAsync(paths.PluginUpdateTransactionPath, transaction, cancellationToken).ConfigureAwait(false);
                await SyncSkillAsync(pending.Descriptor, globalEnabled && !safeMode && (!enabledOverrides.TryGetValue(pending.Descriptor.Id, out var enabled) || enabled), cancellationToken).ConfigureAwait(false);
                candidateActivationAttempted = true;
                await activateCandidate(cancellationToken).ConfigureAwait(false);
                transaction = transaction with { State = "committed" };
                await AtomicJsonFile.WriteAsync(paths.PluginUpdateTransactionPath, transaction, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception updateException)
            {
                try
                {
                    if (filesStarted && Directory.Exists(backup))
                    {
                        RestorePackageFiles(backup, target);
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
                if (updateException is PluginUpdateStateChangedException)
                {
                    TryDeleteDirectory(backup);
                    TryDeleteDirectory(pending.StageRoot);
                    TryDeleteFile(paths.PluginUpdateTransactionPath);
                    throw;
                }
                Exception? restoreException = null;
                try
                {
                    await SyncSkillAsync(previousDescriptor, globalEnabled && !safeMode && (!enabledOverrides.TryGetValue(previousDescriptor.Id, out var enabled) || enabled), CancellationToken.None).ConfigureAwait(false);
                    if (candidateActivationAttempted) await restorePreviousRuntime(CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception exception) { restoreException = exception; }
                finally
                {
                    var rollbackBackupRemoved = TryDeleteDirectory(backup);
                    var rollbackStageRemoved = TryDeleteDirectory(pending.StageRoot);
                    if (rollbackBackupRemoved && rollbackStageRemoved) TryDeleteFile(paths.PluginUpdateTransactionPath);
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
        if (transaction.SchemaVersion is not (1 or 2) || !ScriptIdRegex().IsMatch(transaction.PluginId) || transaction.Token.Length != 36 ||
            transaction.Token.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')) ||
            (transaction.SchemaVersion == 1 && transaction.State is not ("prepared" or "backup-created" or "candidate-installed" or "committed")) ||
            (transaction.SchemaVersion == 2 && transaction.State is not ("prepared" or "candidate-installed" or "committed")))
        {
            throw new InvalidDataException("Plugin update transaction journal is invalid.");
        }
        var target = paths.EnsureWithin(paths.ScriptsRoot, transaction.Target, "Recovered plugin target");
        var backup = paths.EnsureWithin(paths.StateRoot, transaction.Backup, "Recovered plugin backup");
        var stageRoot = paths.EnsureWithin(paths.StateRoot, transaction.StageRoot, "Recovered plugin stage");
        var expectedTarget = paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, transaction.PluginId), "Expected plugin target");
        var pendingRoot = paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, "pending"), "Pending package root");
        var expectedBackup = transaction.SchemaVersion == 1
            ? paths.EnsureWithin(paths.StateRoot, Path.Combine(paths.StateRoot, $"plugin-update-backup-{transaction.Token}"), "Expected plugin backup")
            : paths.EnsureWithin(pendingRoot, Path.Combine(pendingRoot, $"rollback-{transaction.Token}"), "Expected plugin backup");
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
            if (!backupRemoved || !stageRemoved) throw new IOException("Committed plugin update cleanup must finish before startup.");
            TryDeleteFile(paths.PluginUpdateTransactionPath);
            return;
        }
        if (transaction.SchemaVersion == 2)
        {
            if (!Directory.Exists(backup)) throw new IOException("Plugin update rollback copy is unavailable.");
            if (transaction.BackupFingerprint is null || !string.Equals(
                await ComputeDirectoryFingerprintAsync(backup, cancellationToken).ConfigureAwait(false), transaction.BackupFingerprint, StringComparison.Ordinal))
                throw new InvalidDataException("Plugin update rollback copy does not match its verified fingerprint.");
            if (!Directory.Exists(target)) CopyPackageFiles(backup, target, replace: false, cancellationToken);
            else RestorePackageFiles(backup, target);
            if (!string.Equals(await ComputeDirectoryFingerprintAsync(target, cancellationToken).ConfigureAwait(false), transaction.BackupFingerprint, StringComparison.Ordinal))
                throw new InvalidDataException("Recovered plugin files differ from the rollback copy.");
            var stageRemoved = TryDeleteDirectory(stageRoot);
            var backupRemoved = TryDeleteDirectory(backup);
            if (!stageRemoved || !backupRemoved) throw new IOException("Plugin update recovery cleanup must finish before startup.");
            TryDeleteFile(paths.PluginUpdateTransactionPath);
            return;
        }
        if (Directory.Exists(backup))
        {
            if (!Directory.Exists(target)) Directory.Move(backup, target);
            else
            {
                RestorePackageFiles(backup, target);
                if (!TryDeleteDirectory(backup)) return;
            }
        }
        if (Directory.Exists(stageRoot)) Directory.Delete(stageRoot, recursive: true);
        File.Delete(paths.PluginUpdateTransactionPath);
    }

    private static void CopyPackageFiles(string source, string target, bool replace, CancellationToken cancellationToken)
    {
        foreach (var directory in EnumerateSafePackageDirectories(source))
        {
            cancellationToken.ThrowIfCancellationRequested();
            Directory.CreateDirectory(TransferPath(source, target, directory));
        }
        foreach (var file in EnumerateSafePackageFiles(source))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var destination = TransferPath(source, target, file.Path);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file.Path, destination, overwrite: replace);
        }
    }

    private static void ReplacePackageFiles(string source, string target, CancellationToken cancellationToken)
    {
        var files = EnumerateSafePackageFiles(source);
        var candidateFiles = files.ToDictionary(file => file.RelativePath, StringComparer.OrdinalIgnoreCase);
        foreach (var file in EnumerateSafePackageFiles(target))
        {
            if (!candidateFiles.TryGetValue(file.RelativePath, out var candidate) || !string.Equals(file.RelativePath, candidate.RelativePath, StringComparison.Ordinal)) File.Delete(file.Path);
        }
        RemoveConflictingDirectories(target, candidateFiles.Keys);
        foreach (var directory in EnumerateSafePackageDirectories(source).OrderBy(directory => directory.Length))
            Directory.CreateDirectory(TransferPath(source, target, directory));
        foreach (var file in files.OrderBy(entry => string.Equals(entry.RelativePath, "manifest.json", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
                     .ThenBy(entry => entry.RelativePath, StringComparer.OrdinalIgnoreCase))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var destination = TransferPath(source, target, file.Path);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            ReplaceFile(file.Path, destination);
        }
    }

    private static void RestorePackageFiles(string backup, string target)
    {
        ReplacePackageFiles(backup, target, CancellationToken.None);
    }

    private static void RemoveConflictingDirectories(string target, IEnumerable<string> filePaths)
    {
        var files = filePaths.ToArray();
        foreach (var directory in EnumerateSafePackageDirectories(target).OrderByDescending(directory => directory.Length))
        {
            var relative = Path.GetRelativePath(target, directory).Replace(Path.DirectorySeparatorChar, '/');
            if (files.Any(file => string.Equals(relative, file, StringComparison.OrdinalIgnoreCase) || relative.StartsWith(file + "/", StringComparison.OrdinalIgnoreCase)))
                Directory.Delete(directory, recursive: false);
        }
    }

    private static void ReplaceFile(string source, string destination)
    {
        var temporary = destination + ".plugin-update-" + Guid.NewGuid().ToString("N");
        try
        {
            File.Copy(source, temporary, overwrite: false);
            File.Move(temporary, destination, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static string TransferPath(string sourceRoot, string targetRoot, string sourcePath)
    {
        var relative = Path.GetRelativePath(sourceRoot, sourcePath);
        var root = Path.GetFullPath(targetRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var target = Path.GetFullPath(Path.Combine(targetRoot, relative));
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Plugin package entry escapes its root.");
        return target;
    }

    private static IReadOnlyList<string> EnumerateSafePackageDirectories(string root)
    {
        ValidatePackageRoot(root);
        var pending = new Stack<string>();
        var directories = new List<string>();
        pending.Push(Path.GetFullPath(root));
        while (pending.TryPop(out var parent))
        {
            foreach (var directory in Directory.EnumerateDirectories(parent, "*", SearchOption.TopDirectoryOnly))
            {
                if (File.GetAttributes(directory).HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("Plugin packages cannot contain links or reparse points.");
                directories.Add(directory);
                pending.Push(directory);
            }
        }
        return directories;
    }

    private static IReadOnlyList<(string Path, string RelativePath)> EnumerateSafePackageFiles(string root)
    {
        ValidatePackageRoot(root);
        var fullRoot = Path.GetFullPath(root);
        var pending = new Stack<string>();
        var files = new List<(string, string)>();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        pending.Push(fullRoot);
        while (pending.TryPop(out var parent))
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries(parent, "*", SearchOption.TopDirectoryOnly))
            {
                var attributes = File.GetAttributes(entry);
                if (attributes.HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("Plugin packages cannot contain links or reparse points.");
                if (attributes.HasFlag(FileAttributes.Directory)) { pending.Push(entry); continue; }
                var relative = Path.GetRelativePath(fullRoot, entry).Replace(Path.DirectorySeparatorChar, '/');
                if (!paths.Add(relative)) throw new InvalidDataException("Plugin package contains colliding paths.");
                files.Add((entry, relative));
            }
        }
        return files;
    }

    private static void ValidatePackageRoot(string root)
    {
        var directory = Path.GetFullPath(root);
        if (!Directory.Exists(directory) || File.GetAttributes(directory).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("Plugin package root is missing or linked.");
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
        string State,
        string? BackupFingerprint = null);
}
