# 수동 가리기 — 단일 화면 전체 보존본 반영

브랜치: `feat/manual-redaction-workspace-20260910`
이번 통합 부모: `cf24c8fc74f395b4b20395bd3df6da35c1f91283`

## 반영 범위

`cf24c8f`에 먼저 반영된 제품/테스트 25개 파일을 그대로 보존하고, 같은 보존본에서 빠져 있던 아래 7개 파일을 추가 반영했다. 누적 32개 파일의 단일 화면 수정이 모두 포함된다. 3차 앱 진입점까지 전부 완성했다는 의미는 아니다.

- `useRedactionWorkspaceActions.ts`: 종료/확인 중복 실행 잠금, 목록 선택 시 포커스 유지, 최종 승인 응답 검사.
- `useRedactionGestures.ts`: 포인터/프레임 처리 분리와 기존 수동 그리기·이동·크기 조절 동작 유지.
- `RedactionBatchDialog.tsx`, `RedactionPresetsDialog.tsx`, `RedactionShortcutDialog.tsx`: 기존 기능과 검증 조건을 유지한 작은 컴포넌트/상태 함수 분리.
- `RedactionExitDialog.tsx`, `RedactionWorkspaceDialogs.tsx`: 종료 창에도 실패 사유를 표시하고 연결 계약을 함께 반영.

모든 파일 경로는 `src/renderer/src/components/imageRedaction/` 아래다. 전체 보기 탭 없는 편집기, 썸네일 다중/범위 선택, 메뉴 안의 일괄 처리/프리셋, 아이콘 도구/툴팁, 하단 탐색과 명시적 확인을 유지한다. 자동 저장이나 마지막 Enter로 전송하지 않는다. 자동 감지/추천은 추가하지 않았다.

## 정확한 통합 검증

보존본: `manual-redaction-resume-current.zip`, 패치 SHA-256 `7a745f752d750b2d4c72305ecbf46b5f70fb229fb7421d09bcafa2821ddedc84`.
파일별 기준/수정 SHA-256을 대조한 32개 파일 전체 조합으로 아래 검사를 실행했다. 환경은 Linux / Node 22.16.0 / lockfile에 맞춘 의존성이다.

- TypeScript: `node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json` PASS.
- 실제 dev main 컴파일 경로: `node node_modules/typescript/bin/tsc -p tsconfig.electron.json` PASS.
- 집중 ESLint: imageRedaction 전체, ImageRedactionModal, manualRedaction 테스트, `--max-warnings 0` PASS.
- 집중 Vitest: 9개 파일 / 58개 테스트 PASS / 실패 0. production component 기반 연속 편집, 100장 선택/일괄 확인/Undo·Redo, 입력/IME/반복 Enter/마지막 확인과 전송 분리, 도구 유지, 5개 언어, 픽셀/세션/저장/캐시를 포함한다.

동시 갱신된 `cf24c8f`를 덮어쓰지 않고 그 위에 누락 7개만 추가했다. 그 결과 전체 `src` 트리 `bcb11b98ef2ada2582367109b90c0b3fa2699751`과 `tests` 트리 `76dfea50543c6cbe6e9899c96038d05009341563`가 먼저 생성한 32개 파일 통합 트리와 정확히 일치함을 원격 Git tree로 확인했다.

## 남은 검증과 기능

전체 `npm run check`, 전체 build, Windows `npm run dev` 실제 기동, production component의 넓은/좁은 화면 시각 검증은 아직 완료하지 않았다. 위 컴파일/jsdom 검사를 실제 Electron 실행 결과로 표현하지 않는다.

3차 작품/화/선택 페이지 사전 편집 앱 진입점, 검토 결과 재사용과 이어하기의 앱 전체 흐름은 다음 작업이다. main 준비/저장 계약의 존재와 사용자 진입점 완성을 구분한다.

## 재개

이 브랜치 최신 HEAD와 `AGENTS.md`, `manual-redaction-workspace-handoff.md`, `manual-redaction-latest-validation.md`를 읽고 현재 코드에서 계속한다. 이전 32개 패치를 다시 적용하거나 미반영이라고 안내하지 않는다. 과거 74개 파일/122개 테스트 기록은 이번 통합 범위가 아니다. 강제 push, master 병합, 버전/태그/릴리즈 변경, 사용자 원본·보관함·출력물 수정은 하지 않는다.
