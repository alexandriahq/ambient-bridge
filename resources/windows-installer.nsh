; Held outside INSTDIR so replacement/uninstall cannot delete the coordination
; file. Exclusive Windows handle is released even on abort or process crash.
Var bridgeMaintenanceHandle
!macro acquireBridgeMaintenanceLock
  SetShellVarContext current
  CreateDirectory "$LOCALAPPDATA\Programs"
  System::Call 'kernel32::CreateFileW(w "$LOCALAPPDATA\Programs\${PRODUCT_NAME}.maintenance", i 0xC0000000, i 0, p 0, i 4, i 0x80, p 0) p .r0'
  StrCmp $0 -1 0 +3
    MessageBox MB_OK|MB_ICONSTOP "Another Bridge installer is running. Close it and try again." /SD IDOK
    Abort
  StrCpy $bridgeMaintenanceHandle $0
!macroend

!macro customInstall
  Delete "$APPDATA\${PRODUCT_NAME}\bridge.user-quit.json"
  ; Keep the lock until this process exits, including remaining NSIS work.
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
  ; Do not let the running Ambient app reinstall Bridge after explicit removal.
  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  FileOpen $0 "$APPDATA\${PRODUCT_NAME}\bridge.user-quit.json" w
  FileWrite $0 '{}'
  FileClose $0
  ; This hook runs BEFORE NSIS removes application files. Process exit releases
  ; the handle; releasing here would let Ambient restart/repair mid-uninstall.
  ${endIf}
!macroend

; Wrap the stock process check instead of replacing its stop/retry behavior.
; customUnInit runs too late: un.checkAppRunning has already stopped Bridge.
!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ${ifNot} ${isUpdated}
      ${if} $bridgeMaintenanceHandle == ""
        !insertmacro acquireBridgeMaintenanceLock
      ${endIf}
    ${endIf}
  !else
    ${if} $bridgeMaintenanceHandle == ""
      !insertmacro acquireBridgeMaintenanceLock
    ${endIf}
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
!macroend

; Refuse to install/uninstall from the shared Programs parent or from the App
; product directory. Do not prefix-match `Ambient` against this product's own
; `Ambient Bridge` directory — the next character there is a space, not `\`.
!macro abortIfWindowsInstDirIsProgramsParent labelPrefix
  StrCmp "$INSTDIR" "$LOCALAPPDATA\Programs" ${labelPrefix}_abort 0
  StrCmp "$INSTDIR" "$LOCALAPPDATA\Programs\" ${labelPrefix}_abort 0
  Goto ${labelPrefix}_done
  ${labelPrefix}_abort:
    MessageBox MB_OK|MB_ICONSTOP "This Ambient Bridge installer refused to change the shared Programs folder. Ambient and Ambient Bridge must stay in separate directories." /SD IDOK
    Abort
  ${labelPrefix}_done:
!macroend

!macro abortIfWindowsInstDirIsOrUnder siblingDir labelPrefix
  StrCmp "$INSTDIR" "${siblingDir}" ${labelPrefix}_abort 0
  Push $R8
  Push $R9
  StrLen $R8 "${siblingDir}\"
  StrCpy $R9 "$INSTDIR" $R8
  StrCmp $R9 "${siblingDir}\" ${labelPrefix}_abort_pop 0
  Pop $R9
  Pop $R8
  Goto ${labelPrefix}_done
  ${labelPrefix}_abort_pop:
    Pop $R9
    Pop $R8
  ${labelPrefix}_abort:
    MessageBox MB_OK|MB_ICONSTOP "This Ambient Bridge installer refused to change Ambient. The two products must stay in separate directories." /SD IDOK
    Abort
  ${labelPrefix}_done:
!macroend

!macro customInit

  !insertmacro abortIfWindowsInstDirIsProgramsParent bridgeInitParent
  !insertmacro abortIfWindowsInstDirIsOrUnder "$LOCALAPPDATA\Programs\Ambient" bridgeInitApp
  !insertmacro abortIfWindowsInstDirIsOrUnder "$LOCALAPPDATA\Programs\Ambient Local" bridgeInitAppLocal
!macroend

!macro customUnInit

  !insertmacro abortIfWindowsInstDirIsProgramsParent bridgeUninstParent
  !insertmacro abortIfWindowsInstDirIsOrUnder "$LOCALAPPDATA\Programs\Ambient" bridgeUninstApp
  !insertmacro abortIfWindowsInstDirIsOrUnder "$LOCALAPPDATA\Programs\Ambient Local" bridgeUninstAppLocal
!macroend
