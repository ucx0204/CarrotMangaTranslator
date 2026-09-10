# 수동 가리기 UI 체크포인트 (구현 중)

브랜치: `feat/manual-redaction-workspace-20260910`.
기준 인계: `manual-redaction-workspace-handoff.md`, `manual-redaction-workspace-checkpoints.md`.
자동 감지 없음. master 병합과 릴리즈 없음.

## 검증 완료한 기반

- backend-2 Actions `34448570429` 성공.
- 실제 통합/포맷 소스 `02f4a2e7b91fc080069ffc26723117b30e4cd738`.
- renderer/electron 타입 검사 및 세션·래스터·초안 저장·기존 전송 검증 테스트 실행 성공.
- 이 결과는 아래 새 UI를 포함하지 않는다.

## 체크포인트 3 — 사용자 화면 연결 (미검증)

- 기존 로드 기반 확인창을 새 수동 workspace 진입점으로 교체.
- 키보드 탐색, 명시적 확인/보류, 상태 유지, 이동/크기 조절/가림 지우개.
- 실제 전송 픽셀 정책을 공유한 편집 마스크, 가상화 그리드, 범위 선택, 일괄 확인/복사, 수동 프리셋.
- 자동 저장 revision writer, 제한된 미리보기 큐/캐시, 이미지 로드와 검토 분리, 준비 모드/작업 모드 최종 승인 분리.
- 종료 확인: 저장 후 나가기 또는 이번 세션 되돌리기. 둘 다 외부 전송 없음.
- `.github/manual-redaction-integrate.py`는 이번 UI 패치와 ko/en/ja 메시지를 연결한다. 실제 변경은 Actions가 포맷 후 feature 브랜치에 체크포인트로 저장한다.

## 다음 해야 할 일

1. UI 연결용 스크립트 실행 및 typecheck/Vitest, 전체 lint로 실제 오류를 찾고 수정한다. 아직 통과로 간주하지 않는다.
2. 부족한 경계 테스트: 실제 컴포넌트에서 키보드/입력/IME, 마지막 Enter, 페이지 왕복, bulk undo/redo, 에러 재시도, StrictMode, 세션 취소, 멀티 페이지 미리보기 races.
3. 작품/화/선택 페이지 사전 준비를 여는 앱 명령과 사용자 진입점 연결 (3차의 남은 핵심).
4. 기존 API 계약/설정/UI snapshot 테스트 수정이 필요하면 새 기능 동작을 검증하면서 갱신한다. 검사를 제거하거나 임계값을 완화하지 않는다.
5. 실제 UI QA 1600×980와1240×760, overflow/이미지 비율/마스크 일치/닫기 흐름 확인. 빌드 및 전체 Check를 끝내기 전에는 완료로 보고하지 않는다.
6. 개발용 integration script/워크플로 정리, 최종 기능 상태와 검증 커밋을 인계 문서에 반영한다.
