namespace CodexScriptLoader.Windows;

internal enum ManagedCodexLifecycleAction
{
    Continue,
    ReportUpdate,
    Exit,
}

/// <summary>
/// A single injected observation of the managed Codex lifecycle. The monitor
/// samples CDP targets, package-family processes, package registration, and
/// the registered package version; the decision itself is a pure function of
/// this snapshot.
/// </summary>
internal readonly record struct ManagedCodexLifecycleSnapshot(
    DateTimeOffset Now,
    bool TargetPresent,
    int PackageProcessCount,
    Version? ManagedVersion,
    Version? InstalledVersion,
    bool PackageRegistered,
    DateTimeOffset? CloseEmptySince,
    bool UpdateReported);

internal readonly record struct ManagedCodexLifecycleDecision(
    ManagedCodexLifecycleAction Action,
    DateTimeOffset? CloseEmptySince,
    string Reason);

/// <summary>
/// Decides whether the Loader keeps running, reconnects after a Codex package
/// update, or exits after an ordinary close. PID liveness and window
/// visibility are deliberately not part of the decision: a Store app update
/// replaces its processes, and a hidden window can still own a CDP renderer.
/// </summary>
internal static class ManagedCodexLifecyclePolicy
{
    /// <summary>Grace period after the last package-family process disappears.</summary>
    internal static readonly TimeSpan CloseExitGracePeriod = TimeSpan.FromSeconds(2);

    /// <summary>
    /// A Store update can unregister the old package before the new one is
    /// registered. During that window the Loader waits much longer instead of
    /// treating the unregistered package as an ordinary close.
    /// </summary>
    internal static readonly TimeSpan PackageUnregisteredGracePeriod = TimeSpan.FromMinutes(3);

    internal static ManagedCodexLifecycleDecision Evaluate(ManagedCodexLifecycleSnapshot snapshot)
    {
        if (snapshot.TargetPresent)
        {
            return new(ManagedCodexLifecycleAction.Continue, null, "target-present");
        }

        if (!snapshot.UpdateReported && IsVersionUpgrade(snapshot.ManagedVersion, snapshot.InstalledVersion))
        {
            return new(ManagedCodexLifecycleAction.ReportUpdate, snapshot.CloseEmptySince, "package-updated");
        }

        if (snapshot.PackageProcessCount > 0)
        {
            return new(ManagedCodexLifecycleAction.Continue, null, "package-processes-present");
        }

        // CloseEmptySince is the start of the current grace window. The tracker
        // restarts it when package registration appears or disappears, so the
        // selected period below is always measured from the latest lifecycle
        // transition rather than from an unrelated earlier close.
        var emptySince = snapshot.CloseEmptySince ?? snapshot.Now;
        if (snapshot.Now - emptySince >= GracePeriodFor(snapshot.PackageRegistered))
        {
            return new(
                ManagedCodexLifecycleAction.Exit,
                emptySince,
                snapshot.PackageRegistered ? "closed" : "package-unregistered");
        }

        return new(
            ManagedCodexLifecycleAction.Continue,
            emptySince,
            snapshot.PackageRegistered ? "close-grace" : "awaiting-package-registration");
    }

    internal static TimeSpan GracePeriodFor(bool packageRegistered) =>
        packageRegistered ? CloseExitGracePeriod : PackageUnregisteredGracePeriod;

    internal static bool IsGrace(ManagedCodexLifecycleDecision decision) =>
        decision.Action == ManagedCodexLifecycleAction.Continue &&
        decision.Reason is "close-grace" or "awaiting-package-registration";

    internal static bool IsVersionUpgrade(Version? managedVersion, Version? installedVersion) =>
        managedVersion is not null && installedVersion is not null && installedVersion > managedVersion;
}

/// <summary>
/// Holds the lifecycle state that outlives a single observation: the start of
/// the current grace window, whether the package update has already been
/// reported, and the last observed package registration state. A managed
/// session (re)start resets it so a later ordinary close can be reported again.
/// </summary>
internal sealed class ManagedCodexLifecycleTracker
{
    private readonly object gate = new();
    private DateTimeOffset? restartUntil;
    private DateTimeOffset? closeEmptySince;
    private bool updateReported;
    private bool? packageRegistered;

    internal ManagedCodexLifecycleDecision Observe(
        DateTimeOffset now,
        bool targetPresent,
        int packageProcessCount,
        Version? managedVersion,
        Version? installedVersion,
        bool packageRegistered = true)
    {
        lock (gate) return ObserveCore(now, targetPresent, packageProcessCount, managedVersion, installedVersion, packageRegistered);
    }

    private ManagedCodexLifecycleDecision ObserveCore(DateTimeOffset now, bool targetPresent, int packageProcessCount,
        Version? managedVersion, Version? installedVersion, bool packageRegistered)
    {
        if (this.packageRegistered != packageRegistered)
        {
            // Registration appearing or disappearing starts a new grace regime:
            // a returning same-version package gets the short close grace again,
            // while a disappearing package switches to the long update window.
            closeEmptySince = null;
            this.packageRegistered = packageRegistered;
        }

        if (restartUntil is { } until && now >= until) restartUntil = null;
        if (!targetPresent && restartUntil is not null && !updateReported)
        {
            updateReported = true;
            return new(ManagedCodexLifecycleAction.ReportUpdate, null, "restart-requested");
        }
        var decision = ManagedCodexLifecyclePolicy.Evaluate(new ManagedCodexLifecycleSnapshot(
            now,
            targetPresent,
            packageProcessCount,
            managedVersion,
            installedVersion,
            packageRegistered,
            closeEmptySince,
            updateReported));
        closeEmptySince = decision.CloseEmptySince;
        if (decision.Action == ManagedCodexLifecycleAction.ReportUpdate) updateReported = true;
        return decision;
    }

    internal void Reset()
    {
        lock (gate)
        {
            closeEmptySince = null;
            updateReported = false;
            packageRegistered = null;
            restartUntil = null;
        }
    }

    internal void ReportIntent(string intent, DateTimeOffset now)
    {
        lock (gate)
        {
            restartUntil = intent switch
            {
                "restart" => now + ManagedCodexLifecyclePolicy.PackageUnregisteredGracePeriod,
                "cancel-restart" => null,
                _ => throw new ArgumentException("Unknown Codex lifecycle intent.", nameof(intent)),
            };
        }
    }
}
