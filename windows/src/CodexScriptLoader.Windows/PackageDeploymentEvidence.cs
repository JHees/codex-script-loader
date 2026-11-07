using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Security.Principal;
using CodexScriptLoader.Interop;

namespace CodexScriptLoader.Windows;

internal static class PackageDeploymentEvidence
{
    internal static bool IsPending(CodexPackageIdentity managed, DateTimeOffset now)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value;
        if (sid is null) return false;
        var start = now.UtcDateTime.Subtract(ManagedCodexLifecyclePolicy.PackageUnregisteredGracePeriod).ToString("O", CultureInfo.InvariantCulture);
        var end = now.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
        var query = new EventLogQuery("Microsoft-Windows-AppXDeploymentServer/Operational", PathType.LogName,
            $"*[System[(EventID=607 or EventID=400 or EventID=401 or EventID=404) and TimeCreated[@SystemTime >= '{start}' and @SystemTime <= '{end}']]]")
        { ReverseDirection = true };
        using var reader = new EventLogReader(query);
        using var fields = new EventLogPropertySelector(new[] { "Event/EventData/Data[@Name='DeploymentOperation']", "Event/EventData/Data[@Name='PackageFullName']", "Event/EventData/Data[@Name='UserSid']" });
        var finished = new HashSet<Guid>();
        while (true)
        {
            using var entry = reader.ReadEvent();
            if (entry is not EventLogRecord record) return false;
            if (record.ActivityId is not { } activity || activity == Guid.Empty) continue;
            if (record.Id != 607) { finished.Add(activity); continue; }
            if (finished.Contains(activity)) continue;
            var values = record.GetPropertyValues(fields);
            if (values.Count == 3 && IsNewRegistration(values[0]?.ToString(), values[1] as string, values[2]?.ToString(), sid, managed))
                return true;
        }
    }

    internal static bool IsNewRegistration(string? operation, string? fullName, string? user, string sid, CodexPackageIdentity managed)
    {
        var parts = fullName?.Split('_');
        return operation == "6" && user == sid && parts is { Length: 5 } && parts[3].Length == 0 &&
            string.Equals(parts[0] + "_" + parts[4], managed.PackageFamilyName, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(parts[2], managed.Architecture, StringComparison.OrdinalIgnoreCase) &&
            Version.TryParse(parts[1], out var version) && version > managed.Version;
    }
}
