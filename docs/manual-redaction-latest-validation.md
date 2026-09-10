# 수동 가리기 최신 검증과 재개 위치

브랜치: `feat/manual-redaction-workspace-20260910`
검사한 원격 소스: `392eaac4af95d04b4f52b2683693e41e462fda9b`
Windows Actions: `34500583095`

## 이미 원격에 반영된 제품 변경

- `8280d9c`: 선택한 페이지 확인을 메뉴 밖으로 노출하고 UI 회귀를 수정했다.
- `f1c960d`: 과거 보류 초안을 미확인으로 읽되 가림, 선택, 위치, 확대와 저장 revision을 보존한다.
- `4575ec6`, `07ff90b`: 다섯 언어의 구분되는 문구, 전체 선택/해제 노출, 선택과 검토 상태의 텍스트 표시.
- `6e96e0d`: 페이지 확인은 이미지 아래, 작업 재개는 별도 하단으로 분리했다. 진행률/저장 상태의 클릭 영역과 체크 아이콘, 보류 동작/단축키/필터를 제거했다. 명시적인 최종 전송 승인은 유지한다.
- `c2b0c13`, `392eaac`: 해당 원격 코드의 실제 화면 및 Windows 검증을 추가했다.

기존 단일 편집 화면과 위 제품 변경은 원격에 남아 있다. 처음부터 다시 구현하거나 과거 누적 패치를 재적용하지 않는다.

## 실제 Windows 검사 결과

| 검사                  | 결과                                |
| --------------------- | ----------------------------------- |
| TypeScript            | PASS                                |
| Electron TypeScript   | PASS                                |
| 실제 개발 main 컴파일 | PASS                                |
| 집중 테스트           | 12개 파일, 71개 PASS                |
| mock 경계             | PASS                                |
| 전체 앱 build         | PASS                                |
| 집중 ESLint           | PASS                                |
| 실제 화면 QA          | 넓은 화면 캡처 성공, 좁은 화면 실패 |
| 전체 `npm run check`  | 타입 검사 후 문서 포맷에서 중단     |

Actions 전체 conclusion은 failure다. 위 집중 검사 성공을 전체 check 또는 시각 인수 완료로 표현하지 않는다. 설치 프로그램 빌드/배포 또는 Windows 앱을 직접 사용하는 검증도 아니다.

증거: `manual-redaction-ux-34500583095` artifact의 두 `result.json`, 테스트/빌드 로그와 `review-wide.png`; `manual-redaction-full-check-34500583095`의 `check.log`.

## 실제 화면에서 발견한 남은 문제

1240×760, 960×620에서는 고정 1440px 모달이 화면 밖으로 나간다. 1600×980 캡처를 직접 확인하니 공용 숫자 입력의 기본 너비에 밀려 확대/페이지 입력이 인접 버튼을 덮는다. 또한 Enter로 다음 페이지를 연 후 포커스가 썸네일로 옮겨가 연속 검토가 끊기는 회귀를 재현했다.

전체 check의 포맷 실패 파일은 이 문서 하나였다. 이번 문서 변경은 이를 정리하고 실제 결과를 기록하는 별도 커밋이다. 포맷 후 전체 check를 다시 통과했다고 표시하지 않는다.

## 로컬 후속 수정 — 아직 원격 미반영

다음 제품 파일 세 개의 저장 요청이 도구 보안 확인 단계에서 차단되었다. 원격 제품 코드를 갱신한 것으로 취급하지 않는다.

- `src/renderer/src/components/imageRedaction/ManualRedactionWorkspace.tsx`: 모달 최대 너비 제한.
- `src/renderer/src/components/imageRedaction/RedactionWorkspace.module.css`: 숫자 입력 너비/축소 제한과 고정 탐색 위치.
- `src/renderer/src/components/imageRedaction/useRedactionWorkspaceActions.ts`: 썸네일 대신 편집 영역을 우선 포커스.

관련 `tests/manualRedactionContinuousUi.test.tsx`에 추가한 포커스 회귀와 `.github/manual-redaction-ux-qa.py`의 버튼 가림 검증 강화도 로컬에만 있다. 포커스 테스트는 수정 전 실패/수정 후 통과했으며, 로컬 UI/키보드 12개 테스트와 집중 ESLint는 통과했다. 이 후속 수정의 Windows 빌드나 실제 화면 검증은 하지 못했다.

대화의 `manual-redaction-ux-followup-checkpoint.zip`에는 위 네 제품/테스트 파일의 작은 패치, 파일별 해시, 추가 QA 소스와 검증 요약을 보존한다. 원격에 이미 반영된 전체 코드를 대체하는 ZIP이 아니다. 다음 재개 때 정확한 원격 HEAD와 패치 기준 해시부터 대조한다. 차단된 요청을 다른 API, 인코딩, 워크플로로 우회하지 않는다.

## 재개 순서

1. 최신 HEAD, 이 문서와 `manual-redaction-ux-clarity-checkpoint.md`, `AGENTS.md`를 읽는다.
2. 미반영 네 파일만 현재 원격과 대조한다. 정상 허용되는 환경에서만 코드 저장을 진행한다.
3. 좁은 창/버튼 겹침/키보드 포커스 회귀를 수정한 소스로 Windows 검사와 실제 UI QA를 재실행한다.
4. 전체 `npm run check`의 남은 단계와 원래 3차 사전 편집 진입점은 별도의 미완료 범위다.

기본 브랜치, 버전, 태그/릴리즈와 사용자 원본/보관함/출력물은 변경하지 않았다. 수동 가리기만 제공하며 자동 감지/추천은 추가하지 않는다.
