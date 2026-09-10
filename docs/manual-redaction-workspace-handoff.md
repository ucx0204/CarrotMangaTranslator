# 수동 전송 이미지 가리기 작업 인계

## 작업 범위와 권한

- 사용자 요청: 계획의 1~3차를 새 브랜치에서 구현하고 중단 후에도 이어서 작업한다.
- 작업 브랜치: `feat/manual-redaction-workspace-20260910`
- 기준 커밋: `19b660f4160e4a64ce479caa09a20437f9ed3c81`
- **수동 전용. 자동 감지, 자동 마스킹, 자동 위치 추천은 추가하지 않는다.**
- 추가 사용자 지시: `npm run dev` 컴파일 오류를 먼저 고친다. 화면의 긴 설명을 없애고 필요한 안내만 툴팁으로 제공한다. 오류와 필수 확인 조건은 짧게 표시한다.
- `master` 병합, 버전 변경, 태그 생성, 앱/자산 릴리즈 게시는 이번 작업 범위가 아니다.
- 원본 이미지·보관함·기존 출력물은 수정하거나 삭제하지 않는다. 가리기는 외부 전송 복사본에만 적용한다.

## 현재 상태 — 여기서 재개

기반 코드와 새 편집 화면은 이미 이 브랜치에 있다. 처음부터 다시 만들지 않는다. **전체 1~3차가 완료된 상태는 아니다.**

- 저장·세션 기반: 검증 소스 `02f4a2e7b91fc080069ffc26723117b30e4cd738`, Actions `34448570429` 성공.
- 사용자 보고 TS2322: 중국어 간체·번체의 `manualRedaction` 누락을 `55d184c194bc77552432bdc617b462240f20be5a`에서 실제 번역으로 보완했다. `resources.ts`의 엄격한 타입은 유지했다. 모든 지원 언어의 키/치환 인자 회귀 검사를 추가했다.
- 위 수정의 검증: Actions `34452447082`에서 typecheck, Electron typecheck, 실제 `tsconfig.electron.json` 컴파일, 집중 회귀 테스트, mock 경계 검사, build 통과. **focused ESLint는 실패했다. 전체 검사 성공으로 표시하지 않는다.**
- 그 이후 `69a8e4f`~`4d70b1a`에서 작업 화면을 분리하고 상시 안내문을 줄였다. 일괄 작업·프리셋·단축키 안내는 공용 툴팁으로 이동했다. 이 최신 UI의 검증은 위 `55d184c` 결과와 구분한다.
- 최신 읽기 전용 감사: 소스 `2b1d619298ba1de324dacb8977e7c8eac74b2cbb`, Actions `34456238816`. 개발용 컴파일/회귀/빌드/ESLint와 실제 1600×980, 1240×760 편집·그리드·툴팁 캡처를 검사한다. 최종 결과는 해당 실행에서 확인한다.
- 감사 artifact `manual-redaction-audit-<run id>`에는 실제 UI 캡처, 결과 JSON, 소스/JavaScript 도구 스냅샷이 있다. 사용자 보관함, 인증 파일, `.git`, 브라우저 프로필, 네이티브 바이너리는 포함하지 않는다.

## 중단 후 재개 절차

1. 이 브랜치의 최신 head를 읽고 `AGENTS.md`, 이 문서, `git log -12 --oneline`, `git diff`를 확인한다. 같은 이름의 브랜치를 다시 만들지 않는다.
2. 최신 Actions 결과와 검증 소스 SHA를 대조한다. 코드가 존재하는 것과 검증 완료는 다르다.
3. 최신 audit의 컴파일/테스트 오류와 ESLint 진단부터 고친다. 검사 삭제, 타입 단언으로 오류 숨기기, 임계값 완화는 하지 않는다.
4. 실제 production component 캡처를 열어 잘림·겹침·외부 스크롤을 확인한다. 캡처 성공만으로 시각 검증 완료를 선언하지 않는다.
5. 변경을 작은 단위 커밋으로 보존하고 이 문서와 `manual-redaction-latest-validation.md`에 정확한 검사 범위를 기록한다.
6. 다른 사람이 브랜치를 갱신했다면 변경을 먼저 읽는다. 강제 push를 하지 않는다. 기본 브랜치와 릴리즈는 건드리지 않는다.

## 남은 작업

### 현재 오류와 검증

- [ ] 최신 화면의 focused ESLint 문제 정리: 긴 함수/복잡도, refs의 렌더 접근 및 hook 의존성.
- [ ] 실제 컴포넌트의 입력·IME·키 반복, 마지막 Enter, 페이지 왕복, 저장 실패/재시도, StrictMode, 미리보기 race 테스트.
- [ ] 실제 넓은/좁은 UI 캡처 직접 확인 및 필요 시 레이아웃 수정.
- [ ] 최종 `npm run check`와 빌드 통과.

### 1~2차 기능의 최종 인수 검증

- [ ] 연속 이동·명시적 확인/보류·차단 이유와 상태 유지.
- [ ] 페이지별 가림/이력/확대·위치, 초안 저장/복구, 저장과 전송 승인 분리.
- [ ] 그리드·범위 선택·필터·일괄 확인·가림 복사/교체·프리셋과 일괄 되돌리기.
- [ ] 선택 가림 편집·가림 지우개와 실제 전송 픽셀 일치.
- [ ] 제한된 이미지 캐시·가상화·인접 prefetch. 로드를 확인으로 취급하지 않는다.

### 3차의 남은 연결

- [ ] 작업 전 작품/화/선택 페이지 준비를 여는 앱 명령과 사용자 진입점. main의 준비/저장 계약은 있으나 앱 진입점 연결은 미완료다.
- [ ] 원본/가림이 동일한 검토 결과 재사용, 변경한 페이지만 재검토하는 전체 흐름.
- [ ] 위치·선택·보류 상태 복원과 새 전송 세션에서의 명시적 최종 승인.
- [ ] 개발 전용 integration script/워크플로 정리 및 최종 인계 갱신.

## 검증 명령과 보조 기록

- `npm run typecheck`
- `npm run typecheck:electron`
- `node node_modules/typescript/bin/tsc -p tsconfig.electron.json`
- `npm run test -- tests/manualRedaction tests/imageRedaction.test.ts tests/imageRedactionReview.test.ts`
- `npm run check:test-mock-boundaries`
- `npm run build`, 최종 `npm run check`
- 자체 `qa:ui` 도구로 실제 production component와 스타일을 사용한다. 임시 QA 파일은 제거한다.

기존 세부 기록: `manual-redaction-workspace-checkpoints.md`, `manual-redaction-workspace-ui-checkpoint.md`, `manual-redaction-latest-validation.md`.
컨테이너에서 GitHub DNS 접근은 실패했다. 연결된 GitHub 도구와 브랜치 전용 Actions를 사용한다. 인증 토큰은 출력하거나 파일로 저장하지 않는다.
