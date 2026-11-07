# Isolated MSIX update acceptance

This opt-in test uses a separate `CodexScriptLoader.Test.Msix` package, a hidden Electron renderer, a separate Loader data root, and the production `LiveSupervisor` reconnect implementation. The production constructor still discovers only Codex; the test supplies its own package discovery function. Never point this test at the real Codex package.

## Preparation

1. Put a checksum-verified official Electron Windows x64 distribution in `<test-root>/payload`. The acceptance run used Electron 45.2.3 and its official `SHASUMS256.txt`.
2. Run `prepare.ps1 -Root <test-root>`. It builds and signs versions `1.0.0.0` and `2.0.0.0`, creates a short-lived signing certificate in the current user's Personal store, and records its exact thumbprint in `identity.json`. It does not install a package or grant machine trust.
3. Obtain explicit permission before temporarily trusting `test.cer` in **Local Computer / Trusted People**. Do not change developer-mode policies or trust an unrelated certificate.
4. Install `fixture-1.msix` for the current user and obtain its package family with `Get-AppxPackage -Name CodexScriptLoader.Test.Msix`.
5. Copy `deploy.ps1` into `<test-root>` and build `CodexScriptLoader.Tests` in Release mode.

Run the test executable with:

```text
--msix-acceptance <test-package-family> <test-root>
```

The test waits for Windows' minimum application lifetime, deploys version 2 without sending a renderer restart signal, and waits for the production recovery path. It asserts the replacement process inherited the port on its first launch, the installed package is version 2, a real renderer evaluates JavaScript, and the Loader-owned example plugin is running. It writes `acceptance-result.json` plus Loader logs and one launch receipt per process.

## Cleanup and interpretation

The driver requests normal closure of the fixture. Always uninstall only the exact test package afterward and remove the exact certificate thumbprint from Personal (including its private key), Current User / Trusted People if present, and Local Computer / Trusted People. Machine certificate removal requires an administrator confirmation. Verify there are no test package processes or certificate entries left.

A pass covers real signed MSIX deployment, system first launch with arguments, and the actual Loader reconnect/injection path. It does not replace a future acceptance run against an actual Codex release, nor exercise Microsoft Store download services or Codex-specific package capabilities.
