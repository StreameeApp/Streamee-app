!define STREAMEE_HELPER_SHUTDOWN "${__FILEDIR__}\stop-installed-helpers.ps1"

!macro NSIS_HOOK_PREINSTALL
  ; Stop the old main app first so it cannot restart helpers during installation.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-installed-helpers.ps1 "${STREAMEE_HELPER_SHUTDOWN}"
  nsExec::ExecToStack /TIMEOUT=15000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-installed-helpers.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    Abort "Could not close Streamee playback helpers. Restart Windows and run this installer again."
  ${EndIf}
!macroend
