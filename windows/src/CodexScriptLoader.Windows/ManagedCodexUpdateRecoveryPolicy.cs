namespace CodexScriptLoader.Windows;

/// <summary>
/// Bounds how long update recovery waits for Codex's own relaunch to expose the
/// inherited CDP endpoint. Newer Codex versions relaunch the updated package
/// with their own updater arguments, which drops the managed debugging
/// switches, so waiting for the inherited port alone can leave the Loader
/// permanently degraded. After the bounded wait the Loader asks the updated
/// app to close normally and relaunches it under management.
/// </summary>
internal static class ManagedCodexUpdateRecoveryPolicy
{
    /// <summary>Time the updated app gets to restore the inherited endpoint.</summary>
    internal static readonly TimeSpan InheritedEndpointWait = TimeSpan.FromSeconds(20);

    /// <summary>Maximum time spent waiting for a normal window close.</summary>
    internal static readonly TimeSpan UnmanagedCloseTimeout = TimeSpan.FromSeconds(20);

    internal const string RestartingMessage =
        "Codex restarted without restoring the managed connection. Waiting for the desktop app to exit before relaunch.";

    internal const string CloseCodexMessage =
        "Codex is still running without the managed connection. Choose Quit or Exit in the app or its system tray menu. Loader will then relaunch it.";

    internal static bool ShouldTakeOver(TimeSpan elapsed, int blockingProcessCount, bool takeoverAttempted) =>
        !takeoverAttempted && blockingProcessCount > 0 && elapsed >= InheritedEndpointWait;

    internal static bool ShouldRelaunch(TimeSpan elapsed, int blockingProcessCount, bool takeoverAttempted, bool packageUpgraded) =>
        blockingProcessCount == 0 && (takeoverAttempted || (packageUpgraded && elapsed >= InheritedEndpointWait));
}
