; Uninstalling takes "Sunroom Camera" away too, so no app keeps listing a camera that nothing feeds.
; An update runs this uninstaller as well; the camera stays registered then.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\tools\register-virtual-camera.ps1" -Uninstall -Yes'
    RMDir /r "$LOCALAPPDATA\sunroom\vcam"
    RMDir "$LOCALAPPDATA\sunroom"
  ${endIf}
!macroend
