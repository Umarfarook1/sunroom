; Uninstalling takes "Sunroom Camera" away too, so no app keeps listing a camera that nothing feeds.
; An update runs this uninstaller as well; the camera stays registered then.
; The uninstaller is a 32-bit program. Sysnative reaches the 64-bit PowerShell, which sees the registry keys the app wrote.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\tools\register-virtual-camera.ps1" -Uninstall -Yes'
    RMDir /r "$LOCALAPPDATA\sunroom\vcam"
    RMDir "$LOCALAPPDATA\sunroom"
  ${endIf}
!macroend
