# 수동 가리기 구현 체크포인트

범위와 재개 규칙: `manual-redaction-workspace-handoff.md`.
브랜치: `feat/manual-redaction-workspace-20260910`. 자동 감지 없음. 병합/릴리즈 없음.

## 1 — 공유 모델과 실제 픽셀 처리

- 제품 변경 커밋 `85646a945317fba71d49c1ca85163d991828d4e6`.
- formatter 커밋 `c875396f8410d4f6eff66bc72bd0361f3252aba6`.
- 명시적 검토 상태, 초안/뷰/프리셋 계약, 페이지별 및 일괄 이력, 수동 변환과 순차 지우개 마스크 구현.
- 기존 마스크 회귀 테스트와 새 세션/변환 테스트 작성.
- Actions `34447425711`, 실제 검사 소스 `c875396f`: renderer/electron typecheck 성공.
- 테스트 실행 후 로그 출력에서 Windows Python cp1252가 체크 표시를 출력하지 못해 workflow 실패. 테스트 성공으로 기록하지 않는다. 후속 workflow에 UTF-8 환경을 명시했다.

## 2 — 초안 저장·복원과 전송 경계 연결 (검증 전)

- 경로/페이지 권한을 main에서 해결하는 세션형 IPC, 초안 CAS revision, 원자적 로컬 저장, 수정한 페이지만 검증/저장.
- 원본 fingerprint 변경 시 이전 검토 결과 미사용. 초안 저장은 외부 작업을 실행하거나 승인 파일을 바꾸지 않음.
- 작품/화/선택 페이지의 사전 준비, 한 번에 4장으로 제한한 fingerprint 읽기.
- 세션이 허용한 페이지에만 접근하는 320/2048px 미리보기와 제한된 캐시.
- 최종 승인은 저장된 전체 페이지/검토/가림/revision과 일치해야 함. 기존 원본 재검증과 취소 경계 유지.
- `.github/manual-redaction-integrate.py`는 기존 대형 파일에 검토한 정확한 텍스트만 연결한다. Actions formatter가 그 실제 diff를 이 브랜치에 커밋하며, 중간에 컨텍스트가 다르면 중단한다. 완성 시 개발용 integration script는 제거한다.
- 다음: backend-2 Actions 로그를 확인해 실제 오류 수정. 이후 production renderer 편집기/그리드/자동 저장 UI와 앱 명령 진입점을 구현한다.
- **아직 완료 아님:** 새 UI, 실제 사용자 조작, 프리셋/일괄 편집 UI, 앱 사전 준비 진입점, i18n, UI QA, 전체 check/build 모두 남음.
