; Uninstalling takes "Sunroom Camera" away too, so no app keeps listing a camera that nothing feeds.
; An update runs this uninstaller as well; the camera stays registered then.
; The uninstaller is a 32-bit program. Sysnative reaches the 64-bit PowerShell, which sees the registry keys the app wrote.
; The filter files go only when the registration is gone: a registration that points at missing files is worse than both staying.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\tools\register-virtual-camera.ps1" -Uninstall -Yes'
    Pop $R9
    ${if} $R9 == 0
      RMDir /r "$LOCALAPPDATA\sunroom\vcam"
      RMDir "$LOCALAPPDATA\sunroom"
    ${endIf}
  ${endIf}
!macroend
