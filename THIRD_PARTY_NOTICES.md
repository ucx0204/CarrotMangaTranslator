# Third-party notices

당근망가번역기는 앱 본체를 GPL-3.0-only로 배포합니다. 앱이 함께 사용하거나 실행 중 내려받는 외부 구성요소는 각 프로젝트와 모델 제공자의 라이선스를 따릅니다.

대표 구성요소는 아래와 같습니다.

- Electron, React, Vite, TypeScript, dnd-kit, Radix UI, Tabler Icons 등 JavaScript 패키지
- ffmpeg
- llama.cpp, beellama, Lemonade ROCm runtime
- PaddleOCR, PaddleOCR-VL, PaddlePaddle, Python runtime
- Flux/Koharu 기반 인페인팅 runner와 관련 모델/런타임
- Gemma 4 GGUF 모델, mmproj, Flux Klein, Flux small decoder, LaMa Manga, AOT Inpainting 등 Hugging Face에서 내려받는 모델 파일

## 번들 폰트

앱에는 한국어 기본 폰트와 함께 영어·일본어·중국어 간체·중국어 번체용 무료 폰트가 포함됩니다. 새로 추가한 24개 다국어 폰트는 원본 TTF를 수정하지 않고 번들하며, 각 폰트의 출처, 정확한 파일 SHA-256, 저작권 고지와 OFL-1.1 또는 Apache-2.0 라이선스 원문은 [`third_party/fonts/`](third_party/fonts/README.md)에 정리되어 있습니다.

폰트 파일만 따로 판매하거나 수정 배포할 때는 각 라이선스, 특히 Reserved Font Name 조건을 확인해야 합니다.

릴리즈 빌드, 런타임 아카이브, 모델 파일을 재배포하거나 수정 배포할 때는 해당 구성요소의 원 라이선스와 모델 카드 조건을 함께 확인해야 합니다. 이 파일은 법률 자문이 아니라, 프로젝트에 포함된 외부 의존성을 확인하기 위한 안내입니다.
