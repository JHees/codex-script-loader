Unicode true
ManifestDPIAware true

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !error "VERSION is required."
!endif
!ifndef FILE_VERSION
  !error "FILE_VERSION is required."
!endif
!ifndef ARCHITECTURE
  !error "ARCHITECTURE is required."
!endif
!ifndef APP_DIR
  !error "APP_DIR is required."
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required."
!endif
!ifndef ICON_FILE
  !error "ICON_FILE is required."
!endif
!ifndef ESTIMATED_SIZE_KB
  !define ESTIMATED_SIZE_KB 0
!endif

Name "Codex Script Loader"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\CodexScriptLoader"
InstallDirRegKey HKCU "Software\CodexScriptLoader" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
CRCCheck force
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${FILE_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "Codex Script Loader"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "Codex Script Loader Setup (${ARCHITECTURE})"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "CompanyName" "JHees"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) Codex Script Loader contributors"

!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApplication
!define MUI_FINISHPAGE_RUN_TEXT "Start Codex Script Loader"
!define MUI_STARTMENUPAGE_DEFAULTFOLDER "Codex Script Loader"
!define MUI_STARTMENUPAGE_REGISTRY_ROOT HKCU
!define MUI_STARTMENUPAGE_REGISTRY_KEY "Software\CodexScriptLoader"
!define MUI_STARTMENUPAGE_REGISTRY_VALUENAME "StartMenuFolder"

Var StartMenuFolder

!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateInstallDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_STARTMENU Application $StartMenuFolder
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Function LaunchApplication
  IfSilent done
  Exec '"$INSTDIR\CodexScriptLoader.exe"'
done:
FunctionEnd

Function ValidateInstallDirectory
  StrCmp $INSTDIR "" invalid
  IfFileExists "$INSTDIR\.codex-script-loader-install" valid

  ; v0.4.2 and earlier always installed to this fixed per-user directory and did
  ; not write the safety marker. Accept that exact legacy layout once so the new
  ; installer can add the marker without treating arbitrary non-empty folders as
  ; Loader installations.
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\CodexScriptLoader" 0 check_empty
  IfFileExists "$INSTDIR\CodexScriptLoader.exe" 0 check_empty
  IfFileExists "$INSTDIR\CodexScriptLoader.dll" 0 check_empty
  IfFileExists "$INSTDIR\uninstall.exe" valid

check_empty:
  ClearErrors
  FindFirst $0 $1 "$INSTDIR\*"
  IfErrors valid
directory_entry:
  StrCmp $1 "" valid_close
  StrCmp $1 "." directory_next
  StrCmp $1 ".." directory_next
  FindClose $0
  MessageBox MB_OK|MB_ICONEXCLAMATION "The selected folder is not empty. Choose an empty folder or the existing Codex Script Loader installation folder."
  Abort
directory_next:
  FindNext $0 $1
  Goto directory_entry
valid_close:
  FindClose $0
valid:
  Return
invalid:
  MessageBox MB_OK|MB_ICONEXCLAMATION "Choose an installation folder."
  Abort
FunctionEnd

Section "Codex Script Loader" SEC_INSTALL
  SectionIn RO
  SetShellVarContext current
  SetRegView 64
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; 0.4.x used a flat self-contained host. Migrate only that recognized Loader
  ; layout; user data remains under $LOCALAPPDATA\CodexScriptLoader.
  IfFileExists "$INSTDIR\CodexScriptLoader.dll" 0 versioned_layout
  ClearErrors
  Delete "$INSTDIR\CodexScriptLoader.exe"
  IfErrors legacy_in_use
  Delete "$INSTDIR\CodexScriptLoader.dll"
  Delete "$INSTDIR\CodexScriptLoader.Core.dll"
  Delete "$INSTDIR\CodexScriptLoader.Interop.dll"
  Delete "$INSTDIR\CodexScriptLoader.deps.json"
  Delete "$INSTDIR\CodexScriptLoader.runtimeconfig.json"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\createdump.exe"
  RMDir /r "$INSTDIR\bundled"
  RMDir /r "$INSTDIR\cs"
  RMDir /r "$INSTDIR\de"
  RMDir /r "$INSTDIR\es"
  RMDir /r "$INSTDIR\fr"
  RMDir /r "$INSTDIR\it"
  RMDir /r "$INSTDIR\ja"
  RMDir /r "$INSTDIR\ko"
  RMDir /r "$INSTDIR\pl"
  RMDir /r "$INSTDIR\pt-BR"
  RMDir /r "$INSTDIR\ru"
  RMDir /r "$INSTDIR\tr"
  RMDir /r "$INSTDIR\zh-Hans"
  RMDir /r "$INSTDIR\zh-Hant"
  Goto versioned_layout
legacy_in_use:
  MessageBox MB_OK|MB_ICONEXCLAMATION "Codex Script Loader is still running. Exit Loader and Codex completely, then run the installer again."
  Abort
versioned_layout:
  Delete "$INSTDIR\previous.install-backup.json"
  IfFileExists "$INSTDIR\active.json" 0 copy_payload
  CopyFiles /SILENT "$INSTDIR\active.json" "$INSTDIR\previous.install-backup.json"
copy_payload:
  File /r "${APP_DIR}\*"
  IfFileExists "$INSTDIR\previous.install-backup.json" 0 pointers_ready
  Delete "$INSTDIR\previous.json"
  Rename "$INSTDIR\previous.install-backup.json" "$INSTDIR\previous.json"
pointers_ready:

  FileOpen $0 "$INSTDIR\.codex-script-loader-install" w
  FileWrite $0 "CodexScriptLoader${VERSION}"
  FileClose $0

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\CodexScriptLoader" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "DisplayName" "Codex Script Loader"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "Publisher" "JHees"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "DisplayIcon" "$INSTDIR\CodexScriptLoader.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "URLInfoAbout" "https://github.com/JHees/codex-script-loader"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader" "EstimatedSize" ${ESTIMATED_SIZE_KB}

  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    CreateDirectory "$SMPROGRAMS\$StartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$StartMenuFolder\Codex Script Loader.lnk" "$INSTDIR\CodexScriptLoader.exe" "" "$INSTDIR\CodexScriptLoader.exe"
    CreateShortcut "$SMPROGRAMS\$StartMenuFolder\Uninstall Codex Script Loader.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\CodexScriptLoader.exe"
  !insertmacro MUI_STARTMENU_WRITE_END
  CreateShortcut "$DESKTOP\Codex Script Loader.lnk" "$INSTDIR\CodexScriptLoader.exe" "" "$INSTDIR\CodexScriptLoader.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\.codex-script-loader-install" safe_to_remove
  MessageBox MB_OK|MB_ICONSTOP "Codex Script Loader installation marker is missing. The application directory will not be removed."
  Abort
safe_to_remove:
  !insertmacro MUI_STARTMENU_GETFOLDER Application $StartMenuFolder
  Delete "$DESKTOP\Codex Script Loader.lnk"
  Delete "$SMPROGRAMS\$StartMenuFolder\Codex Script Loader.lnk"
  Delete "$SMPROGRAMS\$StartMenuFolder\Uninstall Codex Script Loader.lnk"
  RMDir "$SMPROGRAMS\$StartMenuFolder"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader"
  DeleteRegKey HKCU "Software\CodexScriptLoader"
  RMDir /r "$INSTDIR"
SectionEnd
