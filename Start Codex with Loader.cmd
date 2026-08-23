@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer was not found in PATH.
  echo Install Node.js, then double-click this file again.
  pause
  exit /b 1
)

echo Starting the official Codex Store app with the renderer plugin loader...
echo Keep this window open while Codex is running.
node.exe src\cli.mjs run --live --data-dir .runtime\manual
set "loader_exit=%errorlevel%"
if not "%loader_exit%"=="0" (
  echo.
  echo Loader stopped with exit code %loader_exit%.
  pause
)
exit /b %loader_exit%
