!macro customUnInstallSection
  Section /o "un.작품 데이터(보관함) 삭제" MGT_CLEAN_LIBRARY_DATA_SECTION
    DetailPrint "Deleting manga translator library/work data..."

    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\library"
    RMDir /r "$APPDATA\manga-gemma-translator\library"
    RMDir /r "$LOCALAPPDATA\망가번역기\library"
    RMDir /r "$APPDATA\망가번역기\library"

    ; Legacy data location used by older builds.
    RMDir /r "$INSTDIR\data\library"
  SectionEnd

  Section /o "un.모델/Paddle OCR 캐시 삭제" MGT_CLEAN_MODEL_CACHE_SECTION
    DetailPrint "Deleting Gemma model cache and Paddle OCR runtime..."

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

    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\fonts"
    RMDir /r "$APPDATA\manga-gemma-translator\fonts"
    RMDir /r "$LOCALAPPDATA\망가번역기\fonts"
    RMDir /r "$APPDATA\망가번역기\fonts"

    ; Legacy data location used by older builds.
    RMDir /r "$INSTDIR\data\fonts"
  SectionEnd

  Section /o "un.설정/로그 등 기타 앱 데이터 삭제" MGT_CLEAN_MISC_DATA_SECTION
    DetailPrint "Deleting manga translator settings, logs, and temporary app data..."

    Delete "$LOCALAPPDATA\manga-gemma-translator\settings.json"
    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\logs"
    RMDir /r "$LOCALAPPDATA\manga-gemma-translator\model-tests"
    Delete "$APPDATA\manga-gemma-translator\settings.json"
    RMDir /r "$APPDATA\manga-gemma-translator\logs"
    RMDir /r "$APPDATA\manga-gemma-translator\model-tests"
    Delete "$LOCALAPPDATA\망가번역기\settings.json"
    RMDir /r "$LOCALAPPDATA\망가번역기\logs"
    Delete "$APPDATA\망가번역기\settings.json"
    RMDir /r "$APPDATA\망가번역기\logs"

    ; Legacy data location used by older builds.
    Delete "$INSTDIR\data\settings.json"
    RMDir /r "$INSTDIR\data\logs"
    RMDir /r "$INSTDIR\data\model-tests"

    ; Remove empty app-data shells only after the selected data categories are gone.
    RMDir "$LOCALAPPDATA\manga-gemma-translator"
    RMDir "$APPDATA\manga-gemma-translator"
    RMDir "$LOCALAPPDATA\망가번역기"
    RMDir "$APPDATA\망가번역기"
    RMDir "$INSTDIR\data"
  SectionEnd
!macroend
