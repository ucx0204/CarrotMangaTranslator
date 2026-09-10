# 수동 가리기 — 단일 화면 반영 체크포인트

브랜치: `feat/manual-redaction-workspace-20260910`
부모 커밋: `a80f060d3b77308102402d722844f670bdd751cd`
문서 변경 전 제품 트리: `9333220417394ad5a6cfa137c4dc43e971b94b73`

## 실제 반영 범위

이번 커밋은 문서만이 아니라 제품/테스트 25개 파일을 변경한다. 대화에 보존된 `manual-redaction-resume-current.zip`의 32개 변경 중 아래 미반영 7개를 제외한 내용이다. 각 파일의 기준/수정 SHA-256을 보존본과 대조했으며 기준 소스 이후 원격 변경이 문서/개발 워크플로뿐임을 비교했다.

- 전체 보기/연속 편집 탭을 제거하고 썸네일 목록과 편집 영역을 한 화면에 배치한다.
- 페이지 필터와 다중 선택 작업은 왼쪽에, 일괄 확인/적용/되돌리기는 선택 메뉴 안에 둔다.
- 도구는 아이콘과 툴팁으로 정리하고 브러시 설정/선택 삭제는 필요한 때만 보인다.
- 진행률, 페이지 번호/이전/다음, 확인 동작은 하단에 고정한다.
- 기존 grid 초안도 edit로 복원한다. 가림, 검토 결과, 선택 상태는 유지한다.
- 페이지별 redo를 보존하며 다른 페이지의 편집은 무관한 redo를 지우지 않는다. 겹치는 일괄 redo는 전체 단위로 무효화한다.
- 이미지 디코딩, 마스크 준비, 명시적 검토를 분리한다. 썸네일 성공이 상세 미리보기 오류를 없애지 않는다.
- 기존 main의 원본 지문/저장 revision/최종 승인 계약과 원본 보존은 변경하지 않는다. 자동 감지/추천은 추가하지 않는다.

## 정확히 이 조합으로 다시 실행한 검증

환경: Linux, Node 22.16.0, 원격 감사 텍스트 소스와 lockfile에 맞춘 의존성. 아래 결과는 제외 파일을 모두 원격 기존 버전으로 되돌린 뒤 재실행한 결과다.

- `node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json`: PASS, exit 0.
- 집중 Vitest: 9개 파일, 58개 테스트 PASS, 실패 0.
- 포함된 테스트: imageRedaction, manualRedactionContinuousUi, manualRedactionDraftWriter, manualRedactionHelp, manualRedactionKeyboard, manualRedactionLocales, manualRedactionPreviewCache, manualRedactionRaster, manualRedactionSession.
- 100장 목록/일괄 확인/일괄 Undo·Redo, 다중·범위 선택, 입력/IME/반복 Enter/마지막 페이지 확인과 최종 실행 분리, 도구 유지, 설정 메뉴, 5개 언어 안내를 production component로 검사했다.
- 이 커밋의 전체 check/전체 ESLint/Windows dev 실행/build/실제 넓은·좁은 화면 캡처는 완료하지 않았다. jsdom 통과를 Electron 실행 또는 시각 검증 완료로 해석하지 않는다.

## 미반영 파일 — 원격 기존 코드 유지

아래 파일의 보존본 리팩터링은 이 커밋에 포함하지 않는다. 저장 요청 두 건에서 처음 다섯 파일이 도구 보안 확인 단계에 의해 차단되었다. 해당 요청을 다른 쓰기 경로로 재시도하지 않았다. 독립적인 단일 화면 변경만 검증하여 반영한다.

1. `src/renderer/src/components/imageRedaction/useRedactionWorkspaceActions.ts`
2. `src/renderer/src/components/imageRedaction/useRedactionGestures.ts`
3. `src/renderer/src/components/imageRedaction/RedactionBatchDialog.tsx`
4. `src/renderer/src/components/imageRedaction/RedactionPresetsDialog.tsx`
5. `src/renderer/src/components/imageRedaction/RedactionExitDialog.tsx`
6. `src/renderer/src/components/imageRedaction/RedactionWorkspaceDialogs.tsx` — 기존 대화상자 계약과 맞추기 위해 유지.
7. `src/renderer/src/components/imageRedaction/RedactionShortcutDialog.tsx` — 이번 반영 범위에서 제외.

따라서 보존본의 추가 종료 중복 잠금, 목록 클릭 시 편집기 포커스 이동 억제, 종료 창 오류 표시, 잔여 lint 리팩터링 등까지 완료했다고 주장하지 않는다. 원래 3차의 앱 사전 편집 진입점과 전체 인수 검증도 남아 있다.

## 재개

최신 브랜치와 이 문서를 먼저 읽는다. 이미 반영한 25개 파일을 다시 처음부터 만들거나 32개 누적 패치를 무조건 적용하지 않는다. 과거 74개 파일 기록의 ZIP은 현재 대화 파일에서 확보되지 않았으므로 반영/검증 완료로 취급하지 않는다. 현재 원격 실제 코드가 기준이며 남은 파일과 테스트를 개별 대조한다. 강제 push, master 병합, 버전/태그/릴리즈, 사용자 원본·보관함·출력물 변경은 하지 않는다.
