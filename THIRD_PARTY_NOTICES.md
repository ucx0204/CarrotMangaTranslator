# Third-party notices

당근망가번역기는 앱 본체를 GPL-3.0-only로 배포합니다. 앱이 함께 사용하거나 실행 중 내려받는 외부 구성요소는 각 프로젝트와 모델 제공자의 라이선스를 따릅니다.

대표 구성요소는 아래와 같습니다.

- Electron, React, Vite, TypeScript, dnd-kit, Radix UI, Tabler Icons 등 JavaScript 패키지
- Kenney `Interface Sounds`의 `confirmation_002.ogg` 완료 알림음. 원본은 [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds)에서 Creative Commons Zero(CC0)로 배포되며, 번들 파일 `src/renderer/src/assets/audio/completion.ogg`의 SHA-256은 `33b17a9a9a2397c62b285c52c33a907fdffb476909c99e42dde603f6a7a8b12c`입니다.
- Koharu Layout HighRes © 2026 Mayo Takanashi, RF-DETR Seg 2XL © 2025 Roboflow. 앱은 Apache-2.0 모델의 ONNX 변환본을 내려받아 SHA-256을 검증합니다. [원본 모델](https://huggingface.co/mayocream/koharu-layout-highres) · [ONNX 변환 및 고지](https://huggingface.co/erdeneetemp/koharu-layout-highres-onnx/blob/a5818861f184f496c2e45063c9542ffb7abccd37/NOTICE) · [MIT ONNX Runtime](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)
- Apache-2.0 `@openai/codex` 공식 패키지와 플랫폼별 네이티브 Codex 런타임. 설치판은 고정 버전의 공식 Codex App Server 바이너리를 `resources/c`에 포함하고 패키지 매니페스트와 버전을 검증합니다.
- Anthropic `@anthropic-ai/claude-agent-sdk`와 공식 Claude Code 네이티브 런타임. 수정하지 않은 공식 실행 파일과 원본 라이선스를 `resources/claude`에 포함합니다. Claude Code 사용에는 Anthropic의 [Legal Agreements](https://code.claude.com/docs/en/legal-and-compliance)가 적용됩니다.
- ffmpeg
- llama.cpp, beellama, Lemonade ROCm runtime
- PaddleOCR, PaddlePaddle, Python runtime
- Flux/Koharu 기반 인페인팅 runner와 관련 모델/런타임
- Qwen Image 2.1 인페인팅에는 leejet의 GGUF와 Comfy-Org의 VAE와 가속 경로용 Qwen Image 2.1 Turbo INT8을 사용합니다. ControlNet 경로에서는 같은 배포처의 Fun ControlNet Union도 내려받습니다. 이 가중치들의 배포처는 비상업적 연구·평가 용도의 Qwen Research License를 명시하며, 상업적으로 사용하려면 별도 라이선스가 필요합니다. [원본 라이선스](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) · [GGUF 모델 카드](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF) · [Turbo·VAE·ControlNet 배포처](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)
- 네이티브 Qwen 실행기는 Koffi(MIT)를 사용해 stable-diffusion.cpp 라이브러리를 호출합니다. [Koffi](https://koffi.dev/)
- ControlNet 인페인팅은 전용 로컬 런타임에서 ComfyUI(GPL-3.0), ComfyUI-GGUF(Apache-2.0), GGUF 판독기를 사용합니다. 밑그림 복원에는 Apache-2.0으로 배포된 LaMa Manga ONNX를 사용합니다. [ComfyUI](https://github.com/Comfy-Org/ComfyUI/blob/v0.46.0/LICENSE) · [ComfyUI-GGUF](https://github.com/leejet/ComfyUI-GGUF/blob/ff8d48666758866bcc9e93b22e1e07cb636e084f/LICENSE) · [GGUF](https://pypi.org/project/gguf/0.19.0/) · [LaMa Manga ONNX](https://huggingface.co/mayocream/lama-manga-onnx)
- Qwen Image 2.1의 이미지·텍스트 인코딩에 사용하는 Qwen3-VL-8B-Instruct GGUF와 시각 프로젝터에는 Apache-2.0이 적용됩니다. [Qwen3-VL 모델 카드](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF)
- Gemma 4 GGUF 모델, mmproj, Flux Klein, Flux small decoder, LaMa Manga, AOT Inpainting 등 Hugging Face에서 내려받는 모델 파일
- `mayocream/anime-text-yolo`의 GPL-3.0 `yolo12n_animetext.safetensors`. 앱은 고정 revision과 SHA-256을 검증해 내려받으며, OCR 그룹을 직접 결정하지 않는 보조 텍스트 영역 신호로만 사용합니다.

## 번들 폰트

앱에는 한국어 기본 폰트와 함께 영어·일본어·중국어 간체·중국어 번체용 무료 폰트가 포함됩니다. 별도 출처 기록이 있는 24개 다국어 폰트와 6개 한국어 폰트는 공식 원본을 수정하지 않고 번들합니다. 한국어 추가분 중 리디바탕만 공식 배포 형식인 OTF이고 나머지는 TTF입니다. 각 폰트의 출처, 정확한 파일 SHA-256, 저작권 고지와 OFL-1.1 또는 Apache-2.0 라이선스 원문은 [`third_party/fonts/`](third_party/fonts/README.md)에 정리되어 있습니다.

폰트 파일만 따로 판매하거나 수정 배포할 때는 각 라이선스, 특히 Reserved Font Name 조건을 확인해야 합니다.

릴리즈 빌드, 런타임 아카이브, 모델 파일을 재배포하거나 수정 배포할 때는 해당 구성요소의 원 라이선스와 모델 카드 조건을 함께 확인해야 합니다. 이 파일은 법률 자문이 아니라, 프로젝트에 포함된 외부 의존성을 확인하기 위한 안내입니다.
