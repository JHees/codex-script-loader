using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed record HandoffCandidateOptions(string TransactionPath, string PipeName, string Token)
{
    public static HandoffCandidateOptions? Parse(string[] args, LoaderPaths paths)
    {
        var transaction = ReadOption(args, "--handoff-transaction");
        if (transaction is null) return null;
        var pipe = ReadOption(args, "--handoff-pipe") ?? throw new ArgumentException("Missing --handoff-pipe.");
        var token = ReadOption(args, "--handoff-token") ?? throw new ArgumentException("Missing --handoff-token.");
        if (!string.Equals(Path.GetFullPath(transaction), Path.GetFullPath(paths.UpdateTransactionPath), StringComparison.OrdinalIgnoreCase) ||
            pipe.Length > 200 || token.Length != 64 || !token.All(Uri.IsHexDigit))
        {
            throw new InvalidDataException("Handoff candidate arguments are invalid.");
        }

        return new HandoffCandidateOptions(transaction, pipe, token);
    }

    private static string? ReadOption(string[] args, string name)
    {
        var index = Array.FindIndex(args, argument => string.Equals(argument, name, StringComparison.OrdinalIgnoreCase));
        if (index < 0) return null;
        if (index + 1 >= args.Length || string.IsNullOrWhiteSpace(args[index + 1])) throw new ArgumentException($"Missing value for {name}.");
        return args[index + 1];
    }
}

internal sealed class HandoffRolledBackException : Exception
{
    public HandoffRolledBackException(string message, Exception innerException) : base(message, innerException) { }
}

internal static class HostHandoffCoordinator
{
    public static async Task SwitchAsync(
        StagedUpdate staged,
        LoaderPaths paths,
        LiveSupervisor supervisor,
        SingleInstanceCoordinator instance,
        JsonlLogger logger,
        Action committed,
        CancellationToken cancellationToken)
    {
        var snapshot = supervisor.Snapshot;
        var endpoint = snapshot.Cdp ?? throw new InvalidOperationException("Managed Codex endpoint is unavailable for update handoff.");
        if (snapshot.State is not (LoaderState.Healthy or LoaderState.Degraded)) throw new InvalidOperationException("Loader is not healthy enough to hand off.");

        var id = Guid.NewGuid().ToString("N");
        var transaction = new UpdateTransaction(1, id, UpdateStage.Switching, LiveSupervisor.Version, staged.Manifest.Version, staged.Pointer.Rid,
            Environment.ProcessId, null, endpoint, snapshot.ActivationProcessId, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, null);
        await AtomicJsonFile.WriteAsync(paths.UpdateTransactionPath, transaction, cancellationToken).ConfigureAwait(false);

        var pipeName = $"CodexScriptLoader.handoff.v1.{Environment.ProcessId}.{id}";
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        var hostPath = Path.Combine(staged.VersionDirectory, staged.Pointer.EntryPoint);
        var start = new ProcessStartInfo(hostPath)
        {
            UseShellExecute = false,
            WorkingDirectory = staged.VersionDirectory,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        start.ArgumentList.Add("--handoff-transaction");
        start.ArgumentList.Add(paths.UpdateTransactionPath);
        start.ArgumentList.Add("--handoff-pipe");
        start.ArgumentList.Add(pipeName);
        start.ArgumentList.Add("--handoff-token");
        start.ArgumentList.Add(token);
        using var candidate = Process.Start(start) ?? throw new InvalidOperationException("Candidate Loader host did not start.");
        transaction = transaction with { CandidateHostPid = candidate.Id, UpdatedAt = DateTimeOffset.UtcNow };
        await AtomicJsonFile.WriteAsync(paths.UpdateTransactionPath, transaction, cancellationToken).ConfigureAwait(false);
        var released = false;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(45));
            await pipe.WaitForConnectionAsync(timeout.Token).ConfigureAwait(false);
            using var reader = new StreamReader(pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
            var prepared = await reader.ReadLineAsync(timeout.Token).ConfigureAwait(false);
            if (prepared != $"{token}:prepared") throw new InvalidDataException("Candidate Loader did not authenticate its prepared state.");
            await supervisor.SuspendForHandoffAsync().ConfigureAwait(false);
            await instance.ReleaseOwnershipAsync().ConfigureAwait(false);
            released = true;
            await writer.WriteLineAsync($"{token}:release".AsMemory(), timeout.Token).ConfigureAwait(false);
            var result = await reader.ReadLineAsync(timeout.Token).ConfigureAwait(false);
            if (result != $"{token}:committed") throw new InvalidDataException("Candidate Loader did not commit the handoff.");
            logger.Info("update-handoff-committed", new { transaction.Id, candidatePid = candidate.Id, version = staged.Manifest.Version, endpoint.Port, endpoint.OwnerPid });
            committed();
        }
        catch (Exception exception) when (exception is IOException or InvalidDataException or InvalidOperationException or OperationCanceledException)
        {
            if (!candidate.HasExited)
            {
                try
                {
                    candidate.Kill(entireProcessTree: false);
                    await candidate.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                }
                catch (InvalidOperationException) { }
                catch (TimeoutException) { }
            }
            if (released && !await instance.TryAcquireAsync(TimeSpan.FromSeconds(5), CancellationToken.None).ConfigureAwait(false))
            {
                logger.Error("handoff-lock-recovery-failed", exception);
            }
            var activePointer = await AtomicJsonFile.ReadAsync<InstallPointer>(staged.Layout.ActivePointerPath, CancellationToken.None).ConfigureAwait(false);
            if (activePointer?.Version == staged.Pointer.Version)
            {
                var previousPointer = await AtomicJsonFile.ReadAsync<InstallPointer>(staged.Layout.PreviousPointerPath, CancellationToken.None).ConfigureAwait(false);
                if (previousPointer is not null) await AtomicJsonFile.WriteAsync(staged.Layout.ActivePointerPath, previousPointer, CancellationToken.None).ConfigureAwait(false);
            }
            await supervisor.RestoreAfterHandoffFailureAsync(CancellationToken.None).ConfigureAwait(false);
            transaction = transaction with { State = UpdateStage.RolledBack, UpdatedAt = DateTimeOffset.UtcNow, Error = JsonlLogger.Redact(exception.Message) };
            await AtomicJsonFile.WriteAsync(paths.UpdateTransactionPath, transaction, CancellationToken.None).ConfigureAwait(false);
            logger.Warn("update-handoff-rolled-back", new { transaction.Id, message = JsonlLogger.Redact(exception.Message) });
            throw new HandoffRolledBackException("The candidate Loader failed before commit; the current Loader was restored.", exception);
        }
    }

    public static async Task RunCandidateAsync(
        HandoffCandidateOptions options,
        LoaderPaths paths,
        LiveSupervisor supervisor,
        SingleInstanceCoordinator instance,
        JsonlLogger logger,
        CancellationToken cancellationToken)
    {
        var transaction = await AtomicJsonFile.ReadAsync<UpdateTransaction>(options.TransactionPath, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("Update transaction is missing.");
        if (transaction.SchemaVersion != 1 || transaction.State != UpdateStage.Switching || transaction.TargetVersion != LiveSupervisor.Version || transaction.CandidateHostPid != Environment.ProcessId)
        {
            throw new InvalidDataException("Update transaction does not identify this candidate host.");
        }

        await using var pipe = new NamedPipeClientStream(".", options.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(10000, cancellationToken).ConfigureAwait(false);
        using var reader = new StreamReader(pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
        await supervisor.AdoptAsync(transaction, cancellationToken).ConfigureAwait(false);
        await writer.WriteLineAsync($"{options.Token}:prepared".AsMemory(), cancellationToken).ConfigureAwait(false);
        var release = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
        if (release != $"{options.Token}:release") throw new InvalidDataException("Old Loader did not authorize lock transfer.");
        if (!await instance.TryAcquireAsync(TimeSpan.FromSeconds(10), cancellationToken).ConfigureAwait(false)) throw new InvalidOperationException("Candidate Loader could not acquire single-instance ownership.");

        var layout = VersionedInstallLayout.TryFromHostBaseDirectory(AppContext.BaseDirectory)
            ?? throw new InvalidOperationException("Candidate host is outside a versioned installation.");
        var active = await AtomicJsonFile.ReadAsync<InstallPointer>(layout.ActivePointerPath, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("Active Loader pointer is missing.");
        var next = new InstallPointer(1, transaction.TargetVersion, transaction.Rid, "CodexScriptLoader.exe", OnlineUpdateManager.LauncherProtocol, OnlineUpdateManager.HandoffProtocol);
        _ = layout.ResolveHostPath(next);
        await AtomicJsonFile.WriteAsync(layout.PreviousPointerPath, active, cancellationToken).ConfigureAwait(false);
        await AtomicJsonFile.WriteAsync(layout.ActivePointerPath, next, cancellationToken).ConfigureAwait(false);
        supervisor.CommitHandoff();
        transaction = transaction with { State = UpdateStage.Succeeded, UpdatedAt = DateTimeOffset.UtcNow, Error = null };
        await AtomicJsonFile.WriteAsync(paths.UpdateTransactionPath, transaction, cancellationToken).ConfigureAwait(false);
        await writer.WriteLineAsync($"{options.Token}:committed".AsMemory(), cancellationToken).ConfigureAwait(false);
        logger.Info("update-handoff-candidate-committed", new { transaction.Id, transaction.CurrentVersion, transaction.TargetVersion, endpointPort = transaction.Endpoint.Port });
    }
}
