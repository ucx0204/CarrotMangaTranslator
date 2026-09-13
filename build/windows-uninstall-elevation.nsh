; Keep electron-builder's uninstaller-generation executable asInvoker. The
; actual uninstaller requests elevation at runtime, so producing an installer
; does not require a developer to elevate the packaging process.
!ifdef BUILD_UNINSTALLER
Var MgtUninstallOriginalSid
Var MgtUninstallCurrentSid

!macro customUnInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/MGT-UNINSTALL-SID=" $MgtUninstallOriginalSid
  ${If} ${Errors}
    StrCpy $MgtUninstallOriginalSid ""
  ${EndIf}

  ; An elevated setup already supplies the right privileges during an update.
  ${If} ${UAC_IsAdmin}
  ${AndIf} $MgtUninstallOriginalSid == ""
    Return
  ${EndIf}

  ; Query the actual token, not a username/environment-variable approximation.
  ; This fixed command contains no caller-provided PowerShell source.
  nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"'
  Pop $R1
  Pop $MgtUninstallCurrentSid
  ${If} $R1 != "0"
    MessageBox MB_ICONSTOP "Windows 실행 계정을 확인하지 못해 제거를 중단했습니다." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}

  ; Remove only the CR/LF emitted by PowerShell.
  MgtTrimUninstallSid:
    StrLen $R1 $MgtUninstallCurrentSid
    ${If} $R1 > 0
      IntOp $R1 $R1 - 1
      StrCpy $R2 $MgtUninstallCurrentSid 1 $R1
      ${If} $R2 == "$\r"
      ${OrIf} $R2 == "$\n"
        StrCpy $MgtUninstallCurrentSid $MgtUninstallCurrentSid $R1
        Goto MgtTrimUninstallSid
      ${EndIf}
    ${EndIf}
  StrCpy $R1 $MgtUninstallCurrentSid 4
  ${If} $R1 != "S-1-"
    MessageBox MB_ICONSTOP "Windows 실행 계정 응답이 올바르지 않아 제거를 중단했습니다." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}

  ${If} $MgtUninstallOriginalSid != ""
    ${If} $MgtUninstallOriginalSid != $MgtUninstallCurrentSid
      MessageBox MB_ICONSTOP "다른 Windows 계정으로 관리자 실행되어 제거를 중단했습니다.$\r$\n기존 사용자별 설치 정보와 데이터를 보호하기 위해 같은 계정으로 승인해 주세요." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${IfNot} ${UAC_IsAdmin}
      MessageBox MB_ICONSTOP "제거 프로그램이 관리자 권한을 얻지 못했습니다. 자동으로 다시 요청하지 않습니다." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    Return
  ${EndIf}

  ; Preserve all original options, but remove an existing _?= suffix before
  ; appending the one final unquoted installation-directory argument NSIS needs.
  ${GetParameters} $R0
  StrCpy $R1 0
  MgtFindUninstallDirectoryArgument:
    StrCpy $R2 $R0 3 $R1
    ${If} $R2 == "_?="
      StrCpy $R0 $R0 $R1
      Goto MgtUninstallOptionsReady
    ${EndIf}
    ${If} $R2 == ""
      Goto MgtUninstallOptionsReady
    ${EndIf}
    IntOp $R1 $R1 + 1
    Goto MgtFindUninstallDirectoryArgument
  MgtUninstallOptionsReady:

  ${If} $installMode == "all"
    StrCpy $R1 "/allusers"
  ${Else}
    StrCpy $R1 "/currentuser"
  ${EndIf}
  ClearErrors
  ; un.onInit runs in NSIS's temporary copy; _?= keeps the elevated copy alive
  ; until actual removal finishes, and leaves the installed EXE removable.
  ExecShellWait "runas" "$EXEPATH" "/MGT-UNINSTALL-SID=$MgtUninstallCurrentSid $R0 $R1 _?=$INSTDIR" SW_SHOWNORMAL $R2
  ${If} ${Errors}
    ; Cancellation or launch failure must never fall through to file removal.
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetErrorLevel $R2
  Quit
!macroend
!endif
