# Apple Silicon Alpha 테스트 안내

이 빌드는 **M1 이상, macOS 14 이상**을 대상으로 하며 실제 Mac 검증이 진행 중인 Alpha입니다. Intel Mac은 지원하지 않습니다. 설치·실행 과정과 Gemma, Paddle OCR, Flux Klein·LaMa Manga·AOT 인페인팅, 가져오기·저장·재실행·내보내기를 확인해 주세요.

- 16GB 이상: Gemma 12B와 세 인페인팅 모델
- 24GB 이상: Gemma 26B
- 32GB 이상: Gemma 31B + DFlash

모델 파일은 첫 사용 시 내려받으므로 다운로드 시간과 남은 디스크 공간을 기록해 주세요. 번역이나 인페인팅을 취소한 뒤 재실행하고, 앱 재시작 뒤 캐시가 재사용되는지도 확인해 주세요.

문제나 성공 결과는 [Apple Silicon Alpha Issue 양식](https://github.com/ucx0204/CarrotMangaTranslator/issues/new?template=mac_alpha.yml)에 남겨 주세요. 앱의 문제 신고 기능이 채운 칩, 통합 메모리, macOS, Metal 장치, 모델 설정과 익명화된 로그를 공개 전에 한 번 더 확인해 주세요.
