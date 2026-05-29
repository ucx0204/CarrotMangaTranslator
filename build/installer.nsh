!macro customUnInstallSection
  Section /o "un.앱 데이터/모델/OCR 캐시까지 삭제" MGT_CLEAN_USER_DATA_SECTION
    DetailPrint "Deleting manga translator app data, models, and OCR cache..."

    RMDir /r "$INSTDIR\data"

    RMDir /r "$LOCALAPPDATA\manga-gemma-translator"
    RMDir /r "$APPDATA\manga-gemma-translator"

    RMDir /r "$LOCALAPPDATA\망가번역기"
    RMDir /r "$APPDATA\망가번역기"
  SectionEnd
!macroend
