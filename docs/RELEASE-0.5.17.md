# 0.5.17 — Codex 26.1021 startup compatibility

This is a maintenance release for Codex Desktop 26.1021. It intentionally contains no 0.6.0 account-switching features.

## Fixes

- Extend the managed Codex startup wait from 20 seconds to 120 seconds. Codex 26.1021 can perform a slower first start after a Microsoft Store update.
- Report the Loader host as ready to the launcher before CDP injection finishes, so the launcher does not show a false startup failure while Codex is still starting.

## Scope

- No account routing, shared history, model aggregation, sidebar changes, or account UI are included.
- Existing 0.5.x settings, plugin, update, and launcher protocols remain unchanged.

## Verification

- Windows Release build and `CodexScriptLoader.Tests` pass.
- Package verification covers the x64 installer, portable ZIP, SBOM, and checksums.
