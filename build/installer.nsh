!include nsDialogs.nsh
!include LogicLib.nsh

; Keep the historical installation directory even though the payload
; executable now has an ASCII-only filename for nsisunz compatibility.
; This lets v1.6.2 repair a partial v1.6.0/v1.6.1 install in place and reuse
; its existing data-root.txt without creating a second application folder.
!ifdef APP_FILENAME
  !undef APP_FILENAME
!endif
!define APP_FILENAME "carrot-manga-translator"

; electron-builder hides the NSIS details list by default. Keep it expanded so
; users can see which installation stage is currently running.
; Define the UAC-dependent validator from customHeader, after electron-builder
; has registered its NSIS resource plug-ins and included UAC.nsh.
!macro MgtDefineDataRootWriteAccessValidator
Function MgtValidateDataRootWriteAccess
  StrCpy $6 "0"

  ${If} ${UAC_IsAdmin}
  ${AndIfNot} ${UAC_IsInnerInstance}
    StrCpy $6 "unverifiable"
    Return
  ${EndIf}

  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function MgtProbeDataRootWriteAccess ${UAC_SYNCREGISTERS}
  ${Else}
    Call MgtProbeDataRootWriteAccess
  ${EndIf}
FunctionEnd
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ShowInstDetails show
    !insertmacro MgtDefineDataRootWriteAccessValidator
  !endif
!macroend

Var MgtDataRoot
!ifndef BUILD_UNINSTALLER
Var MgtDataRootText
Var MgtExistingDataRootNotice
!define MGT_MAX_FAST_ZIP_INSTALL_DIR_LENGTH 160
!endif

!ifndef BUILD_UNINSTALLER
!macro customFiles_x64
  DetailPrint "프로그램 파일 압축 해제를 완료했습니다."
!macroend

!macro customPageAfterChangeDir
  Page custom MgtDataRootPageCreate MgtDataRootPageLeave
!macroend

!macro customInstall
  DetailPrint "데이터 저장 위치를 적용하는 중..."
  ${If} $MgtDataRoot == ""
    Call MgtResolveInitialDataRoot
  ${EndIf}
  Call MgtWriteDataRootPointer
  DetailPrint "설치 설정을 마무리했습니다."
!macroend

Function MgtValidateInstallDirectory
  StrLen $0 $INSTDIR
  ${If} $0 > ${MGT_MAX_FAST_ZIP_INSTALL_DIR_LENGTH}
    MessageBox MB_ICONSTOP "설치 경로가 너무 깁니다.$\r$\n${MGT_MAX_FAST_ZIP_INSTALL_DIR_LENGTH}자 이하의 더 짧은 폴더를 선택해 주세요.$\r$\n예: D:\CarrotMangaTranslator"
    Abort
  ${EndIf}
FunctionEnd

; Wire the install-directory length check into the MUI directory page so the
; 160-char $INSTDIR budget the NSIS Fast ZIP extraction (nsisunz, MAX_PATH
; buffers) relies on is actually enforced. Without this the function was dead
; code — NSIS warning 6010 (treated as error) — and a user picking an
; over-long install path would hit nsisunz extraction failures. .onVerifyInstDir
; is the standard NSIS directory-page verify callback; Abort rejects the
; directory and keeps the installer open so the user can pick a shorter folder.
Function .onVerifyInstDir
  Call MgtValidateInstallDirectory
FunctionEnd

Function MgtResolveInitialDataRoot
  Call MgtReadInstalledDataRootPointer
  ${If} $MgtDataRoot == ""
    Call MgtResolveLegacyAppDataDefault
  ${EndIf}
  ${If} $MgtDataRoot == ""
    StrCpy $MgtDataRoot "$INSTDIR\data"
  ${EndIf}
FunctionEnd

Function MgtReadInstalledDataRootPointer
  StrCpy $MgtDataRoot ""
  ${If} ${FileExists} "$INSTDIR\data-root.txt"
    ClearErrors
    FileOpen $0 "$INSTDIR\data-root.txt" r
    ${IfNot} ${Errors}
      FileRead $0 $MgtDataRoot
      FileClose $0
      Call MgtTrimDataRootNewlines
    ${EndIf}
  ${EndIf}
FunctionEnd

Function MgtResolveLegacyAppDataDefault
  StrCpy $MgtExistingDataRootNotice ""
  ${If} ${FileExists} "$LOCALAPPDATA\manga-gemma-translator\settings.json"
  ${OrIf} ${FileExists} "$LOCALAPPDATA\manga-gemma-translator\library"
  ${OrIf} ${FileExists} "$LOCALAPPDATA\manga-gemma-translator\hf-cache"
  ${OrIf} ${FileExists} "$LOCALAPPDATA\manga-gemma-translator\ocr-runtime"
    StrCpy $MgtDataRoot "$LOCALAPPDATA\manga-gemma-translator"
    StrCpy $MgtExistingDataRootNotice "기존 데이터가 발견되어 해당 위치를 기본값으로 표시합니다. 새 위치를 쓰려면 찾아보기로 바꾸세요."
    Return
  ${EndIf}

  ${If} ${FileExists} "$APPDATA\manga-gemma-translator\settings.json"
  ${OrIf} ${FileExists} "$APPDATA\manga-gemma-translator\library"
  ${OrIf} ${FileExists} "$APPDATA\manga-gemma-translator\hf-cache"
  ${OrIf} ${FileExists} "$APPDATA\manga-gemma-translator\ocr-runtime"
    StrCpy $MgtDataRoot "$APPDATA\manga-gemma-translator"
    StrCpy $MgtExistingDataRootNotice "기존 데이터가 발견되어 해당 위치를 기본값으로 표시합니다. 새 위치를 쓰려면 찾아보기로 바꾸세요."
    Return
  ${EndIf}

  ${If} ${FileExists} "$LOCALAPPDATA\망가번역기\settings.json"
  ${OrIf} ${FileExists} "$LOCALAPPDATA\망가번역기\library"
  ${OrIf} ${FileExists} "$LOCALAPPDATA\망가번역기\hf-cache"
  ${OrIf} ${FileExists} "$LOCALAPPDATA\망가번역기\ocr-runtime"
    StrCpy $MgtDataRoot "$LOCALAPPDATA\망가번역기"
    StrCpy $MgtExistingDataRootNotice "기존 데이터가 발견되어 해당 위치를 기본값으로 표시합니다. 새 위치를 쓰려면 찾아보기로 바꾸세요."
    Return
  ${EndIf}

  ${If} ${FileExists} "$APPDATA\망가번역기\settings.json"
  ${OrIf} ${FileExists} "$APPDATA\망가번역기\library"
  ${OrIf} ${FileExists} "$APPDATA\망가번역기\hf-cache"
  ${OrIf} ${FileExists} "$APPDATA\망가번역기\ocr-runtime"
    StrCpy $MgtDataRoot "$APPDATA\망가번역기"
    StrCpy $MgtExistingDataRootNotice "기존 데이터가 발견되어 해당 위치를 기본값으로 표시합니다. 새 위치를 쓰려면 찾아보기로 바꾸세요."
  ${EndIf}
FunctionEnd

Function MgtTrimDataRootNewlines
  StrLen $1 $MgtDataRoot
  ${DoWhile} $1 > 0
    IntOp $2 $1 - 1
    StrCpy $3 $MgtDataRoot 1 $2
    ${If} $3 == "$\r"
    ${OrIf} $3 == "$\n"
      StrCpy $MgtDataRoot $MgtDataRoot $2
      StrLen $1 $MgtDataRoot
    ${Else}
      ${ExitDo}
    ${EndIf}
  ${Loop}
FunctionEnd

Function MgtDataRootPageCreate
  Call MgtResolveInitialDataRoot

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0u 0u 100% 26u "모델, Paddle OCR, 보관함, 로그를 저장할 위치를 선택하세요.$\r$\n기본값은 설치 폴더 안의 data 폴더입니다. D드라이브에 설치하면 대용량 파일도 D드라이브에 저장됩니다."
  Pop $0

  ${NSD_CreateText} 0u 38u 78% 13u "$MgtDataRoot"
  Pop $MgtDataRootText

  ${NSD_CreateButton} 82% 37u 18% 15u "찾아보기..."
  Pop $0
  ${NSD_OnClick} $0 MgtDataRootBrowse

  ${If} $MgtExistingDataRootNotice != ""
    ${NSD_CreateLabel} 0u 58u 100% 22u "$MgtExistingDataRootNotice"
  ${Else}
    ${NSD_CreateLabel} 0u 58u 100% 22u "새 설치는 설치 폴더의 data 폴더를 사용합니다. 기존 데이터가 있다면 찾아보기로 그 폴더를 선택하세요."
  ${EndIf}
  Pop $0

  nsDialogs::Show
FunctionEnd

Function MgtDataRootBrowse
  ${NSD_GetText} $MgtDataRootText $MgtDataRoot
  nsDialogs::SelectFolderDialog "데이터 저장 위치 선택" "$MgtDataRoot"
  Pop $0
  ${If} $0 != error
    StrCpy $MgtDataRoot "$0"
    ${NSD_SetText} $MgtDataRootText "$MgtDataRoot"
  ${EndIf}
FunctionEnd

; The all-users installer runs elevated, while the installed app normally runs
; with the interactive user's standard token. Probe from electron-builder's
; retained outer process in that case so an elevated installer cannot mistake
; an admin-only directory for a usable data root. $5 is the candidate path and
; $6 is the result ("1" only after create, write, and delete all succeed).
Function MgtProbeDataRootWriteAccess
  StrCpy $6 "0"

  ClearErrors
  CreateDirectory "$5"
  ${If} ${Errors}
    Return
  ${EndIf}

  StrCpy $9 ""
  ClearErrors
  GetTempFileName $9 "$5"
  ${If} ${Errors}
    Return
  ${EndIf}

  ClearErrors
  FileOpen $0 "$9" w
  ${If} ${Errors}
    Delete "$9"
    Return
  ${EndIf}

  FileWrite $0 "manga-gemma-translator data root write test$\r$\n"
  ${If} ${Errors}
    FileClose $0
    Delete "$9"
    Return
  ${EndIf}
  FileClose $0

  ClearErrors
  Delete "$9"
  ${If} ${Errors}
    Return
  ${EndIf}

  StrCpy $6 "1"
FunctionEnd

Function MgtDataRootPageLeave
  ${NSD_GetText} $MgtDataRootText $MgtDataRoot
  ${If} $MgtDataRoot == ""
    MessageBox MB_ICONSTOP "데이터 저장 위치를 입력해 주세요."
    Abort
  ${EndIf}
  StrLen $1 $MgtDataRoot
  ${If} $1 <= 3
    MessageBox MB_ICONSTOP "드라이브 루트는 데이터 저장 위치로 사용할 수 없습니다.$\r$\n전용 하위 폴더를 선택해 주세요.$\r$\n예: D:\망가번역기-data"
    Abort
  ${EndIf}
  ${If} $MgtDataRoot == "$INSTDIR"
  ${OrIf} $MgtDataRoot == "$INSTDIR\"
    MessageBox MB_ICONSTOP "설치 폴더 자체는 데이터 저장 위치로 사용할 수 없습니다.$\r$\n설치 폴더 안의 data 폴더나 별도 전용 폴더를 선택해 주세요."
    Abort
  ${EndIf}

  StrCpy $5 "$MgtDataRoot"
  Call MgtValidateDataRootWriteAccess

  ${If} $6 == "unverifiable"
    MessageBox MB_ICONSTOP "관리자 권한으로 직접 실행하면 데이터 폴더를 제대로 확인할 수 없습니다.$\r$\n$\r$\n설치 프로그램을 닫고 일반 실행으로 다시 시작해 주세요.$\r$\n모든 사용자용으로 설치하려면 설치 화면에서 해당 항목을 선택해 주세요."
    Abort
  ${EndIf}

  ${If} $6 != "1"
    MessageBox MB_ICONSTOP "선택한 폴더에 데이터를 저장할 수 없습니다.$\r$\n$\r$\n설정과 모델 파일을 저장할 수 있는 다른 폴더를 선택해 주세요.$\r$\n$\r$\n선택한 경로:$\r$\n$MgtDataRoot"
    Abort
  ${EndIf}
FunctionEnd

Function MgtWriteDataRootPointer
  ClearErrors
  CreateDirectory "$MgtDataRoot"
  FileOpen $0 "$MgtDataRoot\.manga-gemma-translator-data" w
  ${IfNot} ${Errors}
    FileWrite $0 "manga-gemma-translator data root$\r$\n"
    FileClose $0
  ${EndIf}

  ClearErrors
  FileOpen $0 "$INSTDIR\data-root.txt" w
  ${IfNot} ${Errors}
    FileWrite $0 "$MgtDataRoot$\r$\n"
    FileClose $0
  ${EndIf}
FunctionEnd

!endif

!ifdef BUILD_UNINSTALLER
  Function un.MgtResolveInstalledDataRoot
    StrCpy $MgtDataRoot "$INSTDIR\data"
    ${If} ${FileExists} "$INSTDIR\data-root.txt"
      ClearErrors
      FileOpen $0 "$INSTDIR\data-root.txt" r
      ${IfNot} ${Errors}
        FileRead $0 $MgtDataRoot
        FileClose $0
        Call un.MgtTrimDataRootNewlines
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function un.MgtTrimDataRootNewlines
    StrLen $1 $MgtDataRoot
    ${DoWhile} $1 > 0
      IntOp $2 $1 - 1
      StrCpy $3 $MgtDataRoot 1 $2
      ${If} $3 == "$\r"
      ${OrIf} $3 == "$\n"
        StrCpy $MgtDataRoot $MgtDataRoot $2
        StrLen $1 $MgtDataRoot
      ${Else}
        ${ExitDo}
      ${EndIf}
    ${Loop}
  FunctionEnd

  Function un.MgtEnsureSafeDataRoot
    StrCpy $4 "0"
    ${If} $MgtDataRoot == ""
      DetailPrint "Data root is empty. Skip cleanup."
      Return
    ${EndIf}
    StrLen $1 $MgtDataRoot
    ${If} $1 <= 3
      DetailPrint "Data root looks like a drive root. Skip cleanup: $MgtDataRoot"
      Return
    ${EndIf}
    ${If} $MgtDataRoot == "$INSTDIR"
      DetailPrint "Data root points at install directory. Skip cleanup: $MgtDataRoot"
      Return
    ${EndIf}
    ${If} $MgtDataRoot == "$INSTDIR\"
      DetailPrint "Data root points at install directory. Skip cleanup: $MgtDataRoot"
      Return
    ${EndIf}
    ${IfNot} ${FileExists} "$MgtDataRoot\.manga-gemma-translator-data"
      DetailPrint "Data root marker missing. Skip cleanup: $MgtDataRoot"
      Return
    ${EndIf}
    StrCpy $4 "1"
  FunctionEnd
!endif

!macro customRemoveFiles
  ; electron-builder's default uninstaller removes $INSTDIR recursively.
  ; The app may intentionally keep user data under $INSTDIR\data, so remove
  ; app files explicitly and leave data/data-root.txt unless optional cleanup
  ; sections below are selected.
  SetOutPath $TEMP
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  RMDir /r "$INSTDIR\vk_swiftshader"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.ico"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\CarrotMangaTranslator.exe"
  Delete "$INSTDIR\당근망가번역기.exe"
  Delete "$INSTDIR\당근 만화 번역기.exe"
  Delete "$INSTDIR\망가번역기.exe"
  Delete "$INSTDIR\Uninstall *.exe"
  RMDir "$INSTDIR"
!macroend

!macro customUnInstallSection
  Section /o "un.작품 데이터(보관함) 삭제" MGT_CLEAN_LIBRARY_DATA_SECTION
    DetailPrint "Deleting manga translator library/work data..."
    Call un.MgtResolveInstalledDataRoot
    Call un.MgtEnsureSafeDataRoot

    ${If} $4 == "1"
      RMDir /r "$MgtDataRoot\library"
    ${EndIf}

    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\library"
    RMDir /r "$APPDATA\manga-gemma-translator\library"
    RMDir /r "$LOCALAPPDATA\망가번역기\library"
    RMDir /r "$APPDATA\망가번역기\library"

    ; Legacy data location used by older builds.
    RMDir /r "$INSTDIR\data\library"
  SectionEnd

  Section /o "un.모델/Paddle OCR 캐시 삭제" MGT_CLEAN_MODEL_CACHE_SECTION
    DetailPrint "Deleting Gemma model cache and Paddle OCR runtime..."
    Call un.MgtResolveInstalledDataRoot
    Call un.MgtEnsureSafeDataRoot

    ${If} $4 == "1"
      RMDir /r "$MgtDataRoot\hf-cache"
      RMDir /r "$MgtDataRoot\ocr-runtime"
      RMDir /r "$MgtDataRoot\llama.cpp"
      RMDir /r "$MgtDataRoot\models"
      RMDir /r "$MgtDataRoot\tools"
      RMDir /r "$MgtDataRoot\tmp\runtime"
    ${EndIf}

    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\hf-cache"
    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\ocr-runtime"
    RMDir /r "$APPDATA\manga-gemma-translator\hf-cache"
    RMDir /r "$APPDATA\manga-gemma-translator\ocr-runtime"
    RMDir /r "$LOCALAPPDATA\망가번역기\hf-cache"
    RMDir /r "$LOCALAPPDATA\망가번역기\ocr-runtime"
    RMDir /r "$APPDATA\망가번역기\hf-cache"
    RMDir /r "$APPDATA\망가번역기\ocr-runtime"

    ; Legacy data location used by older builds.
    RMDir /r "$INSTDIR\data\hf-cache"
    RMDir /r "$INSTDIR\data\ocr-runtime"
  SectionEnd

  Section /o "un.등록한 TTF/OTF 폰트 삭제" MGT_CLEAN_FONTS_SECTION
    DetailPrint "Deleting registered custom fonts..."
    Call un.MgtResolveInstalledDataRoot
    Call un.MgtEnsureSafeDataRoot

    ${If} $4 == "1"
      RMDir /r "$MgtDataRoot\fonts"
    ${EndIf}

    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\fonts"
    RMDir /r "$APPDATA\manga-gemma-translator\fonts"
    RMDir /r "$LOCALAPPDATA\망가번역기\fonts"
    RMDir /r "$APPDATA\망가번역기\fonts"

    ; Legacy data location used by older builds.
    RMDir /r "$INSTDIR\data\fonts"
  SectionEnd

  Section /o "un.설정/로그 등 기타 앱 데이터 삭제" MGT_CLEAN_MISC_DATA_SECTION
    DetailPrint "Deleting manga translator settings, logs, and temporary app data..."
    Call un.MgtResolveInstalledDataRoot
    Call un.MgtEnsureSafeDataRoot

    ${If} $4 == "1"
      Delete "$MgtDataRoot\settings.json"
      Delete "$MgtDataRoot\recent-dialog-paths.json"
      Delete "$MgtDataRoot\.manga-gemma-translator-data"
      RMDir /r "$MgtDataRoot\logs"
      RMDir /r "$MgtDataRoot\model-tests"
      RMDir /r "$MgtDataRoot\tmp"
      RMDir /r "$MgtDataRoot\electron-user-data"
      RMDir /r "$MgtDataRoot\electron-session"
    ${EndIf}

    Delete "$LOCALAPPDATA\manga-gemma-translator\settings.json"
    Delete "$LOCALAPPDATA\manga-gemma-translator\recent-dialog-paths.json"
    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\logs"
    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\model-tests"
    Delete "$APPDATA\manga-gemma-translator\settings.json"
    Delete "$APPDATA\manga-gemma-translator\recent-dialog-paths.json"
    RMDir /r "$APPDATA\manga-gemma-translator\logs"
    RMDir /r "$APPDATA\manga-gemma-translator\model-tests"
    Delete "$LOCALAPPDATA\망가번역기\settings.json"
    Delete "$LOCALAPPDATA\망가번역기\recent-dialog-paths.json"
    RMDir /r "$LOCALAPPDATA\망가번역기\logs"
    Delete "$APPDATA\망가번역기\settings.json"
    Delete "$APPDATA\망가번역기\recent-dialog-paths.json"
    RMDir /r "$APPDATA\망가번역기\logs"

    ; Legacy data location used by older builds.
    Delete "$INSTDIR\data\settings.json"
    Delete "$INSTDIR\data\recent-dialog-paths.json"
    RMDir /r "$INSTDIR\data\logs"
    RMDir /r "$INSTDIR\data\model-tests"

    ; Remove empty app-data shells only after the selected data categories are gone.
    Delete "$INSTDIR\data-root.txt"
    RMDir "$LOCALAPPDATA\manga-gemma-translator"
    RMDir "$APPDATA\manga-gemma-translator"
    RMDir "$LOCALAPPDATA\망가번역기"
    RMDir "$APPDATA\망가번역기"
    RMDir "$INSTDIR\data"
    ${If} $4 == "1"
      RMDir "$MgtDataRoot"
    ${EndIf}
  SectionEnd
!macroend
