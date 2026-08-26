using System.Text;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed class DiagnosticsForm : Form
{
    private readonly TextBox content;
    private readonly Button exportButton;

    public DiagnosticsForm()
    {
        Text = "Codex Script Loader Diagnostics";
        Width = 760;
        Height = 560;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = true;
        var commands = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 44,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(8),
        };
        exportButton = new Button
        {
            Text = "Export redacted diagnostics…",
            AutoSize = true,
        };
        exportButton.Click += (_, _) => ExportDiagnostics();
        commands.Controls.Add(exportButton);
        content = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            Font = new Font(FontFamily.GenericMonospace, 9),
            BackColor = SystemColors.Window,
        };
        Controls.Add(content);
        Controls.Add(commands);
    }

    public void UpdateSnapshot(DiagnosticSnapshot snapshot, string logPath)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"Loader version: {snapshot.LoaderVersion}");
        builder.AppendLine($"State: {snapshot.State}");
        builder.AppendLine($"Signature: {snapshot.SignatureStatus}");
        builder.AppendLine($"Started: {snapshot.StartedAt:O}");
        builder.AppendLine($"Last injection: {snapshot.LastInjectionAt:O}");
        builder.AppendLine($"Package full name: {snapshot.PackageFullName ?? "<not discovered>"}");
        builder.AppendLine($"Package family: {snapshot.PackageFamilyName ?? "<not discovered>"}");
        builder.AppendLine($"AUMID: {snapshot.AppUserModelId ?? "<not discovered>"}");
        builder.AppendLine($"Activation PID: {snapshot.ActivationProcessId?.ToString() ?? "<none>"}");
        builder.AppendLine($"CDP: {(snapshot.Cdp is null ? "<not verified>" : $"{snapshot.Cdp.Address}:{snapshot.Cdp.Port}; owner={snapshot.Cdp.OwnerPid}; target={snapshot.Cdp.TargetUrl}")}");
        builder.AppendLine($"Log: {RedactPath(logPath)}");
        builder.AppendLine($"Last error: {snapshot.LastError ?? "<none>"}");
        builder.AppendLine();
        builder.AppendLine("Scripts:");
        foreach (var script in snapshot.Scripts)
        {
            builder.AppendLine($"- {script.Id} {script.Version}; sha256-{script.Hash}; permission={script.PermissionResult}; lifecycle={script.LifecycleResult}; error={script.ErrorCode ?? "none"}");
        }

        content.Text = builder.ToString();
    }

    private void ExportDiagnostics()
    {
        using var dialog = new SaveFileDialog
        {
            Title = "Export redacted diagnostics",
            Filter = "Text files (*.txt)|*.txt|All files (*.*)|*.*",
            FileName = $"codex-script-loader-diagnostics-{DateTime.UtcNow:yyyyMMdd-HHmmss}.txt",
            AddExtension = true,
            DefaultExt = "txt",
        };
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        File.WriteAllText(dialog.FileName, content.Text, new UTF8Encoding(false));
        MessageBox.Show(this, "The redacted diagnostic snapshot was exported.", "Diagnostics exported", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private static string RedactPath(string path)
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return string.IsNullOrWhiteSpace(profile) ? path : path.Replace(profile, "[user-profile]", StringComparison.OrdinalIgnoreCase);
    }
}
