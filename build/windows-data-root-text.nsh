!ifndef MGT_DATA_ROOT_TEXT_INCLUDED
!define MGT_DATA_ROOT_TEXT_INCLUDED

; FileRead/FileWrite use the Windows ANSI code page, even in Unicode NSIS.
; The application reads data-root.txt as UTF-8. Keep new pointers UTF-8 and
; accept legacy ANSI pointers only when strict UTF-8 decoding is impossible.
; Call with an open $0 handle and a named output variable (not $1 through $6).
; Both macros preserve scratch registers and report failure via ${Errors}.

!macro MgtReadDataRootText HANDLE OUTPUT
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy ${OUTPUT} ""
  StrCpy $2 0
  StrCpy $6 0
  ${Do}
    System::Call 'kernel32::GetFileSize(p ${HANDLE}, p 0) i.r1'
    ${If} $1 <= 0
    ${OrIf} $1 > ${NSIS_MAX_STRLEN} * 4
      ${ExitDo}
    ${EndIf}
    System::Alloc $1
    Pop $2
    ${If} $2 == 0
      ${ExitDo}
    ${EndIf}
    System::Call 'kernel32::ReadFile(p ${HANDLE}, p r2, i r1, *i .r3, p 0) i.r4'
    ${If} $4 == 0
    ${OrIf} $3 != $1
      ${ExitDo}
    ${EndIf}
    System::Call 'kernel32::MultiByteToWideChar(i 65001, i 8, p r2, i r1, w .r5, i ${NSIS_MAX_STRLEN}) i.r4'
    ${If} $4 == 0
      System::Call 'kernel32::GetLastError() i.r3'
      ${If} $3 != 1113
        ${ExitDo}
      ${EndIf}
      ; ERROR_NO_UNICODE_TRANSLATION: pre-UTF-8 installers wrote CP_ACP.
      System::Call 'kernel32::MultiByteToWideChar(i 0, i 0, p r2, i r1, w .r5, i ${NSIS_MAX_STRLEN}) i.r4'
    ${EndIf}
    ${If} $4 <= 0
    ${OrIf} $4 >= ${NSIS_MAX_STRLEN}
      ${ExitDo}
    ${EndIf}
    StrCpy ${OUTPUT} $5
    ; A UTF-8 BOM is permitted for a pointer saved by a text editor.
    StrCpy $3 $5 1
    ${If} $3 == "﻿"
      StrCpy ${OUTPUT} $5 "" 1
    ${EndIf}
    StrCpy $6 1
    ${ExitDo}
  ${Loop}
  ${If} $2 != 0
    System::Free $2
  ${EndIf}
  ${If} $6 == 1
    ClearErrors
  ${Else}
    SetErrors
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
!macroend

!macro MgtWriteDataRootText HANDLE TEXT
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $2 0
  StrCpy $6 0
  ${Do}
    System::Call 'kernel32::WideCharToMultiByte(i 65001, i 128, w "${TEXT}", i -1, p 0, i 0, p 0, p 0) i.r1'
    ${If} $1 <= 1
      ${ExitDo}
    ${EndIf}
    System::Alloc $1
    Pop $2
    ${If} $2 == 0
      ${ExitDo}
    ${EndIf}
    System::Call 'kernel32::WideCharToMultiByte(i 65001, i 128, w "${TEXT}", i -1, p r2, i r1, p 0, p 0) i.r4'
    ${If} $4 != $1
      ${ExitDo}
    ${EndIf}
    ; Exclude the terminating NUL; the application expects an ordinary text file.
    IntOp $1 $1 - 1
    System::Call 'kernel32::WriteFile(p ${HANDLE}, p r2, i r1, *i .r3, p 0) i.r4'
    ${If} $4 == 0
    ${OrIf} $3 != $1
      ${ExitDo}
    ${EndIf}
    System::Call 'kernel32::FlushFileBuffers(p ${HANDLE}) i.r4'
    ${If} $4 == 0
      ${ExitDo}
    ${EndIf}
    StrCpy $6 1
    ${ExitDo}
  ${Loop}
  ${If} $2 != 0
    System::Free $2
  ${EndIf}
  ${If} $6 == 1
    ClearErrors
  ${Else}
    SetErrors
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
!macroend

!endif
