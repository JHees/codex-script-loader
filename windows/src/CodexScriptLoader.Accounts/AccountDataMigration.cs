namespace CodexScriptLoader.Accounts;

public static class AccountDataMigration
{
    public static void EnsureStore(string destination, string legacy)
    {
        if (Directory.Exists(destination)) { _ = new AccountStore(destination); return; }
        var staging = destination + ".migrating-" + Guid.NewGuid().ToString("N");
        _ = new AccountStore(staging);
        if (File.Exists(Path.Combine(legacy, ".codex-account-switcher-store")))
        {
            foreach (var name in new[] { "preferences.json", "thread-owners.json" })
            {
                var source = Path.Combine(legacy, name);
                if (!File.Exists(source)) continue;
                if (File.GetAttributes(source).HasFlag(FileAttributes.ReparsePoint)) throw new IOException("ACCOUNT_MIGRATION_LINK");
                File.Copy(source, Path.Combine(staging, name));
            }
            var accounts = Path.Combine(legacy, "accounts");
            if (Directory.Exists(accounts)) Copy(accounts, Path.Combine(staging, "accounts"));
        }
        // Publish a complete private store; the legacy data remains a recoverable backup.
        Directory.Move(staging, destination);
    }

    private static void Copy(string source, string target)
    {
        if (File.GetAttributes(source).HasFlag(FileAttributes.ReparsePoint)) throw new IOException("ACCOUNT_MIGRATION_LINK");
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source))
        {
            if (File.GetAttributes(file).HasFlag(FileAttributes.ReparsePoint)) throw new IOException("ACCOUNT_MIGRATION_LINK");
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        }
        foreach (var folder in Directory.EnumerateDirectories(source)) Copy(folder, Path.Combine(target, Path.GetFileName(folder)));
    }
}
