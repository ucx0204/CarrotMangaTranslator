# Apple Silicon Alpha 테스트 체크리스트

테스트 전 GitHub Release의 SHA256과 DMG/ZIP 파일을 대조하고, 중요한 원본은 백업해 주세요. 실패하면 앱의 문제 신고 기능 또는 Mac Alpha Issue 양식을 사용합니다.

## 환경

- [ ] Mac 모델/칩:
- [ ] 통합 메모리(GB):
- [ ] macOS 버전:
- [ ] DMG 또는 ZIP / Alpha 번호:
- [ ] Developer ID 또는 Unsigned(ad-hoc) 빌드:

## 공통 흐름

- [ ] `/Applications`에서 실행 → 작은 PNG 가져오기 → 저장 → 완전 종료 → 재실행 복원 → PNG/TXT 내보내기 전체 수명주기
- [ ] `/Applications`에서 앱이 열리고 `Apple Silicon Alpha` 표시가 보임
- [ ] 최초 Alpha 안내와 GitHub Issue 링크가 동작함
- [ ] 이미지·폴더·ZIP/CBZ 가져오기
- [ ] 저장 후 앱을 종료·재실행해 작업 복원
- [ ] PNG, TXT, CSV/TSV와 `*.mgtshare` 내보내기
- [ ] 번역·OCR·인페인팅 취소 후 다시 실행
- [ ] 로그/Issue 내용에서 사용자 이름과 `/Users/<name>` 경로가 익명화됨

## 모델과 메모리

- [ ] 16GB 이상: Gemma 12B 다운로드·Metal 번역·캐시 재사용
- [ ] 24GB 이상: Gemma 26B 다운로드·Metal 번역·캐시 재사용
- [ ] 32GB 이상: Gemma 31B+DFlash 번역과 로그의 CPU-ring 확인
- [ ] 부족한 메모리 등급에서 이유·필요 용량·위험 확인 절차 표시

## OCR과 인페인팅

- [ ] Paddle OCR CPU로 실제 만화 이미지 인식
- [ ] PaddleOCR-VL 풀로드를 Apple GPU(MLX/Metal)로 실제 만화 이미지 인식
- [ ] AOT Metal 실행, 실패 시 알림 후 CPU 재시도
- [ ] LaMa Manga Metal 실행, 실패 시 알림 후 CPU 재시도
- [ ] Flux Klein Metal 실행(다른 모델 또는 CPU로 몰래 변경되지 않음)
- [ ] 인페인팅 종료 30초 뒤 러너/모델 해제
- [ ] 인페인팅 후 Gemma 시작 시 인페인팅 캐시 해제
- [ ] 마스크 붓·색 붓·스포이드·복원 붓과 실행 취소/다시 실행

## Issue에 함께 적을 것

- 재현 단계와 기대/실제 결과
- 사용한 Gemma 모드와 인페인팅 모델
- 처음 실패한 시각과 재시도 결과
- 가능하면 저작권·개인정보를 제거한 샘플 이미지
- 앱에서 자동 생성한 익명화 로그
