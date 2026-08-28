namespace CodexScriptLoader.Core;

public sealed record LoaderPaths(
    string DataRoot,
    string ConfigPath,
    string ScriptsRoot,
    string QuarantineRoot,
    string LogsRoot,
    string StateRoot,
    string UpdatePreferencesPath,
    string UpdateTransactionPath,
    string PluginUpdatePreferencesPath,
    string PluginUpdateTransactionPath,
    string InstanceLockPath)
{
    public static LoaderPaths ForProduction()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            throw new InvalidOperationException("Local application data directory is unavailable.");
        }

        return FromRoot(Path.Combine(localAppData, "CodexScriptLoader"));
    }

    public static LoaderPaths FromRoot(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        var dataRoot = Path.GetFullPath(root);
        return new LoaderPaths(
            dataRoot,
            Path.Combine(dataRoot, "config.json"),
            Path.Combine(dataRoot, "scripts"),
            Path.Combine(dataRoot, "quarantine"),
            Path.Combine(dataRoot, "logs"),
            Path.Combine(dataRoot, "state"),
            Path.Combine(dataRoot, "update-preferences.json"),
            Path.Combine(dataRoot, "state", "update-transaction.json"),
            Path.Combine(dataRoot, "plugin-update-preferences.json"),
            Path.Combine(dataRoot, "state", "plugin-update-transaction.json"),
            Path.Combine(dataRoot, "state", "instance.v0.3.lock"));
    }

    public void EnsureDirectories()
    {
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(ScriptsRoot);
        Directory.CreateDirectory(QuarantineRoot);
        Directory.CreateDirectory(LogsRoot);
        Directory.CreateDirectory(StateRoot);
    }

    public string EnsureWithin(string root, string candidate, string label)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var fullCandidate = Path.GetFullPath(candidate);
        if (!fullCandidate.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"{label} escapes its allowed directory.");
        }

        return fullCandidate;
    }
}
