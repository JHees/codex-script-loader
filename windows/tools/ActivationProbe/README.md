# Activation Probe

This development-only probe verifies that the current Microsoft Store Codex package can be launched through Windows package activation with a loopback CDP endpoint. It is not included in the production Loader package.

## Run the gate

1. Build the probe from the repository root:

   ```powershell
   .\.tools\dotnet\dotnet.exe build .\windows\CodexScriptLoader.Windows.sln -c Release --configfile .\NuGet.Config
   ```

2. Completely exit Codex and wait for all package processes to stop.
3. From Windows Terminal, run:

   ```powershell
   .\windows\tools\ActivationProbe\bin\Release\net10.0-windows\CodexScriptLoader.ActivationProbe.exe
   ```

The gate passes only when the final line is `result=ACTIVATION_PASS`. A running Codex instance is an invalid test condition because Electron may reuse the existing browser process and ignore startup-only remote-debugging arguments.

Use `--discover-only` to inspect package identity without activating Codex.
