# Local Windows build

Run the packaging command from the repository root:

```powershell
.\windows\scripts\package.ps1 -RuntimeIdentifier win-x64
```

The setup executable is written directly into this directory as
`CodexScriptLoader-<version>-windows-<architecture>-setup.exe`. Double-click that
file to install Codex Script Loader. The `app` directory is packaging payload and
is not the normal installation entry point.

Packaging removes the previous generated files in this directory while preserving
this guide. It never cleans or overwrites the repository-level `bin` directory.
