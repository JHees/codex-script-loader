using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static readonly DateTimeOffset LifecycleTestStart = new(2026, 10, 23, 12, 0, 0, TimeSpan.Zero);

    private static void TestManagedCodexLifecyclePolicy()
    {
        var managed = new Version(26, 10, 1, 0);
        var older = new Version(26, 9, 30, 0);
        var upgraded = new Version(26, 10, 2, 0);

        var intentTracker = new ManagedCodexLifecycleTracker();
        intentTracker.ReportIntent("restart", LifecycleTestStart);
        Equal(ManagedCodexLifecycleAction.Continue, intentTracker.Observe(LifecycleTestStart, true, 2, managed, managed).Action,
            "An update request does not interrupt a connected renderer");
        Equal(ManagedCodexLifecycleAction.ReportUpdate, intentTracker.Observe(LifecycleTestStart.AddSeconds(1), false, 2, managed, managed).Action,
            "Explicit update intent starts recovery before Store registration changes");
        intentTracker.Reset();
        intentTracker.ReportIntent("restart", LifecycleTestStart);
        intentTracker.ReportIntent("cancel-restart", LifecycleTestStart);
        Equal(ManagedCodexLifecycleAction.Continue, intentTracker.Observe(LifecycleTestStart, false, 0, managed, managed).Action,
            "A rejected update request clears restart intent");
        Equal(ManagedCodexLifecycleAction.Exit, intentTracker.Observe(LifecycleTestStart.AddSeconds(2), false, 0, managed, managed).Action,
            "Ordinary exit still follows a rejected update");
        intentTracker.Reset();
        intentTracker.ReportIntent("restart", LifecycleTestStart);
        Equal(ManagedCodexLifecycleAction.Continue, intentTracker.Observe(LifecycleTestStart.AddMinutes(4), false, 0, managed, managed).Action,
            "An old update request expires before a later ordinary close");

        // A renderer target can disappear while Codex is still alive (hidden
        // window, renderer reload, update staging). Only package processes and
        // the registered package version decide the lifecycle.
        var decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: false, packageProcessCount: 3,
            managed, managed, closeEmptySince: null, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "Renderer loss with a live Codex package process keeps the Loader running");
        Equal("package-processes-present", decision.Reason,
            "A live package process is the reason the Loader keeps waiting");
        True(decision.CloseEmptySince is null,
            "A live package process never starts the close grace window");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromMinutes(5), targetPresent: false, packageProcessCount: 1,
            managed, managed, closeEmptySince: null, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "A long renderer outage with a live process remains recoverable");

        decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: true, packageProcessCount: 0,
            managed, upgraded, closeEmptySince: null, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "A present renderer target keeps the Loader running even while a newer package is registered");
        True(decision.CloseEmptySince is null,
            "A present renderer target never starts the close grace window");

        decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: false, packageProcessCount: 1,
            managed, older, closeEmptySince: null, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "An older registered package version is not treated as an update");

        decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: false, packageProcessCount: 1,
            managed, installedVersion: null, closeEmptySince: null, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "An unregistered or unparseable package version keeps the Loader waiting");

        decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: false, packageProcessCount: 0,
            managedVersion: null, upgraded, closeEmptySince: null, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "Without a managed package version the policy never guesses an update");

        // A newer registered package is an update even while the old processes
        // are still winding down, and it is reported only once.
        decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: false, packageProcessCount: 2,
            managed, upgraded, closeEmptySince: null, updateReported: false);
        Equal(ManagedCodexLifecycleAction.ReportUpdate, decision.Action,
            "A newer registered Codex package triggers update recovery");
        Equal("package-updated", decision.Reason, "Package update detection reason");

        decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: false, packageProcessCount: 0,
            managed, upgraded, closeEmptySince: null, updateReported: true);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "An already reported package update is not reported a second time");

        // Ordinary close: a short grace window before the Loader exits.
        decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: false, packageProcessCount: 0,
            managed, managed, closeEmptySince: null, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "The Loader keeps running while the close grace window starts");
        Equal("close-grace", decision.Reason, "Close grace start reason");
        Equal<DateTimeOffset?>(LifecycleTestStart, decision.CloseEmptySince,
            "Close grace remembers when the last package process disappeared");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(1.9), targetPresent: false, packageProcessCount: 0,
            managed, managed, closeEmptySince: LifecycleTestStart, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "The Loader waits inside the close grace window");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(2), targetPresent: false, packageProcessCount: 0,
            managed, managed, closeEmptySince: LifecycleTestStart, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Exit, decision.Action,
            "The Loader exits after the close grace window elapses");
        Equal("closed", decision.Reason, "Ordinary close reason");

        // Grace is cancelled by a reappearing process and replaced by update
        // recovery when the registered package version increases.
        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(3), targetPresent: false, packageProcessCount: 2,
            managed, managed, closeEmptySince: LifecycleTestStart, updateReported: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "A reappearing package process cancels the pending Loader exit");
        True(decision.CloseEmptySince is null,
            "A reappearing package process resets the close grace window");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(3), targetPresent: false, packageProcessCount: 0,
            managed, upgraded, closeEmptySince: LifecycleTestStart, updateReported: false);
        Equal(ManagedCodexLifecycleAction.ReportUpdate, decision.Action,
            "A package update during the close grace window triggers update recovery instead of exiting");

        // Tracker: an update is reported once and re-armed by a managed restart.
        var tracker = new ManagedCodexLifecycleTracker();
        Equal(ManagedCodexLifecycleAction.ReportUpdate, tracker.Observe(LifecycleTestStart, false, 0, managed, upgraded).Action,
            "Lifecycle tracker reports a Codex package update");
        Equal(ManagedCodexLifecycleAction.Continue, tracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(1), false, 0, managed, upgraded).Action,
            "Lifecycle tracker reports the same Codex package update only once");
        tracker.Reset();
        Equal(ManagedCodexLifecycleAction.ReportUpdate, tracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(2), false, 0, managed, upgraded).Action,
            "A managed restart re-arms Codex package update reporting");

        // Tracker: a managed restart also clears a pending close grace window,
        // so a later ordinary close is still detected and reported.
        var graceTracker = new ManagedCodexLifecycleTracker();
        var firstGrace = graceTracker.Observe(LifecycleTestStart, false, 0, managed, managed);
        Equal(ManagedCodexLifecycleAction.Continue, firstGrace.Action,
            "Lifecycle tracker starts the close grace window");
        Equal<DateTimeOffset?>(LifecycleTestStart, firstGrace.CloseEmptySince,
            "Lifecycle tracker remembers the close grace start");
        Equal(ManagedCodexLifecycleAction.Continue, graceTracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(1), false, 0, managed, managed).Action,
            "Lifecycle tracker keeps waiting inside the close grace window");
        graceTracker.Reset();
        var restarted = graceTracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(1), false, 0, managed, managed);
        Equal(ManagedCodexLifecycleAction.Continue, restarted.Action,
            "A managed restart clears the previous close grace window");
        Equal<DateTimeOffset?>(LifecycleTestStart + TimeSpan.FromSeconds(1), restarted.CloseEmptySince,
            "The close grace window restarts after a managed restart");
        Equal(ManagedCodexLifecycleAction.Exit, graceTracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(3), false, 0, managed, managed).Action,
            "An ordinary close still exits after a managed restart");

        // A Store update unregisters the old package before the new one is
        // registered. That window is not an ordinary close: wait minutes, not
        // seconds, while polling for a version upgrade or a returning process.
        decision = EvaluateLifecycle(LifecycleTestStart, targetPresent: false, packageProcessCount: 0,
            managed, installedVersion: null, closeEmptySince: null, updateReported: false, packageRegistered: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "An unregistered package keeps the Loader waiting");
        Equal("awaiting-package-registration", decision.Reason,
            "An unregistered package uses the update grace window");
        Equal<DateTimeOffset?>(LifecycleTestStart, decision.CloseEmptySince,
            "The long grace window starts when the last package process exits");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(1.9), targetPresent: false, packageProcessCount: 0,
            managed, installedVersion: null, closeEmptySince: LifecycleTestStart, updateReported: false, packageRegistered: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "An unregistered package never exits after the short close grace");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(60), targetPresent: false, packageProcessCount: 0,
            managed, installedVersion: null, closeEmptySince: LifecycleTestStart, updateReported: false, packageRegistered: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "A one minute Store update window still keeps the Loader alive");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(179.9), targetPresent: false, packageProcessCount: 0,
            managed, installedVersion: null, closeEmptySince: LifecycleTestStart, updateReported: false, packageRegistered: false);
        Equal(ManagedCodexLifecycleAction.Continue, decision.Action,
            "The update grace window lasts until its limit");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(180), targetPresent: false, packageProcessCount: 0,
            managed, installedVersion: null, closeEmptySince: LifecycleTestStart, updateReported: false, packageRegistered: false);
        Equal(ManagedCodexLifecycleAction.Exit, decision.Action,
            "The Loader exits once the package stays unregistered past the update grace window");
        Equal("package-unregistered", decision.Reason, "Unregistered package exit reason");

        decision = EvaluateLifecycle(LifecycleTestStart + TimeSpan.FromSeconds(60), targetPresent: false, packageProcessCount: 0,
            managed, installedVersion: upgraded, closeEmptySince: LifecycleTestStart, updateReported: false, packageRegistered: true);
        Equal(ManagedCodexLifecycleAction.ReportUpdate, decision.Action,
            "A newer package appearing after the unregistered window triggers update recovery");

        // The tracker restarts the grace window on a registration transition so
        // a returning same-version package still gets the full short close grace.
        var updateDuringUnregistered = new ManagedCodexLifecycleTracker();
        Equal(ManagedCodexLifecycleAction.Continue,
            updateDuringUnregistered.Observe(LifecycleTestStart, false, 0, managed, installedVersion: null, packageRegistered: false).Action,
            "Lifecycle tracker waits for package registration");
        Equal(ManagedCodexLifecycleAction.ReportUpdate,
            updateDuringUnregistered.Observe(LifecycleTestStart + TimeSpan.FromSeconds(2), false, 0, managed, upgraded, packageRegistered: true).Action,
            "Lifecycle tracker reports an update when the new package registers");

        var unregisteredTracker = new ManagedCodexLifecycleTracker();
        var unregisteredFirst = unregisteredTracker.Observe(LifecycleTestStart, false, 0, managed, installedVersion: null, packageRegistered: false);
        Equal(ManagedCodexLifecycleAction.Continue, unregisteredFirst.Action,
            "Lifecycle tracker awaits package registration");
        Equal<DateTimeOffset?>(LifecycleTestStart, unregisteredFirst.CloseEmptySince,
            "Lifecycle tracker starts the long grace window");
        Equal(ManagedCodexLifecycleAction.Continue,
            unregisteredTracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(60), false, 0, managed, installedVersion: null, packageRegistered: false).Action,
            "Lifecycle tracker keeps waiting for a minute of missing registration");
        var reRegistered = unregisteredTracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(60), false, 0, managed, managed, packageRegistered: true);
        Equal(ManagedCodexLifecycleAction.Continue, reRegistered.Action,
            "A same-version package returning after the update window still gets the short close grace");
        Equal<DateTimeOffset?>(LifecycleTestStart + TimeSpan.FromSeconds(60), reRegistered.CloseEmptySince,
            "Re-registration restarts the short close grace window");
        Equal(ManagedCodexLifecycleAction.Continue,
            unregisteredTracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(61), false, 0, managed, managed).Action,
            "The short close grace after re-registration still lasts its full period");
        Equal(ManagedCodexLifecycleAction.Exit,
            unregisteredTracker.Observe(LifecycleTestStart + TimeSpan.FromSeconds(62), false, 0, managed, managed).Action,
            "The Loader exits after the short close grace that follows re-registration");
    }

    private static ManagedCodexLifecycleDecision EvaluateLifecycle(
        DateTimeOffset now,
        bool targetPresent,
        int packageProcessCount,
        Version? managedVersion,
        Version? installedVersion,
        DateTimeOffset? closeEmptySince,
        bool updateReported,
        bool packageRegistered = true) =>
        ManagedCodexLifecyclePolicy.Evaluate(new ManagedCodexLifecycleSnapshot(
            now,
            targetPresent,
            packageProcessCount,
            managedVersion,
            installedVersion,
            packageRegistered,
            closeEmptySince,
            updateReported));
}
