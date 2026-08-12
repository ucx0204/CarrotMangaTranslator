# UI/UX 일관성·컴포넌트 통합 감사 보고서

> 대상: Carrot Manga Translator 데스크톱 렌더러
>
> 감사 기준일: 2026-08-09
>
> 범위: 현재 프로덕션 UI 코드, 실제 렌더링, 대표 작업 화면, 관련 제품·디자인 시스템 1차 자료
>
> 문서 성격: 구현 전 기준선 진단 및 재설계 제안서. 아래 “구현 상태 메모”에서 후속 P0 반영 범위를 별도로 기록한다.

> **구현 상태 메모 (2026-08-12):** 이 감사 뒤 P0 후속 작업으로 번역 범위·덮어쓰기 안전성, 설정 초기화의 즉시 반영, 진행 상태 중복, 탭·세그먼트·메뉴 키보드 계약을 우선 개선했다. 한 차례 적용했던 빈 화면 단일 진입점과 작업 전 패널 숨김·패널 접기·리사이즈는 사용자 피드백에 따라 전부 롤백했으며, 기존 진입 버튼과 고정 좌우 패널을 유지한다. 요청에 따라 CUDA 레거시 풀로드 기능과 전용 런타임·설치 경로를 제거했고, 이후 Paddle OCR `최소` 모드와 번역 `정밀 2차` 모드도 제품 코드와 UI에서 제거했다. 이전 저장값은 현재 `절약` 및 `누적 컨텍스트` 기본값으로 단방향 정규화된다. 구현 전·후 실제 렌더링은 [`artifacts/ui-ux-p0-20260809`](../artifacts/ui-ux-p0-20260809/README.md)에 보관했다. 본문의 계수와 진단은 변경 전 기준선이므로 후속 비교 시 이 메모를 함께 읽어야 한다.

빠르게 읽을 때는 `0. 결론 → 4. 핵심 발견 → 18. 우선순위 → 20. 즉시 착수 순서`를 보면 된다. 구현자는 `6. 컴포넌트 통합`, `13. 구현 단위 전수 감사`, `14. 로드맵`, `15. QA 계획`을 함께 참고하고, 제품 설계자는 `5. 사용자 여정`, `9. 벤치마크`, `10. 목표 흐름`, `19. 구체적 결함`을 우선 보면 된다.

## 0. 결론부터

현재 UI의 가장 큰 문제는 단순히 “컴포넌트가 많다”거나 “색이 안 예쁘다”는 것이 아니다. **같은 명령, 상태, 선택 범위, 편집 속성이 여러 위치에서 서로 다른 형태와 중요도로 표현되어 권위 있는 위치가 불명확한 것**이 핵심 문제다. 공통 `Button`, `IconButton`, `Modal`, `TextField`, `SelectionSurface`가 이미 생겼지만, 제품 구조가 먼저 정리되지 않아 새 공통 컴포넌트와 기존의 로컬 구현이 동시에 늘고 있다.

가장 먼저 해야 할 일은 다음 다섯 가지다.

1. 좌측은 작품·챕터·페이지 탐색, 중앙은 캔버스, 우측은 선택 대상의 속성이라는 역할을 고정한다.
2. `번역`과 `작품 일괄 번역`을 **하나의 번역 실행 흐름 + 명시적인 범위 선택**으로 합친다.
3. 페이지별 상태는 페이지 행, 전체 작업 상태는 작업 센터, 상세 로그는 진단 영역 한 곳에서만 보여준다.
4. 전역 HTML 요소 스타일과 로컬 버튼/필드 구현을 공통 프리미티브와 소수의 복합 패턴으로 단계적으로 교체한다.
5. 재번역·일괄 스타일·인페인트·내보내기에 체크포인트, 영향 범위 미리보기, Undo를 기본 안전장치로 둔다.

구조 개편을 기다리지 않고 먼저 고칠 안전성 문제도 두 가지 있다. 설정의 `기본값 복원`은 확인 없이 실제 설정을 즉시 바꾸지 말고 로컬 draft만 바꾼 뒤 저장하도록 해야 한다. 번역 실행 시 선택한 일회성 옵션 역시 고지 없이 다음 실행 기본값으로 저장하지 말고 `이번 실행에만 적용`을 기본으로 해야 한다.

목표 구조는 다음과 같다.

```text
상단 바       작품 / 챕터 경로 | 저장 상태 | Undo / Redo | 작업 큐 | 내보내기
좌측 탐색     검색·필터 | 작품 → 챕터 → 페이지 | 페이지별 짧은 상태
중앙 캔버스   도구막대 | 이미지·블록 | 선택 대상 근처의 짧은 컨텍스트 바
우측 검사기   페이지 / 블록 / 인페인트 / 다중 선택에 따라 바뀌는 단일 Inspector
작업 센터     접이식 큐 | 실패·재시도 | 작업 기록 | 상세 로그
```

이 구조를 먼저 정한 뒤 컴포넌트를 통합해야 한다. 지금 보이는 모든 `<button>`을 기계적으로 `Button`으로 바꾸는 식의 정리는 코드 줄 수만 옮기고 UX 중복을 그대로 남길 가능성이 높다.

---

## 1. 감사 방법과 증거 수준

### 1.1 조사한 범위

- 렌더러의 React/TypeScript 컴포넌트 160개와 CSS 계층
- 공통 UI 프리미티브와 실제 채택 현황
- 앱 셸, 빈 상태, 작품·챕터·페이지 탐색, 번역 실행, 진행 상태, 텍스트 편집, 모아보기, 인페인트, 설정, 공유·내보내기
- 저장소의 프로덕션 컴포넌트를 이용한 실제 Chromium 렌더링
- 저장소에 포함된 번역·진행·인페인트 대표 화면
- 만화/이미지 번역기, CAT 도구, 이미지 편집기, 데스크톱 생산성 앱의 공식 문서와 공식 저장소
- WCAG 2.2, WAI-ARIA APG, Fluent, Spectrum, Carbon 등 1차 디자인·접근성 자료

### 1.2 실제 화면 검증

저장소의 자체 QA 도구로 `stable` 채널의 프로덕션 UI를 다음 크기에서 렌더링했다.

- 기본 창: 1600×980
- 코드상 최소 창: 1240×760
- 참고용 스트레스 상태: 1440×900, 1024×768, 420×860

실제 창 기본값과 최소값은 [`mainWindow.ts`](../src/main/mainWindow.ts#L136)에 각각 1600×980, 1240×760으로 선언되어 있다. 따라서 1024px와 420px 결과는 현재 메인 창 지원 범위의 회귀 판정으로 사용하지 않고, 패널 가변화·보조 창·향후 좁은 화면 대응을 위한 참고 자료로만 사용했다.

채워진 작업 상태는 저장소의 다음 실제 제품 스크린샷과 해당 렌더러 코드를 함께 검토했다.

- [`example-workspace.png`](images/example-workspace.png)
- [`example-translation-options.png`](images/example-translation-options.png)
- [`example-translation-progress.png`](images/example-translation-progress.png)
- [`example-inpainting.png`](images/example-inpainting.png)

### 1.3 정적 계수

감사 시점의 렌더러에서 확인된 수치다. 숫자는 “곧바로 결함 수”가 아니라 통합 범위를 가늠하는 지표다.

| 항목                         |           수치 | 해석                                                        |
| ---------------------------- | -------------: | ----------------------------------------------------------- |
| `.tsx` 파일                  |            160 | 렌더러 표면적이 이미 작지 않다.                             |
| 원시 `<button>` 태그         | 105개 / 52파일 | 툴바·메뉴 같은 정당한 예외와 단순 중복이 혼재한다.          |
| 원시 `<input>` 태그          |  69개 / 39파일 | 설정·숫자·색상·검색 필드의 로컬 구현이 많다.                |
| 원시 `<select>` 태그         |  24개 / 20파일 | 레이블·오류·도움말·높이 규칙이 쉽게 갈라진다.               |
| 원시 `<textarea>` 태그       |            9개 | 텍스트 편집 역할과 접근성 규칙을 별도로 정의할 필요가 있다. |
| `Button`을 import한 파일     |             44 | 공통화가 시작되었지만 완료되지 않았다.                      |
| `IconButton`을 import한 파일 |             15 | 아이콘 전용 도구의 상당수가 로컬 버튼이다.                  |
| `Modal`을 import한 파일      |             22 | 모달 기반은 비교적 잘 통일된 편이다.                        |
| CSS의 `z-index` 선언         |             37 | 레이어 계층 토큰 없이 로컬 경쟁이 생길 위험이 높다.         |
| 미디어 쿼리                  |             21 | 반응형 규칙이 있으나 고정 4열 셸과 함께 운용된다.           |
| `!important`                 |              8 | 전역 요소 스타일과 로컬 스타일 충돌의 흔적이다.             |

`foundations.css`와 폰트 선언을 제외한 CSS에는 하드코딩된 인터페이스 색상이 다수 남아 있다. 캔버스의 블록·마스크·가이드처럼 의미가 있는 작업 오버레이 색상은 일반 UI 색상과 분리해 유지해야 하지만, 버튼·패널·상태·테두리 색상은 의미 토큰으로 흡수해야 한다.

### 1.4 한계

- 이 보고서는 코드, 렌더링, 휴리스틱, 외부 제품 패턴을 근거로 한 전문가 감사다. 실제 사용자 관찰이나 사용 분석 데이터는 포함하지 않았다.
- 서버 비용, 모델별 평균 시간, 실제 실패율이 제공되지 않아 시간·비용 UI는 정보 구조만 제안했다.
- 외부 제품은 기능과 상호작용 구조를 비교했다. 시각 스타일을 그대로 복제하자는 제안이 아니다.
- 공식 문서·공식 저장소만으로 충분한 근거를 확보했으므로 별도 설치 파일은 다운로드하거나 역분석하지 않았다.

---

## 2. 현재 UI의 좋은 기반

모두 갈아엎을 상태는 아니다. 다음 기반은 유지하고 강화하는 편이 낫다.

### 2.1 접근성을 고려한 공통 모달

[`Modal.tsx`](../src/renderer/src/components/ui/Modal.tsx#L7)는 포커스 가능한 요소 탐색, 중첩 모달 스택, `Esc`, 초기 포커스, 포커스 복귀, Tab 포커스 트랩, `aria-modal`을 이미 처리한다. 개별 모달이 이를 재구현하는 대신 이 프리미티브를 계속 표준으로 삼아야 한다.

개선할 점은 프리미티브를 버리는 것이 아니라 다음을 보강하는 것이다.

- 제목이 있을 때 `aria-labelledby`가 자동이므로 중복 `ariaLabel` 사용 제거
- `sm/md/lg/xl` 외의 임의 `width`, `cardClassName`, `bodyClassName`을 줄이는 레이아웃 레시피
- 확인, 폼, 선택기, 진행 상황처럼 반복되는 모달 본문·푸터 패턴
- 모달이 아닌 메뉴·팝오버·비차단 패널을 억지로 모달로 만들지 않는 별도 Overlay 계층

### 2.2 의미 토큰의 출발점

[`foundations.css`](../src/renderer/src/styles/foundations.css#L1)에는 앱·레일·패널·들어간 면·올라온 면, 텍스트, 테두리, 포커스, 위험, 성공, 경고, 간격, 반경, 컨트롤 높이, 타이포그래피 토큰이 이미 있다. 새로운 디자인 시스템을 별도 패키지로 다시 시작할 필요 없이 이 파일을 **semantic token source of truth**로 승격하면 된다.

다만 현재는 다음 토큰이 더 필요하다.

- `status.running`, `status.queued`, `status.review`, `status.success`, `status.warning`, `status.danger`
- `canvas.block`, `canvas.maskAdd`, `canvas.maskRemove`, `canvas.guide`, `canvas.selection`처럼 UI와 분리된 작업 색상
- `elevation.popover/modal/toast`, `layer.base/sticky/popover/modal/toast/drag`
- `density.compact/default`, 행 높이, 아이콘 크기, 툴바 목표 크기
- `motion.fast/default/slow`, easing, reduced-motion 규칙

### 2.3 공통 버튼·필드·선택 표면

[`Button.tsx`](../src/renderer/src/components/ui/Button.tsx#L4)는 variant, size, full width, 좌우 아이콘을 지원하고, [`IconButton.tsx`](../src/renderer/src/components/ui/IconButton.tsx#L4)는 가시 텍스트가 없는 버튼의 접근 가능한 이름을 필수로 만든다. [`Field.tsx`](../src/renderer/src/components/ui/Field.tsx#L4)와 [`SelectionCard.tsx`](../src/renderer/src/components/ui/SelectionCard.tsx#L3)도 각각 레이블/힌트와 선택 상태의 공통 기반을 제공한다.

문제는 이들이 나쁘다는 것이 아니라 **표준화 범위가 아직 불명확하다**는 점이다. 텍스트 액션, 아이콘 액션, 툴바 토글, 메뉴 항목, 탭, 선택 카드가 모두 “버튼”이라는 이유로 하나의 시각 규칙을 쓰면 안 된다. 프리미티브 위에 역할별 복합 패턴을 만들어야 한다.

### 2.4 인페인트의 단계형 흐름

저장소의 인페인트 UI는 Auto → Retouch → Export라는 단계가 비교적 잘 보이고, 자동 처리 결과를 사용자가 손으로 보정하는 흐름을 제공한다. 이 방식은 번역 실행 → 문제 검수 → 내보내기에도 재사용할 가치가 있다.

유지하면서 고칠 점:

- `인페인팅 나가기`가 단순 내비게이션이라면 위험색을 제거하고 `← 편집으로 돌아가기`로 표현
- 자동 마스크를 오버레이로 보여주고 더하기/빼기를 같은 도구 체계로 통합
- `미리보기`와 `적용`을 구분하고 적용 뒤에도 Undo 가능하게 함
- `현재 페이지만`, `선택한 n페이지`, `남은 모든 페이지`를 버튼 이름에서 명시

### 2.5 원본 비교와 커맨드 팔레트의 존재

원본 보기, 블록/크롬 토글, Undo/Redo, 커맨드 팔레트와 단축키 도움말이 이미 존재한다. 이들은 전문 편집기의 좋은 기반이다. 다만 현재 [`AppRightQuickRail.tsx`](../src/renderer/src/components/AppRightQuickRail.tsx#L33)에 페이지 전역 동작이 별도 44px 레일로 고정되어 있으므로, 상단 바·캔버스 도구막대·컨텍스트 바와 역할이 겹치지 않도록 재배치할 필요가 있다.

---

## 3. 심각도 기준

| 등급 | 의미                                                                             | 처리 시점                |
| ---- | -------------------------------------------------------------------------------- | ------------------------ |
| P0   | 잘못된 범위 실행, 데이터 손실, 대표 명령·상태의 구조적 혼란, 핵심 편집 공간 침해 | 다음 UI 개편의 선행 조건 |
| P1   | 반복 작업 효율, 접근성, 학습성, 일관성에 큰 영향을 주는 문제                     | P0 구조 위에서 즉시 진행 |
| P2   | 고급 사용자 생산성, 개인화, 세부 미감과 확장성                                   | P0/P1 안정화 후          |
| Keep | 현재 좋은 기반. 제거 대신 표준으로 승격                                          | 마이그레이션 중 보호     |

---

## 4. 핵심 발견 요약

| ID      | 우선순위 | 발견                                                       | 직접 영향                                       | 권장 방향                                     |
| ------- | -------- | ---------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| IA-01   | P0       | 좌 400 + 빠른 레일 44 + 우 340의 고정 4열                  | 최소 창에서 중앙 캔버스가 456px 안팎까지 줄어듦 | 좌우 패널 접기·크기 조절·상태 복원            |
| IA-02   | P0       | 번역 진입점과 범위가 여러 곳에 중복                        | 잘못된 범위 실행, 학습 비용                     | 하나의 `번역 실행` + 범위 선택                |
| IA-03   | P0       | 작업 상태가 페이지 행·우측 카드·도크·로그에 반복           | 무엇이 최신/정확한지 불분명                     | 페이지 상태와 전체 작업 센터 분리             |
| SAFE-01 | P0       | 재번역·일괄 적용의 영향과 복구 경로가 약함                 | 수동 교정 손실 위험                             | 체크포인트, 미리보기, 프로젝트 단위 Undo      |
| SAFE-02 | P0       | 설정 `기본값 복원`이 draft가 아니라 실제 설정을 즉시 바꿈  | 엔진·언어·경로 설정의 의도치 않은 손실          | draft에만 반영 후 저장, 또는 구체적 확인+Undo |
| SAFE-03 | P0       | 번역 실행의 일회성 옵션이 고지 없이 다음 기본값으로 저장됨 | 다음 작품의 비용·시간·결과가 예상과 달라짐      | `이번만` 기본, 명시적 `기본값으로 저장`       |
| IA-04   | P0       | 빈 상태에서도 좌우 패널과 중복 CTA를 모두 유지             | 첫 행동이 불명확하고 화면이 비어 보임           | 단일 Primary CTA와 설정 점검                  |
| CMP-01  | P1       | 공통 프리미티브와 원시 요소가 병존                         | 상태·높이·포커스·비활성화가 갈라짐              | 역할별 프리미티브/레시피와 점진 이관          |
| CMP-02  | P1       | 선택기·페이지 범위 UI가 화면별로 재구성됨                  | 같은 개념이 다른 조작법을 가짐                  | 공통 ScopePicker·PagePicker                   |
| CMP-03  | P1       | 메뉴·팝오버·플라이아웃이 각자 구현됨                       | 키보드·Esc·충돌 처리 불일치                     | FloatingLayer + Menu/Popover 표준             |
| CMP-04  | P1       | 설정·편집 필드가 로컬 숫자/선택/색상 컨트롤을 가짐         | 단위·범위·오류 표현 불일치                      | FieldShell 계열과 schema 기반 폼              |
| UX-01   | P1       | 페이지 목록 행이 입력 상자처럼 보이고 동작이 밀집          | 스캔성·선택성·편집 가능성 혼란                  | 썸네일·2줄 정보·상태·오버플로 행              |
| UX-02   | P1       | 실행 중 `jobActive`가 광범위한 상호작용을 막음             | 번역을 기다리는 동안 검수 불가                  | 백그라운드 큐와 페이지 단위 잠금              |
| UX-03   | P1       | 단순 뒤로/닫기와 실제 위험 동작의 색 의미가 섞임           | 위험 신호의 신뢰도 하락                         | neutral/warning/danger 역할 엄격 분리         |
| UX-04   | P1       | 카드·테두리·강조색 사용량이 많음                           | 정보 계층이 평평하고 피로감 증가                | 면·간격 우선, 테두리는 상태에 집중            |
| REV-01  | P1       | 텍스트 모아보기가 전문 검수 흐름으로 연결되지 않음         | 오류 찾기와 승인 반복이 느림                    | 캔버스 연동 CAT형 Review Table                |
| A11Y-01 | P1       | 아이콘 도구와 로컬 툴바의 키보드 규칙이 통일되지 않음      | 키보드/보조기술 접근성 저하                     | ARIA toolbar, roving tabindex, 공통 tooltip   |
| A11Y-02 | P1       | Primary 버튼의 현재 색 대비가 일반 텍스트 기준에 못 미침   | 버튼 레이블 가독성 저하                         | token 단위 대비 수정과 자동 검사              |
| VIS-01  | P1       | 하드코딩 색·z-index·로컬 상태 스타일이 많음                | 새 화면마다 다른 시각 언어                      | semantic tokens + layer scale                 |
| BUG-01  | P1       | 단축키 화면에 번역 key가 그대로 노출되는 locale 누락       | 제품 완성도와 이해도 저하                       | action ID 전체 locale coverage 검사           |
| ADV-01  | P2       | 작업공간 프리셋·레이아웃 초기화가 없음                     | 고급 작업 간 전환 비용                          | 번역/검수/인페인트 작업공간                   |
| ADV-02  | P2       | 히스토리·스냅샷이 사용자의 작업 모델로 보이지 않음         | 실험과 일괄 수정이 불안함                       | 명시적 체크포인트/버전 패널                   |

---

## 5. 정보 구조와 사용자 여정 감사

### 5.1 앱 셸: 편집기의 좋은 골격과 과도한 고정 폭

[`AppSessionView.tsx`](../src/renderer/src/app/session/AppSessionView.tsx#L68)는 `AppSidebar → AppWorkspace → AppRightQuickRail → AppRightRail`의 네 열을 항상 렌더링한다. [`shell-workspace.css`](../src/renderer/src/styles/shell-workspace.css#L1)의 열 폭은 `400px minmax(0, 1fr) 44px 340px`다.

이 구조의 장점은 탐색–캔버스–속성이라는 전문 편집기의 정신 모델이 이미 있다는 점이다. 문제는 가변성이 없다는 것이다. 최소 창 너비 1240px에서 양쪽 고정 영역 784px을 빼면 중앙에는 약 456px만 남고, 여기에 실제 캔버스 패딩·스크롤바·도구가 더 들어간다. 만화 페이지의 세로 종횡비를 생각하면 사용자가 가장 오래 보는 결과물이 가장 작은 영역을 받는다.

권장 변경:

- 좌측 탐색 패널: 기본 300~340px, 최소 240px, 드래그 리사이즈, 아이콘/얇은 레일로 접기
- 우측 Inspector: 기본 320~360px, 최소 280px, 선택이 없으면 자동으로 요약 폭 또는 접힌 상태
- 44px 빠른 레일: 상단 전역 바와 캔버스 도구막대로 분해한 뒤 제거 검토
- 패널 폭·접힘 상태는 프로젝트가 아닌 사용자 작업공간 설정으로 저장
- `레이아웃 초기화` 명령 제공
- 캔버스 최소 유효 폭을 보장하고 그보다 좁아지면 우측 패널을 먼저 접기

**삭제 판단:** `AppRightQuickRail` 파일을 즉시 삭제하라는 뜻은 아니다. 그 안의 Undo/Redo, 원본 비교, 블록 표시, 상태 도크를 각각 권위 있는 위치로 이관한 뒤 빈 컨테이너가 되었을 때 삭제해야 한다.

### 5.2 빈 상태: 한 화면에 같은 시작 행동이 두 번 나온다

[`AppSidebar.tsx`](../src/renderer/src/components/AppSidebar.tsx#L143)의 상단에는 다음 여섯 개 버튼이 2×3에 가까운 큰 면적으로 항상 보인다.

- 번역
- 작품 일괄 번역
- 설정
- 보관함 폴더
- 공유하기
- 가져오기

동시에 [`WorkspaceContent.tsx`](../src/renderer/src/components/WorkspaceContent.tsx#L141)의 빈 상태는 시작 번역, 일괄 번역, 공유본 가져오기와 설정 단계를 다시 보여준다. 오른쪽에는 선택된 챕터가 없다는 카드와 비활성 번역 동작이 남고, 그 아래는 대부분 비어 있다.

사용자는 첫 화면에서 “새 이미지를 가져오는 것”, “번역을 시작하는 것”, “일괄 번역하는 것”의 차이를 앱의 데이터 모델을 모른 채 결정해야 한다. 설정·폴더·공유도 같은 시각적 무게를 받아 Primary가 무엇인지 흐려진다.

권장 빈 상태:

```text
이미지, 폴더 또는 ZIP을 여기에 놓으세요
[가져오기]  최근 작업 열기

준비 상태
✓ 저장 폴더
✓ 번역 언어
! 번역 공급자 연결 필요  [설정]
```

- Primary는 `가져오기` 하나만 둔다.
- 파일을 고른 다음 작품/챕터 생성과 페이지 순서 미리보기를 제공한다.
- `번역 시작`은 대상 페이지가 생긴 뒤 활성화한다.
- `설정`은 준비 상태의 문제가 있을 때 해당 행의 해결 동작으로 제공한다.
- 공유 가져오기는 `가져오기`의 드롭다운/보조 선택지로 통합한다.
- 보관함 폴더 열기, 공유, 앱 설정은 상단 앱 메뉴나 오버플로로 이동한다.
- 챕터가 없을 때 오른쪽 작업 허브는 숨기고, 필요하면 최근 작업/도움말을 보여준다.

### 5.3 번역 실행: 명령이 아니라 범위를 통합해야 한다

현재 번역은 좌측 전역 번역, 작품 일괄 번역, 빈 상태 CTA, 우측 [`ChapterTaskHub`](../src/renderer/src/components/RunStatusPanels.tsx#L13), 페이지 재번역, 선택 영역 재번역 등 여러 진입점으로 존재한다. 각각의 기능은 필요하지만, 사용자가 보는 대표 명령이 여러 개일 필요는 없다.

권장 모델:

1. 전역 대표 명령은 `번역 실행` 하나다.
2. 현재 맥락으로 범위를 추천하되 버튼 이름이나 다음 화면에서 범위를 명시한다.
3. 범위는 공통 `TranslationScope` 모델로 관리한다.

```ts
type TranslationScope =
  | { kind: "current-page"; pageId: string }
  | { kind: "selected-pages"; pageIds: string[] }
  | { kind: "chapter"; chapterId: string; filter: "all" | "pending" | "failed" }
  | { kind: "work"; workId: string; filter: "all" | "pending" | "failed" }
  | { kind: "region"; pageId: string; rect: Rect };
```

UI 문구 예:

- `현재 페이지 번역`
- `선택한 12페이지 번역`
- `번역되지 않은 24페이지 번역`
- `선택 영역 다시 번역`
- `실패한 3페이지 재시도`

영역 재번역은 전역 버튼이 아니라 캔버스의 영역 선택 도구에 붙는 컨텍스트 액션으로 유지한다. 작품 전체 처리는 같은 실행 흐름의 범위일 뿐 별도 대표 기능으로 만들지 않는다.

실행 전 요약에는 다음을 반드시 보여준다.

- 대상 페이지·블록 수
- 기존 OCR/번역/수동 레이아웃 중 무엇을 유지하고 무엇을 바꾸는지
- 예상 시간·비용 또는 “로컬 실행, 비용 없음”
- 체크포인트 생성 여부
- 사용 모델/프리셋과 고급 설정 링크
- 실행 중 완료 페이지를 검수할 수 있는지

### 5.4 진행 상태: 페이지 상태와 전체 작업 상태를 분리한다

현재 대표 화면에서는 비슷한 진행 정보가 페이지 목록, 우측 작업 카드, 별도 상태 도크, 상태 행과 로그에 반복된다. 이는 정보가 많아서 생기는 문제가 아니라 **같은 질문에 여러 답변 표면이 존재하는 문제**다.

권위 있는 위치를 다음처럼 정한다.

| 질문                       | 한 곳의 대표 위치             | 표현                                              |
| -------------------------- | ----------------------------- | ------------------------------------------------- |
| 이 페이지 상태는?          | 좌측 페이지 행                | `대기`, `진행`, `검토 필요`, `완료`, `오류` 한 줄 |
| 전체 작업이 얼마나 남았나? | 상단 작업 큐 버튼 + 작업 센터 | 진행률, 완료/전체, ETA                            |
| 무엇이 실패했나?           | 작업 센터의 오류 탭           | 실패 페이지, 단계, 재시도                         |
| 지금 엔진이 무슨 단계인가? | 작업 센터의 선택 작업 상세    | 검출/OCR/번역/인페인트/식자                       |
| 개발 진단 로그는?          | 작업 센터의 접힌 상세 로그    | 복사/저장 가능, 기본 접힘                         |
| 저장되었나?                | 상단 문서 상태                | 저장 중/저장됨/저장 오류                          |

상태 모델은 자유 문자열 배열이 아니라 식별 가능한 구조여야 한다.

```ts
type PageWorkflowState =
  | "queued"
  | "running"
  | "needs-review"
  | "approved"
  | "failed"
  | "skipped";

type PipelineStage = "detect" | "ocr" | "translate" | "inpaint" | "typeset";
```

색만으로 상태를 구분하지 말고 아이콘과 텍스트를 함께 사용한다. 상태 갱신은 포커스를 빼앗지 않는 live region을 통해 알리되, 매 단계의 로그를 모두 읽어 주지 않는다.

### 5.5 실행 중 앱 잠금: 작업 단위 잠금으로 좁혀야 한다

현재 여러 컴포넌트가 `jobActive`를 기준으로 버튼이나 블록 포인터를 비활성화한다. 예를 들어 [`WorkspaceContent.tsx`](../src/renderer/src/components/WorkspaceContent.tsx#L33)는 작업 중 블록 포인터 상호작용을 막는다. 데이터 충돌 방지에는 합리적이지만, 장시간 번역에서 사용자가 완료된 다른 페이지까지 검수하지 못하면 데스크톱 도구의 이점이 사라진다.

권장:

- 전역 `jobActive` 대신 페이지/블록별 lock 또는 revision 기반 충돌 검사
- 번역 중인 페이지는 읽기 전용 또는 “작업 완료 후 편집” 안내
- 완료된 페이지는 즉시 열고 수정 가능
- 사용자가 편집한 페이지를 큐가 덮어쓰려 하면 자동 merge가 아니라 명시적 충돌 해결
- 실패·건너뜀 페이지만 선택 재시도
- 전체 앱을 막는 모달 진행 화면 대신 작업 센터 사용

### 5.6 오른쪽 Inspector: 하나의 전체 편집기와 하나의 빠른 부분집합

[`rightRailPanels.tsx`](../src/renderer/src/components/rightRailPanels.tsx#L72)는 상단에 `ChapterTaskHub`를 두고, 아래를 인페인트·블록 편집·블록 목록으로 전환한다. 방향은 좋지만 “작업 실행/진행”과 “선택 대상 속성”이 한 패널에 붙어 있다. 또한 선택 대상 근처/캔버스 도구와 우측 필드가 중복될 가능성이 높다.

권장 규칙:

- 우측 Inspector는 **선택 대상의 전체 속성**만 담당한다.
- 컨텍스트 바는 선택 대상의 가장 빈번한 3~5개 동작만 담당한다.
- 컨텍스트 바에서 바꾼 값은 같은 상태를 수정하며 Inspector와 즉시 동기화한다.
- 작업 큐/진행은 별도 작업 센터로 이동한다.

Inspector 상태:

| 선택/모드     | 우측 내용                                  |
| ------------- | ------------------------------------------ |
| 아무것도 없음 | 작품/챕터 요약, 다음 검수 항목             |
| 페이지        | 페이지 크기, 상태, 비교, 페이지 작업       |
| 단일 블록     | OCR 원문, 번역, 식자, 레이아웃, QA         |
| 다중 블록     | 공통 속성, 혼합값 표시, 정렬·분배          |
| 인페인트      | 마스크 더하기/빼기, 브러시, 미리보기, 적용 |
| 영역 선택     | 영역 OCR/재번역/텍스트 블록 만들기         |

### 5.7 페이지 목록: 행을 입력 필드처럼 보이게 하지 않는다

현재 [`PageList.tsx`](../src/renderer/src/components/PageList.tsx)와 관련 스타일은 많은 상태·액션을 좁은 행에 배치한다. 대표 화면에서는 파일명 영역이 입력 상자처럼 보여 평상시에도 이름을 편집할 수 있는지, 클릭하면 선택되는지 판단하기 어렵다.

권장 행:

```text
[썸네일]  012.png                         [⋯]
          검토 필요 · 번역 8/10
```

- 행 전체를 선택 표면으로 만들고 키보드 포커스를 제공한다.
- 이름 바꾸기는 더블클릭에만 숨기지 말고 오버플로 메뉴와 단축키로도 제공한다.
- 삭제·재번역 같은 보조 명령은 hover/focus/selected에서 드러낸다.
- 진행률은 작은 바를 매 행에 반복하기보다 짧은 상태와 수치로 표현한다.
- drag handle과 키보드 이동 대안을 함께 제공한다.
- 필터: 전체, 검토 필요, 실패, 미번역, 완료
- 검색 결과나 필터 상태에서도 현재 선택 페이지가 사라졌는지 명확히 안내한다.

### 5.8 번역 옵션: 엔진 설정이 아니라 결과와 영향으로 설명한다

현재 번역 모달의 페이지 썸네일 선택, 전체/미번역/초기화, 선택 수 표시는 유지할 만한 기반이다. 복잡성은 설정의 이름과 노출 순서에서 생긴다.

기본 단계에는 다음만 둔다.

- 원문 언어 / 번역 언어
- 품질 프리셋: 빠름 / 균형 / 품질
- 범위
- 기존 작업: 수동 수정 유지 / 번역만 갱신 / 전체 다시 분석
- 용어집·문맥 사용 여부

고급 설정에는 검출기, OCR, 번역 공급자, 인페인터, 임계값, 2차 번역을 둔다. 단, 고급 값을 바꿀 때도 내부 모듈명만 보여 주지 말고 예상 결과를 설명한다.

나쁜 예: `2차 번역 사용`

좋은 예: `번역을 한 번 더 교정해 자연스러움을 높임 · 예상 시간/비용 약 2배`

나쁜 예: `자동 분석 범위: all`

좋은 예: `기존 블록을 버리고 텍스트를 다시 찾음 · 수동 위치 조정이 바뀔 수 있음`

### 5.9 검수: “모아보기”를 캔버스와 연결된 작업 화면으로 승격한다

텍스트 모아보기는 편리한 부가 모달에 그치지 말고, 장편 작업의 대표 검수 화면이 되어야 한다. 별도의 복사본을 편집하면 Undo와 동기화가 깨지므로 캔버스와 같은 문서 상태를 사용해야 한다.

권장 열:

| 열   | 내용                                       |
| ---- | ------------------------------------------ |
| 위치 | 페이지 썸네일, 페이지 번호, 블록 번호      |
| 원문 | OCR 원문, 언어, 신뢰도                     |
| 번역 | 직접 편집 가능한 번역문                    |
| QA   | 넘침, 미번역, 폰트 대체, 마스크, 용어 충돌 |
| 상태 | 검토 필요/완료/보류                        |
| 메모 | 인물명·문맥·협업 메모                      |

상호작용:

- 행 선택 → 캔버스 해당 블록으로 이동·확대
- 캔버스 블록 선택 → 같은 행 강조
- `Enter` → 승인하고 다음 항목
- 단축키 → 다음 오류, 다음 미검토, 이전 항목
- 여러 행 선택 → 공통 스타일/상태 적용
- 원문·번역 검색/바꾸기, 정규식은 고급 옵션
- 현재 필터와 미검토 수를 항상 표시

### 5.10 내보내기: 마지막 버튼이 아니라 QA 게이트

내보내기 직전에 다음을 요약한다.

- 오류, 미검토, 번역문 넘침, 빈 번역, OCR 저신뢰 수
- 폰트 누락·자동 대체 수
- 페이지 순서·크기 이상
- 아직 실행 중인 작업
- 출력 형식별 포함 레이어와 메타데이터
- 출력 위치, 기존 파일 덮어쓰기 여부

경고가 있어도 사용자가 내보낼 수는 있어야 하지만, `경고 7개를 남기고 내보내기`처럼 선택의 결과를 버튼에 명시한다. 단순한 “정말 내보내시겠습니까?” 확인은 정보가 없으므로 피한다.

---

## 6. 컴포넌트 통합·삭제 상세안

### 6.1 원칙

컴포넌트를 다음 세 계층으로 나눈다.

1. **Primitive**: Button, IconButton, FieldShell, TextInput, Select, Checkbox, Dialog, Popover처럼 스타일·접근성 계약을 갖는 작은 단위
2. **Pattern**: ToolbarButton, MenuItem, ListRow, ScopePicker, PagePicker, ProgressCard처럼 앱 전반에서 반복되는 조합
3. **Feature**: TranslationOptions, BlockInspector, InpaintingPanel처럼 도메인 상태와 흐름을 소유하는 단위

통합 기준은 “마크업이 비슷함”이 아니라 다음 네 가지가 같을 때다.

- 사용자가 이해하는 역할
- 상태 모델
- 키보드·포커스 동작
- 시각적 계층과 오류 처리

반대로 같은 `<button>`을 쓰더라도 메뉴 항목과 Primary CTA는 하나의 고수준 컴포넌트로 합치면 안 된다.

### 6.2 액션 컴포넌트

| 현재                         | 판단            | 목표                              | 비고                                                                    |
| ---------------------------- | --------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `ui/Button`                  | Keep/확장       | Text action 표준                  | loading, leading/trailing icon, destructive confirmation 문구 계약 추가 |
| `ui/IconButton`              | Keep/확장       | Icon-only 표준                    | tooltip 연결, pressed 상태, badge 지원                                  |
| 여러 `.stage-toolbar-button` | 통합            | `ToolbarButton`                   | `aria-pressed`, shortcut, roving focus 포함                             |
| 로컬 chip/toggle 버튼        | 통합            | `ToggleButton`/`SegmentedControl` | 선택과 실행을 시각적으로 분리                                           |
| raw 메뉴 버튼                | 통합            | `MenuItem`                        | 역할, disabled reason, shortcut, destructive variant                    |
| 카드 전체 클릭 버튼          | 유지하되 표준화 | `SelectionSurface`                | CTA 버튼 스타일을 물려받지 않음                                         |

`Button`을 도입한 파일이 44개인데도 원시 `<button>`이 52개 파일에 남아 있다. 다음 파일군을 우선 분류한다.

- 단순 액션으로 `Button`/`IconButton` 이관 후보: 설정 패널, 공유 병합 카드, 폰트 관리자, Toast 닫기, 스타일 프리셋 편집
- `ToolbarButton`이 필요한 후보: `StageToolbar*`, `WorkspaceViewControls`, `ChapterQuickControls`, `OverlayTransformControls`, `BubbleLayoutContextBar`
- `MenuItem`이 필요한 후보: `LibrarySortMenu`, 자동 인페인트 메뉴, 폰트 선택, 툴바 flyout
- `ToggleButton`/`Tabs`가 필요한 후보: Settings 탭, 스타일 가이드 탭, 정렬/보기/도구 활성 상태

**삭제 후보:** 각 파일의 raw 버튼 마크업과 전용 hover/focus/disabled CSS. 단, 표준 컴포넌트로 이관하고 시각·키보드 회귀 테스트가 통과한 뒤 삭제한다.

### 6.3 필드 계열

현재 `TextField`는 레이블과 힌트를 감싸지만 select, number, textarea, color, checkbox의 동일한 계약이 없다. 다음 구조로 확장한다.

```text
FieldShell
  label + optional badge/unit
  control
  hint OR validation message

TextField / NumberField / SelectField / TextAreaField
CheckboxField / SwitchField
ColorField / SliderField
```

공통 계약:

- `label`, `description`, `error`, `required`, `disabledReason`
- `aria-describedby` 자동 연결
- 숫자의 `min/max/step/unit`, 범위를 벗어난 값 clamp 시점
- Enter/Esc commit·cancel 규칙
- mixed value 상태와 “다중 선택에 적용”
- 로딩·검증 중 상태

통합 우선 후보:

- `FontSizeNumberInput`, transform 숫자 필드, block spacing 필드
- 설정 모달의 수많은 raw input/select
- 에디터와 모아보기의 직접 서식 숫자/색상 필드
- 색상 swatch + hex 입력 + native color input 조합
- 범위 슬라이더와 옆 숫자 입력 조합

**삭제 후보:** 동일 높이·border·focus를 재정의하는 설정별 CSS, 단위 텍스트를 absolute position으로 붙인 로컬 래퍼, 서로 다른 clamp helper. 값 변환과 도메인 validation은 feature 계층에 남긴다.

### 6.4 페이지·작업 범위 선택기

번역, 재번역, 인페인트, 내보내기, 공유가 모두 “어떤 페이지에 적용할 것인가”를 묻는다. 화면별 별도 카드/체크박스/썸네일을 만들지 말고 다음 패턴을 공유한다.

```text
ScopePicker
  current / selected / pending / failed / all / custom

PagePicker
  filter + select all visible + thumbnail grid/list + selected count

ScopeSummary
  대상 n페이지 · 기존 수정 영향 · 예상 시간/비용
```

이 영역은 처음부터 새로 만들 필요가 없다. [`WorkPagePicker.tsx`](../src/renderer/src/components/WorkPagePicker.tsx#L187)가 공통 본체이고, [`ChapterPagePicker.tsx`](../src/renderer/src/components/ChapterPagePicker.tsx#L28)와 [`ExportPagePicker.tsx`](../src/renderer/src/components/ExportPagePicker.tsx#L62)가 adapter로 재사용하고 있으며, [`ChapterPickerTiles.tsx`](../src/renderer/src/components/ChapterPickerTiles.tsx#L105)는 공통 tile과 mixed checkbox를 제공한다. 이는 유지할 좋은 통합 사례다.

따라서 목표는 `WorkPagePicker`를 버리고 또 다른 범용 선택기를 만드는 것이 아니라 다음과 같다.

- 기존 picker의 공개 모델을 `ScopePicker + PagePicker + ScopeSummary` 역할로 명확히 함
- 재번역·인페인트·공유 등 아직 별도 선택 UI를 쓰는 흐름이 요구사항에 맞을 때 adapter로 편입
- 시각적 선택 기반은 `SelectionSurface/SelectionCard`와 정렬
- 각 reducer는 그대로 무리하게 합치지 않음. 번역의 `pending` canonicalization과 내보내기의 전체 선택 의미는 실제로 다르므로 feature adapter가 소유

주의할 점:

- “전체 선택”은 전체 데이터인지 현재 필터 결과인지 문구로 구분
- 선택 수뿐 아니라 제외된 이유와 잠긴 페이지 수 표시
- 목록 변경 뒤 존재하지 않는 선택 ID 정리
- 공통 범위 타입은 실제 의미가 같은 흐름에만 사용하고, `pending`·export eligibility 같은 도메인 규칙은 adapter에 유지

### 6.5 탭·세그먼트·단계

현재 탭, chip, 선택 버튼, 인페인트 단계, 설정 카테고리가 로컬 클래스와 버튼으로 표현된다. 다음을 분리한다.

- `Tabs`: 서로 다른 패널을 전환. `role=tablist/tab/tabpanel`, 방향키 이동
- `SegmentedControl`: 같은 값의 상호 배타적 선택. 짧은 레이블 2~5개
- `ToggleButton`: 독립 on/off. `aria-pressed`
- `StepIndicator`: 순서가 있는 작업 단계와 완료/현재/오류 상태
- `FilterChip`: 목록 필터. 해제 가능 여부와 결과 수 표시

`SettingsTabs`, 스타일 가이드 탭, 보기 모드, 정렬, 인페인트 단계가 각각 어느 의미인지 다시 분류한다. 모양이 비슷하다는 이유로 전부 `Tabs`로 만들지 않는다.

### 6.6 메뉴·팝오버·플라이아웃

현재 정렬 메뉴, 상태 팝오버, 자동 인페인트 메뉴, 툴바 flyout, 폰트 선택, 각종 context menu가 자체 open state, outside click, Esc, focus restore를 가질 가능성이 크다. 공통 계층을 만든다.

```text
FloatingLayer
  portal + layer token + placement/collision + dismiss + focus restore

Popover
  비차단 정보·짧은 폼

Menu
  menu/menuitem + roving focus + Home/End + typeahead

Tooltip
  짧은 이름/단축키, 키보드 포커스와 hover 모두 지원
```

통합 뒤 삭제할 것:

- 컴포넌트별 `document.addEventListener("mousedown", ...)`
- 서로 다른 outside-click 판정
- 임의 z-index
- 메뉴를 뷰포트 밖으로 보내는 absolute 위치 CSS
- `title`만 사용한 핵심 도구 설명

`ControlTooltip`은 표준 Tooltip의 출발점으로 삼되, 아이콘 버튼이 자동으로 label/shortcut을 전달할 수 있게 연결한다.

### 6.7 상태·진행·알림

현재 `RunJobFeedback`, `StatusPopover`, `InstallProgressOverlay`, 인페인트 진행 카드, 페이지 상태, toast가 서로 다른 상태 표현을 가진다. 화면을 하나로 합칠 필요는 없지만 같은 상태 모델과 시각 primitive를 써야 한다.

| Primitive/Pattern | 용도                                         |
| ----------------- | -------------------------------------------- |
| `StatusBadge`     | 행·카드 안의 짧은 상태                       |
| `ProgressBar`     | determinate 진행률, label/value 필수         |
| `ProgressSpinner` | 총량을 모를 때만 사용                        |
| `InlineMessage`   | 현재 폼/패널 안에서 해결할 문제              |
| `Toast`           | 작업을 막지 않는 짧은 결과, 자동 사라짐 제한 |
| `ProgressCard`    | 취소/재시도가 가능한 한 작업                 |
| `ActivityCenter`  | 여러 작업의 큐·기록·오류                     |
| `AlertDialog`     | 복구 불가능한 결과를 만드는 최종 확인만      |

상태 문자열과 색상은 공통 enum/mapping 한 곳에서 관리한다. “실패”를 화면마다 빨강·주황·회색으로 바꾸지 않는다.

### 6.8 리스트 행

보관함 작품/챕터, 페이지, 블록, 모아보기 페이지, 폰트 목록은 모두 다음 슬롯을 공유할 수 있다.

```text
ListRow
  leading: thumbnail/icon/drag handle
  primary: name/title
  secondary: metadata/status
  trailing: badge/actions/menu
  states: hover/focus/selected/disabled/dragging/error
```

하지만 `ListRow`가 도메인 동작을 소유해서는 안 된다. `PageRow`는 재번역·삭제, `FontRow`는 설치·제거 같은 feature action을 slot으로 제공한다. 이 구분을 지키면 “거대한 만능 ListItem”을 피할 수 있다.

### 6.9 서식·텍스트 편집

블록 Inspector, 모아보기 직접 서식, 기본 스타일 설정, 스타일 프리셋 편집은 같은 글자 크기·폰트·정렬·행간·자간·색상을 반복한다. UI만 복사하지 말고 속성 schema를 공유한다.

```ts
type TypographyFieldDescriptor = {
  key: TypographyKey;
  labelKey: string;
  control: "font" | "number" | "color" | "align" | "toggle";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  supportsMixed?: boolean;
};
```

- feature별로 허용하는 descriptor 집합을 선택
- 값·Undo·selection은 해당 feature가 소유
- 필드 렌더러, 단위, 범위, mixed state, 오류 표현만 공유
- 캔버스 빠른 바에는 descriptor의 일부만 노출

**삭제 후보:** `GatherTextDirectFormatPrimitives`와 편집기 필드가 단순히 같은 컨트롤을 복제한 부분. 다만 모아보기와 캔버스의 선택·commit 정책이 다르면 상태 hook은 분리해 둔다.

### 6.10 아이콘

Tabler 아이콘과 [`ui/icons.tsx`](../src/renderer/src/components/ui/icons.tsx)가 섞여 있다. 모두 하나의 라이브러리로 강제 교체하기보다 registry/adapter를 둔다.

- 의미 이름: `UndoIcon`, `TranslateIcon`, `MaskAddIcon`
- 표준 크기: 14/16/18/20
- stroke, optical alignment, filled 상태 규칙
- 같은 의미에 같은 아이콘
- 아이콘만으로 이해하기 어려운 전용 기능에는 라벨/tooltip
- 위험 아이콘은 색만으로 구분하지 않음

### 6.11 CSS와 토큰

현재 전역 [`foundations.css`](../src/renderer/src/styles/foundations.css#L171)는 `button/input/select/textarea`에 기본 모양을 직접 부여하고, 컴포넌트 CSS Module도 같은 요소를 다시 스타일한다. 전역 hover가 active 상태를 덮는 예외를 별도 selector로 복구하는 주석과 규칙도 존재한다. 이것은 새 컴포넌트가 늘수록 specificity 충돌을 만든다.

단계적 목표:

1. 전역 요소에는 box-sizing, font inheritance, 색 상속, native appearance reset 정도만 남김
2. 실제 모양은 primitive class가 소유
3. feature CSS는 배치와 도메인 시각화만 소유
4. 상태 색은 semantic token으로만 사용
5. z-index 숫자는 layer token으로 교체
6. 캔버스 overlay 색은 별도 namespace로 유지
7. component state를 `.active`, `.selected`, `.error` 이름만으로 전역 충돌시키지 않고 data attribute/CSS Module 사용

**하지 말 것:** 169개가 넘는 고유 색을 일괄 search-and-replace해 한 색으로 만드는 것. 인터페이스 색과 작업 캔버스의 의미 색을 먼저 분류해야 한다.

---

## 7. 삭제·통합 후보의 의사결정표

| 대상                             |    지금 삭제? | 선행 조건                                        | 최종 판단                           |
| -------------------------------- | ------------: | ------------------------------------------------ | ----------------------------------- |
| `AppRightQuickRail` 컨테이너     |        아니오 | 명령·상태를 상단/도구/작업 센터로 이관           | 비면 삭제                           |
| 좌측 6개 대형 Toolbar 버튼       |          일부 | 빈 상태·상단 메뉴·번역 범위 재설계               | 대표 CTA만 남기고 나머지 이관       |
| 중복 번역 CTA                    |            예 | `TranslationScope`와 단일 실행 진입점            | 로컬 진입 버튼 삭제/컨텍스트 액션화 |
| 원시 단순 버튼 CSS               |            예 | Button/IconButton 마이그레이션과 screenshot/test | 삭제                                |
| 툴바 raw 버튼                    | 바로는 아니오 | ToolbarButton + keyboard pattern                 | 로컬 마크업/CSS 삭제                |
| 모달별 backdrop/focus 코드       |    발견 시 예 | 공통 Modal 적용                                  | 삭제                                |
| 모달별 폭·body 레이아웃          |          일부 | modal recipe 정의                                | 예외만 유지                         |
| 페이지 선택기별 선택 집계        |            예 | ScopePicker/PagePicker 공통 모델                 | 삭제                                |
| 메뉴별 outside-click/Esc/z-index |            예 | FloatingLayer/Menu 도입                          | 삭제                                |
| 설정별 필드 chrome               |            예 | FieldShell 계열 도입                             | 삭제                                |
| 도메인 validation/state hook     |        아니오 | 없음                                             | feature에 유지                      |
| Canvas block/mask 색             |        아니오 | semantic canvas token으로 명명                   | 유지·토큰화                         |
| `SelectionSurface/Card`          |        아니오 | 선택기 표준에 채택                               | 확장/유지                           |
| `Modal`                          |        아니오 | 회귀 테스트 보강                                 | 표준으로 유지                       |
| `Button/IconButton`              |        아니오 | 역할별 pattern 추가                              | 표준으로 유지                       |
| 인페인트 3단계 모델              |        아니오 | 명칭·안전성 개선                                 | 재사용                              |

---

## 8. 목표 컴포넌트 카탈로그

최종적으로는 아래 정도의 공개 UI API면 충분하다. 목록을 늘리는 것이 목표가 아니라, 새 기능 작성자가 로컬 button/field/popover를 만들 이유를 없애는 것이 목표다.

```text
ui/
  Button, IconButton, ToolbarButton, ToggleButton
  FieldShell, TextField, NumberField, SelectField, TextAreaField
  CheckboxField, SwitchField, SliderField, ColorField
  Modal, AlertDialog, Popover, Menu, Tooltip
  Tabs, SegmentedControl, StepIndicator, FilterChip
  StatusBadge, ProgressBar, InlineMessage, Toast
  SelectionSurface, ListRow, EmptyState

patterns/
  AppTopBar
  NavigationTree
  PageRow
  InspectorSection
  ContextualToolbar
  ScopePicker
  PagePicker
  ScopeSummary
  ProgressCard
  ActivityCenter
  ReviewTable
  ExportPreflight
```

각 컴포넌트에는 Storybook 같은 별도 제품을 꼭 도입할 필요는 없지만, 저장소 QA 도구로 렌더링 가능한 상태 매트릭스를 둔다.

필수 상태:

- default / hover / focus-visible / pressed 또는 selected
- disabled + 이유
- loading
- error / warning / success가 해당되는 경우
- 긴 한국어·영어·일본어 레이블
- 200% 확대
- high contrast 또는 최소한 forced-colors 기본 동작
- compact/default density

---

## 9. 관련 제품·프로젝트 벤치마크

### 9.1 종합 결론

한 제품을 그대로 따라 하면 이 프로젝트의 두 사용자층 중 하나를 잃는다. 독자형 번역기는 시작은 쉽지만 정밀 식자·마스크 보정이 약하고, 전문가형 편집기는 강력하지만 처음부터 도구와 파라미터가 많다.

가장 적합한 조합은 다음이다.

- **진입:** Scan Translator, Google Translate, DeepL처럼 짧게
- **자동 처리:** Comic Translate처럼 완료된 페이지부터 검수 가능하게
- **정밀 보정:** manga-translator-ui, ImageTrans, Clip Studio처럼 텍스트·캔버스·페이지를 연결
- **앱 셸:** Photoshop, Figma, Photopea처럼 위치가 안정적인 탐색–캔버스–Inspector
- **AI 안전성:** Canva처럼 원본 보존과 자동 변경의 공개
- **작업 운영:** ComfyUI의 큐·히스토리·템플릿·사전 점검만 채택하고 노드 그래프는 숨김
- **패널 운용:** VS Code처럼 접기·크기 조절·복원·레이아웃 초기화

자동 모드와 수동 모드를 서로 끊어진 두 앱으로 만들지 말고, **자동 결과에서 QA가 의심한 부분만 정밀 편집으로 자연스럽게 이어지는 한 흐름**으로 설계해야 한다.

### 9.2 만화·이미지 번역 프로젝트

| 제품                                                                                                                     | 관찰한 강점                                                                                                        | 이 프로젝트에 적용                                              | 그대로 가져오면 안 되는 점                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [BallonsTranslator](https://github.com/dmMaze/BallonsTranslator/blob/dev/doc/README_KO.md)                               | 검출→OCR→제거→번역→식자의 완결 흐름, 텍스트·이미지 편집 모드, 페이지/블록 단축키, 용어집과 찾기/바꾸기             | 도구 모드와 반복 검수 단축키, 자동 후 수동 보정                 | 전문가 기능을 첫 화면에 모두 노출하는 밀도, 페이지 이동으로 Undo가 끊기는 제약 |
| [manga-image-translator](https://github.com/zyddnys/manga-image-translator/blob/main/README.md)                          | 폭넓은 검출·OCR·번역·인페인트·렌더링 파이프라인, 다양한 입출력                                                     | 엔진 능력의 기준, 고급 설정·CLI와 UI의 동일한 capability model  | 모듈명·임계값을 기본 UX로 사용                                                 |
| [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui/blob/main/README_EN.md)                              | 풍선 레이아웃, 의미 줄바꿈, 리치 텍스트, 프리셋, 마스크, 원본 비교, 다중 선택, 정렬, 전역 Undo, 배치 미리보기·백업 | 블록 Inspector, 다중 편집, 영향 미리보기, 원본 비교, 체크포인트 | 모든 고급 속성을 동시에 펼쳐 두는 밀도                                         |
| [Comic Translate](https://github.com/ogkalu2/comic-translate)                                                            | Auto/Manual 연결, 완료된 페이지부터 보기, 실패 영역 수동 보정                                                      | 백그라운드 처리와 완료 페이지 즉시 검수                         | Auto와 Manual을 데이터가 분리된 별도 모드로 만드는 것                          |
| [Scan Translator](https://scan-translator.com/manga-translator-extension)                                                | 낮은 진입 비용, 자동 처리 중 놓친 영역만 다시 번역, 긴 이미지, 원본/결과 비교                                      | 단일 시작 CTA, 영역 재번역, 긴 웹툰 연속 보기, 비용/실패 투명성 | 독자용 단순 결과 화면으로 전문 보정을 제한                                     |
| [ImageTrans](https://www.basiccat.org/imagetrans/) / [BasicCAT](https://docs.basiccat.org/en/latest/gettingstarted.html) | 여러 MT 후보, TM·용어집·문맥, 승인 후 다음 세그먼트, 프로젝트 진행률                                               | 캔버스 연동 Review Table, 다음 오류/승인 단축키, 용어 충돌 QA   | CAT 표와 캔버스를 서로 다른 문서로 분리                                        |
| [Clip Studio Story Editor](https://help.clip-studio.com/en-us/manual_en/570_pages/Use_Story_Editor.htm)                  | 페이지별 텍스트 목록, 분할·병합·이동, 다중 스타일, 찾기/바꾸기, 캔버스 연동                                        | 장편 텍스트 검수와 일괄 편집                                    | Story Editor 진입으로 히스토리가 사라지는 제약                                 |
| [Koharu](https://github.com/mayocream/koharu)                                                                            | 로컬 실행, 여러 장치 backend, PSD 출력                                                                             | 장치 capability·성능·메모리·모델 설치 사전 점검                 | 하드웨어/backend 이름을 메인 화면의 선택 부담으로 노출                         |

#### 특히 직접 적용할 세 가지

1. **영역 재번역을 정식 보정 도구로 만든다.** Scan Translator와 DeepL의 짧은 영역 선택 흐름처럼, 영역 선택 → OCR/번역 → 결과 블록 자동 선택 → 필요 시 속성 보정으로 이어지게 한다.
2. **완료 페이지를 잠그지 않는다.** Comic Translate처럼 전체 큐가 끝나기 전에 결과를 검수할 수 있어야 한다.
3. **검수 행과 캔버스를 양방향 연결한다.** ImageTrans/BasicCAT와 Clip Studio의 장편 텍스트 관리 능력을 현재 모아보기에 결합한다.

### 9.3 일반 번역·캡처 제품

[Google Translate의 이미지 번역](https://support.google.com/translate/answer/6142483?co=GENIE.Platform%3DDesktop&hl=en)은 업로드 뒤 원본 표시, 결과와 나란히 보기, 텍스트 복사, 번역 이미지 다운로드를 결과 가까이에 둔다. 이 프로젝트도 원본 비교를 숨은 보조 기능이 아니라 검수의 기본 동작으로 두어야 한다. 좁은 캔버스에서는 두 이미지를 반씩 줄이기보다 toggle/press-and-hold/overlay slider로 자동 전환한다.

[DeepL의 화면 캡처 번역](https://support.deepl.com/hc/en-us/articles/4407878482962-Use-the-screen-capturing-feature)은 캡처 명령 → 십자 포인터 → 영역 선택 → OCR/번역이라는 짧은 흐름과 일관된 `Esc` 취소를 제공한다. 이 프로젝트의 영역 번역·마스크 선택·블록 만들기도 같은 선택 언어를 공유해야 한다.

적용 원칙:

- 영역 도구를 활성화하면 커서, 툴바 active, 짧은 안내가 동시에 바뀜
- `Esc`는 진행 중인 영역 선택을 먼저 취소하고, 다시 누를 때 도구를 빠져나감
- 실행 뒤 새/수정된 블록을 자동 선택하고 Inspector를 열어 결과를 바로 보정
- 작은 글자·장식 글자·저해상도에서 정확도가 낮을 수 있음을 페이지/블록 QA로 남김
- 서버에 이미지를 보내는 단계가 있다면 선택한 영역/페이지와 처리 위치를 실행 전에 알림

### 9.4 전문 이미지 편집기

[Photoshop의 Contextual Task Bar](https://helpx.adobe.com/photoshop/desktop/get-started/learn-the-basics/boost-workflows-with-the-contextual-task-bar.html)는 선택한 대상에 따라 자주 쓰는 다음 동작을 가까이에 보여 준다. [Photoshop 작업공간](https://helpx.adobe.com/photoshop/desktop/get-started/learn-the-basics/workspace-overview.html)은 도구, 문서, 패널의 위치가 안정적이다. 가져올 핵심은 “선택 근처의 빠른 부분집합”과 “우측의 전체 Inspector”를 구분하는 것이다.

[Photopea의 작업공간](https://www.photopea.com/learn/index.php?page=workspace)은 한 번에 하나의 도구가 활성화되고, 관련 도구를 그룹화하며, 이름·단축키를 tooltip으로 설명한다. 작은 세로 도구막대에 아이콘만 나열하는 현재 방식은 이 원칙을 따라 active 상태, 라벨, 단축키, focus를 통일할 수 있다.

[Figma의 Properties panel](https://help.figma.com/hc/en-us/articles/360039832014-Design-Prototype-and-view-Code-in-the-Properties-Panel)은 선택 대상과 다중 선택에 따라 표시할 속성을 좁힌다. 이 프로젝트도 블록 여러 개를 선택했을 때 모든 필드를 복제하는 대신 공통 값과 mixed value를 보여 주고, 정렬·분배·공통 서식을 제공해야 한다.

[Canva의 페이지 번역](https://www.canva.com/es_es/funciones/traducir/)과 이미지 편집 패턴에서 가져올 핵심은 비파괴 기본값이다. 번역문이 길어 자동 축소되거나 지원 글꼴로 대체됐다면 조용히 끝내지 말고 `자동 조정됨` 배지와 변경 내역을 남긴다. 재번역·일괄 스타일·자동 식자도 원본/체크포인트를 보존하는 선택이 기본이어야 한다.

### 9.5 생산성 앱과 디자인 시스템

[ComfyUI 인터페이스](https://docs.comfy.org/interface/overview)의 큐·히스토리와 [템플릿](https://docs.comfy.org/interface/features/template), 누락 의존성 확인은 모델이 많은 로컬 AI 앱에 잘 맞는다. 번역 파이프라인의 내부 단계는 작업 상세에서 볼 수 있게 하되, 사용자가 검출기→OCR→번역기→인페인터를 노드로 직접 연결해야 하는 기본 UI는 만들지 않는다.

[VS Code 레이아웃](https://code.visualstudio.com/docs/configure/custom-layout)은 좌우 사이드바와 하단 패널을 접고, 위치를 복원하고, 초기화할 수 있다. 현재의 고정 400/44/340px 셸을 개선할 직접적인 참고다. 다만 초기 버전부터 무제한 패널 이동을 제공하지 말고, 하나의 권장 레이아웃과 접기·리사이즈·초기화만 제공한다.

[Windows Command Bar 지침](https://learn.microsoft.com/en-us/windows/apps/design/controls/command-bar)은 가장 중요한 명령을 앞에 두고 공간이 부족하면 덜 중요한 항목을 overflow로 보낼 것을 권한다. 설정·폴더·공유·가져오기를 항상 같은 크기로 노출하는 현재 좌측 Toolbar를 정리할 근거다.

[Spectrum Button](https://spectrum.adobe.com/page/button/), [Tooltip](https://spectrum.adobe.com/page/tooltip/), [Toast](https://spectrum.adobe.com/page/toast/), [Progress bar](https://spectrum.adobe.com/page/progress-bar/)의 역할 분리는 “모양을 통일한다”보다 “같은 상황에는 같은 피드백 종류를 쓴다”는 원칙을 제공한다. [Spectrum의 오류 문구 지침](https://spectrum.adobe.com/page/writing-for-errors/)처럼 오류는 무엇이 일어났고 사용자가 무엇을 할 수 있는지 가까이에서 설명해야 한다.

---

## 10. 목표 사용자 흐름

### 10.1 첫 작업 만들기

1. 빈 화면에 이미지/폴더/ZIP을 drop하거나 `가져오기`를 누른다.
2. 작품명, 챕터명, 페이지 순서, 중복/지원 불가 파일을 미리 본다.
3. 언어와 `빠름/균형/품질`을 확인한다. 준비되지 않은 공급자/모델만 inline setup으로 해결한다.
4. `번역되지 않은 24페이지 번역`을 누른다.
5. 실행 전 요약에서 예상 시간·비용, 기존 작업 영향, 체크포인트를 확인한다.
6. 큐는 백그라운드에서 진행되고 첫 완료 페이지가 자동으로 열린다.

이 흐름에서 신규 사용자가 해야 할 주요 결정은 가져올 대상, 언어/품질, 실행 범위 세 묶음이어야 한다.

### 10.2 반복 검수

1. 작업 센터 또는 좌측 필터에서 `검토 필요`를 선택한다.
2. 가장 심각한 QA가 있는 첫 블록으로 이동한다.
3. 원본/결과 비교, 원문, 번역문, 경계를 같은 맥락에서 확인한다.
4. 수정하고 `Enter`로 승인한다.
5. 다음 문제로 자동 이동한다.
6. 필요하면 영역을 그어 OCR/번역/인페인트 중 해당 단계만 다시 실행한다.

검수 우선순위 후보:

- 번역문 넘침 또는 풍선 밖 충돌
- OCR 신뢰도 낮음
- 원문은 있는데 번역이 비어 있음
- 원문과 번역이 동일함
- 지원되지 않는 폰트로 대체
- 마스크가 글자 외부를 과도하게 침범
- 용어집 충돌/인물명 불일치
- 사용자가 표시한 보류/메모

### 10.3 인페인트 보정

1. 자동 검출 결과를 반투명 오버레이로 본다.
2. 브러시를 `더하기/빼기`로 바꾸거나 modifier key로 임시 전환한다.
3. 원본 길게 보기 또는 비교 slider로 손상 여부를 확인한다.
4. `미리보기`에서 결과를 계산한다.
5. `현재 페이지에 적용` 또는 `선택한 n페이지에 적용`을 누른다.
6. 결과는 프로젝트 Undo 스택과 체크포인트에 기록된다.

### 10.4 내보내기

1. 상단의 `내보내기`를 누른다.
2. preflight가 미검토·오류·넘침·폰트·페이지 순서 문제를 요약한다.
3. 문제 행을 누르면 해당 페이지/블록으로 이동한다.
4. 깨끗하면 형식과 위치를 확인하고 내보낸다.
5. 경고를 남길 경우 버튼 문구가 남은 수를 명시한다.

---

## 11. 접근성·입력 방식 기준

### 11.1 포인터 목표와 밀도

[WCAG 2.2 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)은 포인터 목표가 최소 24×24 CSS px이거나 충분한 간격을 갖도록 요구한다. 현재 40~42px 툴바 버튼은 좋은 방향이다. 반대로 작은 아이콘, 행 안의 촘촘한 삭제/재번역, 색상 swatch는 실제 hit area가 24px 이상인지 상태 매트릭스에서 확인한다.

권장:

- 전역/캔버스 도구 목표 36~40px, compact에서도 28~32px
- 작은 아이콘 자체가 14px여도 버튼 hit area는 줄이지 않음
- 위험 동작을 행 끝에 다른 빈번한 동작과 붙이지 않음
- drag handle이 유일한 재정렬 방법이 되지 않음

### 11.2 대비와 비색상 단서

[WCAG 2.2](https://www.w3.org/TR/WCAG22/) 기준으로 일반 텍스트는 4.5:1, UI 경계·상태 같은 비텍스트 요소는 3:1을 목표로 한다.

- disabled 상태는 단순 opacity만 낮춰 읽을 수 없게 만들지 않는다.
- running/warning/error/success에 텍스트와 아이콘을 함께 쓴다.
- 캔버스 overlay는 원본 이미지 색상과 충돌할 수 있으므로 색 + 선 형태/패턴/핸들을 조합한다.
- focus ring은 accent selection border와 다른 두께/offset을 사용한다.
- 고대비/forced-colors에서는 배경색이 사라져도 선택과 포커스가 보이게 한다.

### 11.3 키보드

[WAI-ARIA Toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/)에 따라 툴바는 Tab 한 번으로 진입하고 방향키로 내부 항목을 이동하도록 한다. 현재처럼 아이콘 버튼이 많은 앱에서 모든 버튼을 각각 Tab stop으로 두면 본문까지 가는 데 지나치게 오래 걸린다.

권장 기본 키:

| 행동                                 | 키                                 |
| ------------------------------------ | ---------------------------------- |
| 도구 취소/영역 선택 취소/팝오버 닫기 | `Esc` 단계적 처리                  |
| 페이지 이동                          | `←` / `→` 또는 기존 충돌 없는 조합 |
| 다음/이전 블록                       | 앱 단축키 표준으로 고정            |
| 승인 후 다음                         | `Enter`                            |
| 다음 문제                            | 별도 단축키, 도움말·메뉴에 표시    |
| 임시 Hand                            | `Space`                            |
| Undo/Redo                            | 플랫폼 표준                        |
| 명령 검색                            | 기존 Command Palette 유지          |

단축키는 tooltip, 메뉴 항목, 명령 팔레트, 도움말에서 같은 표기를 사용한다.

### 11.4 포커스와 상태 알림

- 모달을 닫으면 트리거로 포커스 복귀: 현재 `Modal`의 좋은 동작 유지
- 페이지 행 삭제 뒤 인접 행으로 포커스 이동
- 필터로 선택 행이 사라지면 목록 제목/결과 요약에 포커스 또는 안내
- toast가 포커스를 빼앗지 않음
- 긴 작업의 시작·완료·오류만 적절한 live region으로 알림
- 진행률의 모든 1% 변경을 읽지 않음
- 팝오버가 선택 블록이나 고정 바에 가려 포커스가 보이지 않는 상황 방지

### 11.5 문구

- 내부 명사보다 사용자 결과: `OCR 초기화`보다 `텍스트 위치를 다시 찾기`
- 범위를 동사에 포함: `재번역`보다 `현재 페이지 다시 번역`
- disabled만 하지 말고 이유: `번역 중에는 이 페이지를 편집할 수 없습니다 · 완료된 페이지로 이동`
- 위험은 결과와 복구 가능성을 함께 설명
- 버튼은 가능하면 “확인”보다 `12페이지 번역`, `변경 적용`, `경고 3개를 남기고 내보내기`

---

## 12. 디자인 토큰 제안

기존 토큰을 폐기하지 않고 다음 계층으로 정리한다.

```css
/* raw palette: UI가 직접 사용하지 않음 */
--gray-950: ...;
--orange-500: ...;

/* semantic surfaces */
--surface-app: ...;
--surface-panel: ...;
--surface-raised: ...;
--surface-sunken: ...;
--surface-overlay: ...;

/* content */
--text-primary: ...;
--text-secondary: ...;
--text-disabled: ...;
--icon-primary: ...;

/* interaction */
--action-primary-bg: ...;
--action-primary-fg: ...;
--selection-bg: ...;
--selection-border: ...;
--focus-ring: ...;

/* status */
--status-running: ...;
--status-review: ...;
--status-success: ...;
--status-warning: ...;
--status-danger: ...;

/* canvas annotation: UI status와 별도 */
--canvas-block-stroke: ...;
--canvas-selection-stroke: ...;
--canvas-mask-add: ...;
--canvas-mask-remove: ...;
--canvas-guide: ...;
```

간격은 기존 `--sp-1`~`--sp-6`을 유지하되 이름과 사용 규칙을 문서화한다.

- 컨트롤 내부: 4/6/8px
- 같은 필드 안: 4/6px
- 같은 섹션 안: 8/10/12px
- 섹션 사이: 16/24px
- 패널 바깥 padding: compact 10/12px, default 16px

모든 것을 카드로 감싸지 않는다.

- 같은 배경 안의 관련 필드: 제목 + 간격
- 다른 상태/독립 개체: 면 차이 또는 얇은 구분선
- 상호작용 가능한 선택 항목: hover/focus/selected surface
- 오류·선택·입력 경계: 명시적 border

---

## 13. 구현 단위 전수 감사

### 13.1 코드베이스 지도

| 항목                      |                                         감사 결과 | 의미                                                                                 |
| ------------------------- | ------------------------------------------------: | ------------------------------------------------------------------------------------ |
| `components` 아래 TSX     |                                               148 | feature UI가 많은 편이다.                                                            |
| `components/ui` primitive |                                                 9 | 반복 역할을 감당하기에는 기반 API가 아직 작다.                                       |
| CSS Module 사용 TSX       |                                                10 | 대부분 전역 class 이름과 DOM 구조에 결합되어 있다.                                   |
| 전역 CSS entry            | [`styles.css`](../src/renderer/src/styles.css#L1) | 기능별 CSS 13개를 전역 import한다.                                                   |
| CSS `px` occurrence       |                                             1,631 | geometry도 포함하므로 모두 토큰화 대상은 아니지만 interface literal 분류가 필요하다. |
| hex occurrence            |                                               316 | canvas annotation과 UI 색 분리가 필요하다.                                           |
| rgb/rgba occurrence       |                                               147 | overlay/alpha 색도 의미 토큰 후보가 많다.                                            |

큰 CSS 파일은 `gather-selection.css` 1,171줄, `panels.css` 1,125줄, `settings.css` 1,080줄, `modals-share.css` 1,060줄, `stage-overlay.css` 883줄, `formatting.css` 882줄, `library-inpainting.css` 833줄, `page-review.css` 814줄이다. 파일이 크다는 사실만으로 분리할 필요는 없지만, 실제로 settings가 gather DOM class를 참조하고 share class가 여러 파일에 흩어져 있어 feature 경계가 깨져 있다.

큰 TSX도 역할 분리를 검토해야 한다.

| 파일                                     | 감사 시점 줄 수 | 주된 위험                                                      |
| ---------------------------------------- | --------------: | -------------------------------------------------------------- |
| `StageToolbar.tsx`                       |             414 | 도구 렌더링과 hover flyout/controller 결합                     |
| `GatherTextDirectTypographyControls.tsx` |             404 | 작은 field·stepper·toggle이 한 feature 안에서 재구현           |
| `EditorPanel.tsx`                        |             398 | selection/format/section orchestration 비대화                  |
| `GemmaSettingsFields.tsx`                |             396 | settings field chrome 반복                                     |
| `PresetManagerScreen.tsx`                |             394 | 목록·편집·action 상태 혼합                                     |
| `WorkPagePicker.tsx`                     |             392 | 크지만 공통 본체 역할이 있으므로 단순 분해보다 API 보호가 우선 |
| `FormatDefaultsPanel.tsx`                |             392 | Gather typography와 중복                                       |
| `TranslationOptionsModal.tsx`            |             390 | modal orchestration과 옵션 surface 혼합                        |
| `EditorFormatControls.tsx`               |             389 | 공통 typography descriptor 후보                                |
| `LibraryTree.tsx`                        |             379 | tree interaction과 row action 결합                             |
| `PageList.tsx`                           |             377 | drag, selection, status, row action 결합                       |
| `ImportModal.tsx`                        |             377 | import workflow를 단계/pattern으로 분리할 후보                 |

줄 수 기준으로 무작정 쪼개지 말고, **controller/state, accessible primitive, domain rendering** 사이 경계를 기준으로 분리한다.

### 13.2 P0: 팝업·메뉴·리스트박스 controller의 반복

최소 다음 구현이 `open state + trigger/content ref + outside pointerdown + Escape + focus + keyboard`를 각자 가진다.

| 표면                    | 근거                                                                                                                                                                  | 특수 요구                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Library sort menu       | [`LibrarySortMenu.tsx`](../src/renderer/src/components/LibrarySortMenu.tsx#L25), [keyboard](../src/renderer/src/components/LibrarySortMenu.tsx#L66)                   | 정렬 option, shortcut 가능          |
| Font listbox            | [`FontSelect.tsx`](../src/renderer/src/components/FontSelect.tsx#L55), [`fontSelectModel.ts`](../src/renderer/src/components/fontSelectModel.ts#L52)                  | 검색/listbox + 즐겨찾기/삭제 action |
| Block preset picker     | [`BlockStylePresetControls.tsx`](../src/renderer/src/components/BlockStylePresetControls.tsx#L26)                                                                     | preset preview/action               |
| Editor overflow         | [`EditorPanelChrome.tsx`](../src/renderer/src/components/EditorPanelChrome.tsx#L19)                                                                                   | panel commands                      |
| Auto-inpaint split menu | [`RunStatusPanels.tsx`](../src/renderer/src/components/RunStatusPanels.tsx#L137)                                                                                      | primary + 범위 submenu              |
| Status popover          | [`StatusDockButton.tsx`](../src/renderer/src/components/StatusDockButton.tsx#L8), [`StatusPopover.tsx`](../src/renderer/src/components/StatusPopover.tsx#L22)         | 비차단 activity detail              |
| Stage toolbar flyout    | [`StageToolbar.tsx`](../src/renderer/src/components/StageToolbar.tsx#L246), [`useStageToolbarFlyout.ts`](../src/renderer/src/components/useStageToolbarFlyout.ts#L26) | pointer hover delay, 도구 선택      |

일관성 문제:

- Arrow wrap/clamp, Home/End, Tab 처리 방식이 다름
- Library sort는 Tab을 막고 닫는 별도 정책을 가짐
- FontSelect는 `div role=option`과 독자적인 focus/active descendant 모델을 사용
- StatusPopover는 `role=dialog`지만 Modal과 같은 초기 focus/trap이 없음. 비차단 popover라 trap이 없어야 할 수도 있으므로 역할부터 재판정해야 함
- outside click, scroll, focus restore, z-index가 표면별로 달라질 수 있음

권장 API:

```tsx
usePopupController({
  open,
  onOpenChange,
  triggerRef,
  contentRef,
  closeOnOutside: true,
  closeOnEscape: true,
  restoreFocus: true,
});

<Menu><MenuTrigger /><MenuContent><MenuItem /></MenuContent></Menu>
<Listbox value={value} options={options} renderOption={renderOption} />
<Popover modal={false}>...</Popover>
```

중요: `Menu`, `Listbox`, `Popover`의 ARIA 의미와 내부 키보드 모델을 하나로 합치지 않는다. 공유할 것은 portal/placement/dismiss/focus restore/controller 층이다. `FontSelect`의 즐겨찾기·삭제와 `StageToolbar`의 hover-delay는 feature/domain layer에 유지한다.

### 13.3 P0: Tabs, segmented, toggle의 의미 혼용

| 구현                                                                                                 | 현재 상태                                                    | 조치                                                |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| [`SettingsTabs.tsx`](../src/renderer/src/components/settingsModal/SettingsTabs.tsx#L10)              | `tablist/tab`은 있으나 roving tabindex와 Arrow/Home/End 없음 | 공통 `Tabs`로 이관                                  |
| [`StyleGuideChrome.tsx`](../src/renderer/src/components/styleGuide/StyleGuideChrome.tsx#L182)        | 같은 접근성 누락                                             | 공통 `Tabs`로 이관                                  |
| [`EditorPanelChrome.tsx`](../src/renderer/src/components/EditorPanelChrome.tsx#L118)                 | 비교적 완전한 keyboard/roving 구현                           | 공통 Tabs 동작의 기준으로 추출                      |
| [`GatherTextControls.tsx`](../src/renderer/src/components/gatherText/GatherTextControls.tsx#L59)     | wrapper는 `tablist`, 자식은 `aria-pressed`                   | 실제 역할이 값 선택이면 radiogroup/segmented로 수정 |
| [`TranslationOptionControls.tsx`](../src/renderer/src/components/TranslationOptionControls.tsx#L121) | 값 선택 버튼                                                 | `SegmentedControl` 후보                             |
| [`TransformEditorGroup.tsx`](../src/renderer/src/components/TransformEditorGroup.tsx#L91)            | 도구/모드 선택                                               | toolbar 또는 radiogroup 의미 재판정                 |

스타일도 Settings active [`settings.css`](../src/renderer/src/styles/settings.css#L55)와 Style Guide active [`style-guide.css`](../src/renderer/src/styles/style-guide.css#L80)가 사실상 같은 블록이다. Editor tab과 transform mode도 비슷한 컨테이너를 별도로 가진다.

판정 규칙:

- 패널 전환만 `Tabs`
- 하나의 값 선택은 `radiogroup` 기반 `SegmentedControl`
- 서로 독립적인 켜기/끄기는 `ToggleButton/ToggleGroup`
- 캔버스 도구는 `toolbar` + 한 도구 active 정책

### 13.4 P0/P1: Gather 직접 서식과 기본 서식 설정의 구조적 복제

Gather 쪽:

- 전체 [`GatherTextDirectTypographyControls.tsx`](../src/renderer/src/components/gatherText/GatherTextDirectTypographyControls.tsx#L41)
- font picker [L85](../src/renderer/src/components/gatherText/GatherTextDirectTypographyControls.tsx#L85)
- size stepper [L150](../src/renderer/src/components/gatherText/GatherTextDirectTypographyControls.tsx#L150)
- auto-fit [L207](../src/renderer/src/components/gatherText/GatherTextDirectTypographyControls.tsx#L207)
- style toolbar [L275](../src/renderer/src/components/gatherText/GatherTextDirectTypographyControls.tsx#L275)
- color swatch [`GatherTextDirectDetailControls.tsx`](../src/renderer/src/components/gatherText/GatherTextDirectDetailControls.tsx#L198)
- slider [`GatherTextDirectFormatPrimitives.tsx`](../src/renderer/src/components/gatherText/GatherTextDirectFormatPrimitives.tsx#L56)

Settings 쪽:

- 전체 [`FormatDefaultsPanel.tsx`](../src/renderer/src/components/settingsModal/FormatDefaultsPanel.tsx#L59)
- font picker [L156](../src/renderer/src/components/settingsModal/FormatDefaultsPanel.tsx#L156)
- size [L202](../src/renderer/src/components/settingsModal/FormatDefaultsPanel.tsx#L202)
- auto-fit [L244](../src/renderer/src/components/settingsModal/FormatDefaultsPanel.tsx#L244)
- style toolbar [L272](../src/renderer/src/components/settingsModal/FormatDefaultsPanel.tsx#L272)
- color [`FormatDefaultsDetailSections.tsx`](../src/renderer/src/components/settingsModal/FormatDefaultsDetailSections.tsx#L66)
- slider [L122](../src/renderer/src/components/settingsModal/FormatDefaultsDetailSections.tsx#L122)

현재 Settings가 Gather feature 폴더의 primitive/preview를 import해 dependency 방향도 뒤집혀 있다. 안전한 통합 순서:

1. font size, line height, letter spacing, width scale의 min/max/step metadata 추출
2. `NumberStepper`, `ColorInput`, `LabeledSlider`, `ToggleButton/Group` 같은 작은 primitive 추출
3. mixed/dirty state 계약 정리
4. `BlockTypographyControls`를 만들되 feature별 capability를 adapter로 전달
5. Gather와 Settings의 state/commit/Undo adapter는 별도 유지

한 번에 400줄짜리 두 파일을 하나의 700줄 “만능 서식 컴포넌트”로 합치는 것은 실패 패턴이다.

### 13.5 P1: Form primitive의 낮은 실제 채택

Settings 폴더에만 label 31, input 23, select 9, textarea 3개가 있으나 현재 `TextField` 사용은 없다. 대표 예로 [`StylePresetEditorModal.tsx`](../src/renderer/src/components/StylePresetEditorModal.tsx#L86)는 공통 Modal 안에서 raw button과 `.style-preset-action`을 다시 만들고, [L120](../src/renderer/src/components/StylePresetEditorModal.tsx#L120)부터 raw label/input을 사용한다.

[`page-review.css`](../src/renderer/src/styles/page-review.css#L34)의 `.style-preset-action.small`은 이미 있는 `Button size="sm"`과 역할이 겹친다. [`foundations.css`](../src/renderer/src/styles/foundations.css#L365)의 전역 `.primary/.danger`도 실제 소수 사용처 때문에 전역으로 남아 있다.

추가할 API:

```tsx
<SelectField label description error />
<TextAreaField label description error />
<CheckboxField checked indeterminate />
<Switch checked mixed />
<NumberField commitMode="change" | "blur" />
<FormSection title description />
```

이관 후 `.style-preset-action`, 전역 `.primary/.danger`, 설정별 control chrome을 삭제한다.

### 13.6 P1: 같은 숫자 입력의 commit 정책이 다름

- [`FontSizeNumberInput.tsx`](../src/renderer/src/components/FontSizeNumberInput.tsx#L3): 입력 즉시 유효값 반영, blur에서 invalid reset, Enter blur
- [`TransformNumberField.tsx`](../src/renderer/src/components/TransformNumberField.tsx#L3): draft 유지, blur/Enter clamp+commit, Escape restore
- Gather size stepper: [`GatherTextDirectTypographyControls.tsx`](../src/renderer/src/components/gatherText/GatherTextDirectTypographyControls.tsx#L150)
- Settings size stepper: [`FormatDefaultsPanel.tsx`](../src/renderer/src/components/settingsModal/FormatDefaultsPanel.tsx#L202)
- API 숫자 필드: [`ApiSettingsFields.tsx`](../src/renderer/src/components/settingsModal/ApiSettingsFields.tsx#L64)

사용자에게 같은 모양이라면 Enter, Escape, clamp, preview 시점도 예측 가능해야 한다.

```tsx
<NumberField
  value={value}
  min={min}
  max={max}
  step={step}
  precision={1}
  commitMode="blur"
  mixed={mixed}
  unit="px"
/>
```

실시간 캔버스 preview가 필요한 곳만 `commitMode="change"`를 명시하고, commit 한 번당 Undo entry가 몇 개 생기는지도 계약에 포함한다.

### 13.7 P1: Checkbox, Switch, Toggle의 시각·의미 중복

확인된 구현군:

- `.inline-toggle`: [`formatting.css`](../src/renderer/src/styles/formatting.css#L505), Editor/Gather/Characters/Glossary/Inpainting settings
- `.guide-hide-check`: [`InpaintingGuideModal.tsx`](../src/renderer/src/components/InpaintingGuideModal.tsx#L24), [`modals-share.css`](../src/renderer/src/styles/modals-share.css#L476)
- `.style-preset-pin-toggle`: StylePreset/PresetDefinition, [`page-review.css`](../src/renderer/src/styles/page-review.css#L266)
- `.checkbox-row`: Import/ShareImport, [`settings.css`](../src/renderer/src/styles/settings.css#L940)
- button switch: Translation options, Gather/Settings auto-fit, outline, Style Guide context

다음 네 의미로 제한한다.

- `CheckboxField`: 여러 항목 중 독립 선택, mixed 가능
- `Switch`: 즉시 켜고 끄는 설정
- `ToggleButton`: 도구/서식 버튼의 pressed 상태
- `ToggleGroup`: 관련 toggle의 keyboard grouping

[`page-review.css`](../src/renderer/src/styles/page-review.css#L719)의 `.style-preset-pin-toggle input`은 앞선 선언과 동일한 속성이 중복되어 있어 시각 회귀 확인 후 즉시 삭제 가능한 후보다.

### 13.8 P1: 19개 모달의 footer/action layout 반복

Modal consumer 22개 중 19개가 footer를 직접 조립한다. 대표는 ErrorReport, Export, FontManager, GatherText, Import, ShareExport, StyleGuide, StylePresetEditor, TranslationOptions, Settings다. [`SettingsModalView.tsx`](../src/renderer/src/components/settingsModal/SettingsModalView.tsx#L99)는 action layout을 직접 만들고 inline `marginRight: auto`까지 사용한다.

```tsx
<ModalActionBar
  secondary={<Button>취소</Button>}
  destructive={<Button variant="danger">삭제</Button>}
  primary={<Button variant="primary">적용</Button>}
/>
```

또는 `FormModal` recipe를 둔다. 기존 Modal의 focus/stack은 변경하지 않는다.

### 13.9 P1: progress/status의 접근성 계약 불일치

- 일반 job: [`RunStatusFeedback.tsx`](../src/renderer/src/components/RunStatusFeedback.tsx#L57)
- 인페인트: [`InpaintingProgressCard.tsx`](../src/renderer/src/components/inpaintingPanel/InpaintingProgressCard.tsx#L15)
- 설치: [`InstallProgressOverlay.tsx`](../src/renderer/src/components/InstallProgressOverlay.tsx#L62)

앞의 두 progress track은 `aria-hidden=true`이고 설치 overlay만 의미 있는 progress primitive를 쓴다. 공통 `ProgressBar`는 determinate/indeterminate, label, value text, reduced motion을 처리해야 한다. `InstallProgressOverlay`의 설치 로그·통계 composition은 별도 기능으로 유지한다.

### 13.10 P2: overlay state와 modal registry의 이중 구조

- 주 앱 모달: [`AppModals.tsx`](../src/renderer/src/components/AppModals.tsx#L62)
- session floating overlay: [`AppSessionView.tsx`](../src/renderer/src/app/session/AppSessionView.tsx#L67)
- 여러 boolean UI state: [`useAppSessionUiState.ts`](../src/renderer/src/app/session/useAppSessionUiState.ts#L25)

두 subtree가 같은 modal z-index를 공유하고, Modal 자체 stack이 최상위 Escape를 처리해 현재 즉시 깨지는 것은 아니지만, 상호 배타적이어야 하는 표면이 동시에 열릴 가능성을 타입으로 막지 못한다.

```ts
type ModalRoute =
  | { kind: "settings"; tab?: SettingsTab }
  | { kind: "import" }
  | { kind: "export"; scope: ExportScope }
  | { kind: "translate"; initialScope: TranslationScope }
  | null;
```

상호 배타적인 주 modal만 route로 묶고, nested confirm/error는 별도 stack/service로 유지한다. 모든 boolean과 popup까지 하나의 enum에 넣지 않는다.

### 13.11 P2: 아이콘·tooltip 정책 분열

Tabler import와 로컬 [`ui/icons.tsx`](../src/renderer/src/components/ui/icons.tsx#L30)가 비슷한 수로 병존하고 Plus, Trash, Eye, Restore, Close, Check, Chevron 의미가 겹친다. Tabler를 canonical catalog에서 고정 size/stroke로 re-export하고 Dock/Float처럼 앱 고유 아이콘만 custom으로 유지한다.

Tooltip도 [`ControlTooltip.tsx`](../src/renderer/src/components/ui/ControlTooltip.tsx#L3)는 native title을 쓰지 않는 정책인데, [`IconButton.tsx`](../src/renderer/src/components/ui/IconButton.tsx#L38)는 항상 `title`을 설정한다. 표준 Tooltip 하나에 delay, placement, keyboard, pointer, touch 정책을 모으고 IconButton이 `label/tooltip/shortcut`을 composition하도록 한다.

### 13.12 CSS 경계가 뒤집힌 사례

- 전역 [`foundations.css`](../src/renderer/src/styles/foundations.css#L171)가 모든 button/input/select/textarea를 styling
- 전역 button hover가 active 색을 덮기 때문에 같은 파일 [L208](../src/renderer/src/styles/foundations.css#L208)에서 feature class 예외 목록을 관리
- input rule이 `.gather-direct-size-input` 같은 feature class를 직접 제외: [L225](../src/renderer/src/styles/foundations.css#L225)
- Settings CSS가 Gather DOM class를 참조: [`settings.css`](../src/renderer/src/styles/settings.css#L501)
- Gather CSS가 `.settings-tabpanel` context를 참조: [`gather-selection.css`](../src/renderer/src/styles/gather-selection.css#L436)
- share class가 panels/modals/settings CSS에 분산

이것은 기반 스타일이 feature DOM을 알아야 하는 역방향 결합이다. primitive의 외형은 CSS Module, feature CSS는 layout과 도메인 시각화만 맡긴다.

또한 [`foundations.css`](../src/renderer/src/styles/foundations.css#L60)는 glassmorphism을 제거했다고 설명하면서 `--glass-panel`, `--glass-rail`, `--glass-border`, `--glass-highlight`, `--glass-blur`를 계속 쓴다. `--glass-blur`는 정의 외 사용처가 없어 삭제 후보이고 나머지는 `surface/line/elevation` 의미 이름으로 바꾼다.

### 13.13 정적 검사상 파일 단위 삭제 후보는 없음

export 정의만 있고 사용이 전혀 없는 UI 컴포넌트는 확인되지 않았다. 따라서 “비슷해 보인다”는 이유로 파일을 통째로 지우면 안 된다.

안전한 삭제 후보:

1. 미사용 `--glass-blur`
2. 중복 `.style-preset-pin-toggle input` selector
3. StylePresetEditor를 primitive로 이관한 뒤 `.style-preset-action` 계열
4. Button 이관 완료 뒤 전역 `.primary/.danger`
5. Popup primitive 이관 뒤 각 메뉴의 outside-click/Escape/focus effect
6. typography primitive 이관 뒤 Settings/Gather private duplicate controls
7. Switch/Checkbox 이관 뒤 `.guide-hide-check`, `.checkbox-row`, `.inline-toggle`, `.style-preset-pin-toggle` 중복 chrome

삭제하면 안 되는 것:

- Modal focus/stack 구현
- WorkPagePicker와 adapter, mixed `TriCheckbox`
- FontSelect의 즐겨찾기/삭제 도메인 action
- StageToolbar의 hover-delay와 캔버스 도구 의미
- Install overlay의 로그/통계 composition
- curve/perspective/bubble/canvas geometry control
- Dock/Float 등 앱 고유 아이콘

---

## 14. 실행 로드맵

이 순서는 “눈에 보이는 화면부터 크게 바꾸기”가 아니라, 접근성 동작과 상태 모델을 먼저 안정화하고 그 위에서 화면의 권위 있는 위치를 이동하도록 설계했다. 각 단계는 독립적인 PR 묶음으로 나눌 수 있다.

### Phase 0 — 계약과 기준선 고정

목표: 리팩터링 중 무엇이 깨졌는지 판정할 수 있게 한다.

작업:

- UI 역할 표 작성: 전역 명령, 페이지 명령, 선택 명령, 작업 상태의 현재 위치와 목표 위치
- `TranslationScope`, `PageWorkflowState`, `PipelineStage`, `ModalRoute` 중 먼저 필요한 공통 타입 제안
- 기존 Button/IconButton/Modal/Field/Selection 상태 매트릭스 QA entry
- 기본 1600×980, 최소 1240×760 시각 기준선
- 키보드 smoke test: Modal focus, 메뉴 Escape, 탭 이동, 페이지 선택, 커맨드 팔레트
- 기존 raw component inventory를 lint/검사 출력으로 저장하되 당장 build fail 규칙으로 만들지 않음

완료 조건:

- 각 대표 명령·상태가 앞으로 어디에 남는지 한 줄로 답할 수 있음
- QA 캡처가 실제 production component를 import하고 오류 없이 렌더링
- 마이그레이션 전후를 비교할 핵심 상호작용 테스트가 존재

### Phase 1 — 접근성 기반 primitive

목표: 새 UI가 다시 제각각 만들어지는 것을 먼저 막는다.

작업 순서:

1. `usePopupController/FloatingLayer`
2. `Menu`, `Popover`, `Listbox`를 의미별로 구현
3. `Tabs`, `SegmentedControl`, `ToggleButton/Group`
4. `ProgressBar`, `StatusBadge`, `InlineMessage`
5. `Tooltip`과 IconButton composition
6. `ModalActionBar`

우선 이관 대상:

- LibrarySortMenu → Menu 기준 구현
- SettingsTabs/StyleGuideTabs → Tabs
- 일반 job/inpainting progress → ProgressBar
- StatusPopover → Popover 역할 재판정
- 단순 모달 footer 2~3개 → ModalActionBar

완료 조건:

- 메뉴는 Arrow/Home/End/Escape/Tab 정책이 동일
- listbox와 menu의 ARIA role을 섞지 않음
- 툴팁이 hover와 keyboard focus에서 모두 작동
- progress가 화면 판독기에 label/value/indeterminate를 전달
- 기존 특수 동작(FontSelect action, StageToolbar hover delay)은 유지

### Phase 2 — 앱 셸과 대표 명령 정리

목표: 가장 큰 UX 중복과 캔버스 폭 문제를 해결한다.

작업:

- 상단 `AppTopBar`: breadcrumb, save state, Undo/Redo, activity, export
- 좌측 SidebarToolbar를 빈 상태 Primary + 앱 메뉴/오버플로로 재배치
- `번역`/`작품 일괄 번역`을 단일 번역 실행 흐름으로 연결
- AppRightQuickRail의 각 action을 상단/도구막대/context/action center로 이관
- 좌우 패널 resize/collapse/reset/persistence
- 선택이 없거나 빈 프로젝트일 때 우측 Inspector/TaskHub의 의미 있는 empty content 또는 접힘
- page status와 global activity 분리

수정 영향이 큰 파일군:

- `AppSessionView`, `AppSidebar`, `WorkspaceContent`
- `AppRightQuickRail`, `ChapterQuickControls`, `StatusDockButton`
- `AppRightRail`, `rightRailPanels`, `RunStatusPanels`
- `shell-workspace.css`, `panels.css`, `library-inpainting.css`

완료 조건:

- 빈 상태 Primary CTA가 하나
- 번역 실행의 대표 진입점이 하나이고 모든 실행에서 대상 범위를 확인 가능
- 최소 1240px에서 중앙 캔버스 유효 폭이 현재보다 의미 있게 넓어짐
- 패널을 접고 다시 열어도 selection/focus/scroll이 유지
- 동일 작업 상태가 같은 중요도로 두 군데 반복되지 않음

### Phase 3 — 백그라운드 작업과 안전성

목표: 번역 중 앱 전체 잠금을 제거하고 대규모 변경을 복구 가능하게 한다.

작업:

- page/block revision과 job target snapshot
- 페이지 단위 lock/충돌 처리
- 큐·실패·재시도·취소를 갖는 ActivityCenter
- 완료 페이지 즉시 검수
- 재번역/일괄 스타일/인페인트 전 checkpoint
- 실행 전 ScopeSummary와 영향 미리보기
- 저장 중/저장됨/저장 실패를 문서 상태로 분리

완료 조건:

- 한 챕터가 번역 중이어도 완료된 페이지를 열고 수정 가능
- 실패 페이지 1개만 재시도 가능
- 사용자가 수정한 revision을 늦게 도착한 job 결과가 조용히 덮지 않음
- 페이지·모드 전환 뒤에도 Undo/checkpoint 복구 가능

이 단계는 UI만의 리팩터링이 아니며 문서 상태와 job architecture 변경을 동반한다. 독립적인 기술 설계가 필요하다.

### Phase 4 — 필드·서식 통합

목표: 가장 큰 코드 중복인 Gather/Settings typography와 form chrome을 줄인다.

작업 순서:

1. `NumberField/Stepper`, `SelectField`, `TextAreaField`, `CheckboxField`, `Switch`, `ColorField`
2. numeric commit/Undo 계약 테스트
3. `BLOCK_FORMAT_FIELDS` metadata
4. Gather adapter 이관
5. Settings defaults adapter 이관
6. Editor format adapter 이관
7. cross-feature selector 제거 및 CSS Module화

완료 조건:

- 같은 숫자 필드는 같은 Enter/Escape/clamp 정책
- 실시간 preview와 commit 시점이 prop/API에서 명확
- mixed value가 빈 값과 구분됨
- Settings가 Gather feature 내부 파일을 import하지 않음
- 이관된 feature의 raw field chrome과 global 예외 selector 제거

### Phase 5 — 페이지 행과 문제 중심 검수

목표: 장편 번역의 핵심 반복 작업을 단축한다.

작업:

- 표준 PageRow: 썸네일, 이름, 짧은 상태, overflow
- 상태 필터와 검색
- ReviewTable과 canvas selection 양방향 연결
- QA rule과 문제 우선 정렬
- 승인→다음, 다음 오류, 다음 미검토 단축키
- 여러 블록/행의 공통 서식과 mixed state
- 원본/결과 비교를 검수 화면의 기본 동작으로 승격

완료 조건:

- 사용자가 마우스 없이 미검토 블록 10개를 연속 승인 가능
- 행에서 페이지 상태를 알아보기 위해 우측 작업 카드를 열 필요가 없음
- QA 항목을 누르면 실제 문제 블록으로 이동
- canvas와 table이 같은 문서 상태·Undo 스택을 사용

### Phase 6 — 인페인트와 내보내기 완성

목표: 현재 좋은 단계형 흐름을 안전한 공통 workflow로 마무리한다.

작업:

- 공통 StepIndicator
- mask add/remove overlay와 도구 계약
- preview/apply 분리
- 적용 범위가 들어간 버튼 문구
- ExportPreflight
- 형식별 layer/metadata 설명
- 남은 경고 수를 표시한 override export

완료 조건:

- 인페인트 적용 뒤 Undo 가능
- neutral back와 destructive action이 색/문구로 명확히 다름
- 내보내기 전에 알려진 품질 문제를 한 곳에서 확인하고 이동 가능

### Phase 7 — 시각 정리와 고급 생산성

작업:

- global element style 축소
- glass 토큰 semantic rename과 미사용 토큰 삭제
- layer/elevation/motion/density token
- icon catalog
- 번역/검수/인페인트 작업공간 프리셋
- focus mode와 layout reset
- version/checkpoint panel
- 긴 웹툰 연속 보기와 동기 비교

시각 polish는 이 단계까지 기다리라는 뜻이 아니다. 각 단계에서 회귀 없이 정리하되, 앱 전체의 색·반경·그림자 일괄 변경은 정보 구조가 안정된 뒤 수행한다.

---

## 15. 테스트·실제 화면 QA 계획

### 15.1 컴포넌트 상호작용 테스트

| 대상        | 필수 테스트                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------- |
| Menu        | trigger focus, open, Arrow, Home/End, Escape, outside dismiss, disabled item, focus restore |
| Listbox     | 검색, active option, 선택, action이 있는 option, screen reader name                         |
| Popover     | modal/non-modal, outside click, trigger 재클릭, viewport collision                          |
| Tabs        | roving tabindex, Arrow/Home/End, panel linkage, disabled tab                                |
| Segmented   | radiogroup semantics, value change, focus 이동                                              |
| NumberField | draft, invalid, min/max, Enter, Escape, blur, change preview, Undo count                    |
| Modal       | nested stack, first focus, trap, Escape top-only, trigger focus restore                     |
| Progress    | determinate/indeterminate accessible value, cancel/retry action                             |
| PagePicker  | filter, all visible/all dataset, mixed, pending, removed page canonicalization              |

### 15.2 사용자 흐름 통합 테스트

- 빈 상태 → 가져오기 → 빠른 설정 → 번역 실행
- 기존 수정이 있는 페이지 재번역 → 영향 요약 → checkpoint → 복구
- 10페이지 큐 → 1페이지 완료 → 완료 페이지 검수 → 다른 페이지 계속 처리
- 실패 3페이지 필터 → 1개 수정/재시도 → 상태 일치
- ReviewTable 행 선택 ↔ 캔버스 블록 선택 ↔ Undo
- 인페인트 mask 수정 → preview → apply → 페이지 이동 → Undo
- 경고가 있는 내보내기 → 문제로 이동 → 수정 → 깨끗한 preflight
- modal 위 confirm/error 중첩 → 올바른 Escape/focus stack

### 15.3 시각 QA 상태 매트릭스

AGENTS.md의 저장소 QA 도구를 계속 사용한다.

- 크기: 1600×980, 1240×760
- 패널: 좌/우 펼침, 한쪽 접힘, 양쪽 접힘, 사용자 resize 최소/최대
- 문서: 빈 상태, 1페이지, 장편 챕터, 매우 긴 파일명, 0 block, 많은 block
- 상태: idle, queued, running, partial, failed, review, approved
- selection: 없음, page, single block, multi block, mask mode
- modal: sm/md/lg/xl, 긴 localized text, 오류, busy/close disabled
- zoom: 100%, 150%, 200%
- 언어: 한국어, 영어, 일본어, 독일어처럼 긴 레이블

확인 항목:

- 캔버스와 주요 CTA의 잘림/겹침/가로 overflow
- 팝오버 collision, modal footer, tooltip 가림
- focus ring과 selection border 구분
- hover에서 active/selected 색이 사라지지 않음
- disabled reason이 접근 가능
- 긴 텍스트가 아이콘을 밀거나 버튼 의미를 숨기지 않음

### 15.4 접근성 자동·수동 확인

- 자동: accessible name, role/state, label association, contrast token 테스트, axe 계열 도입 검토
- 수동 키보드: 앱 시작부터 가져오기, 번역, 검수, 내보내기까지 pointer 없이 수행
- screen reader smoke: modal title, job status, progress, error, page status
- Windows 고대비/forced colors
- reduced motion
- 200% zoom에서 focus가 sticky bar/modal footer에 가려지지 않음

### 15.5 사용성 검증

코드 감사만으로 우선순위를 확정하지 말고 다음 5개 시나리오를 초보 3~5명, 기존 사용자 3~5명에게 관찰한다.

1. 처음 ZIP을 가져와 미번역 페이지만 번역
2. 한 풍선의 OCR과 번역을 고침
3. 선택한 여러 블록의 글꼴과 크기를 바꿈
4. 실패한 페이지만 찾아 재시도
5. 문제를 확인하고 내보냄

기록:

- 첫 클릭과 망설임
- 잘못 선택한 범위
- 뒤로 가기/취소/Undo 사용
- 작업 상태를 찾은 위치
- 사용자가 예상한 결과와 실제 결과 차이
- 질문 없이 완료 가능한지

---

## 16. 성공 지표

### 16.1 핵심 funnel

- `가져오기 시작 → 페이지 생성 → 번역 실행 → 첫 결과 확인`
- time-to-first-translation
- 처음 실행까지 연 설정 화면 수
- 번역 실행 전 주요 결정 수
- 번역 옵션 modal 이탈률

목표 예:

- 신규 사용자가 설정을 탐색하지 않고 3개 이하의 주요 결정으로 미번역 페이지 실행
- 지원되는 설정이 준비된 상태에서 첫 번역 실행까지 60초 이내

### 16.2 오류와 안전성

- 잘못된 범위 실행 후 30초 이내 취소율
- 재번역 직후 Undo/checkpoint 복구율
- 기존 수동 수정과 job 결과 충돌 수
- 덮어쓰기 확인 modal에서 취소한 비율
- 작업 실패 중 사용자에게 재시도 방법이 없는 비율

목표:

- 잘못된 범위 실행과 조용한 덮어쓰기를 지속적으로 감소
- 모든 P0 데이터 변경에 복구 경로 존재

### 16.3 검수 생산성

- 페이지/블록당 평균 수정 시간
- 미검토 10블록 승인 시간
- 다음 문제를 찾기 위해 panel/page를 전환한 횟수
- QA가 내보내기 전에 잡은 overflow/미번역/폰트 대체 수
- 검수 완료 뒤 되돌아와 다시 고친 비율

### 16.4 시스템 일관성

- raw button/input/select 신규 도입 수
- popup controller의 독자 구현 수
- feature-specific global element exception 수
- hard-coded interface color와 임의 z-index 수
- 공통 component 상태 매트릭스 커버리지
- 같은 의미의 번역/상태 문구 중복 수

숫자 자체를 목표로 삼지 않는다. 예를 들어 캔버스 geometry의 `px`를 없애거나 도구용 raw element를 억지로 감싸는 것은 지표를 좋게 보이게 할 뿐이다.

---

## 17. 명시적으로 피할 것

- 모든 raw `<button>`을 한 번에 `Button`으로 자동 교체
- Menu, Listbox, Popover를 하나의 `Dropdown`으로 통합
- 서로 다른 선택 reducer를 “중복 제거”만을 위해 하나로 합침
- Gather와 Settings를 거대한 만능 Typography component 하나로 합침
- Canvas overlay 색을 일반 status color로 통일
- 설정을 예쁘게 재배열하면서 내부 엔진 파라미터는 그대로 모두 노출
- 같은 명령을 여러 패널에서 모두 Primary로 유지
- 페이지 이동/검수 화면 진입으로 Undo stack을 끊음
- background 번역 중 전체 캔버스를 잠금
- 로그 스트림을 대표 진행 UI로 사용
- 색만으로 selected/running/error를 구분
- 단순 뒤로/닫기를 danger로 표현
- 자동 글자 축소·폰트 대체를 조용히 적용
- 원본 덮어쓰기를 기본값으로 선택
- 좁은 캔버스에서 side-by-side 비교를 강제
- 모든 그룹을 카드와 테두리로 둘러쌈
- 디자인 토큰 이름만 바꾸고 실제 literal/exception은 남김
- 초기 개편부터 패널을 어디든 옮기는 무제한 커스터마이징 제공
- 초보자 기본 화면에 파이프라인 노드 그래프 노출

---

## 18. 최종 우선순위 한 장 요약

### 지금 바로 설계할 P0

1. 대표 명령·상태의 위치 지도
2. 번역 범위와 영향 요약
3. Popup/Menu/Listbox/Popover 기반
4. Tabs/Segmented/Toggle 의미와 키보드
5. 앱 셸의 패널 접기·리사이즈와 캔버스 폭
6. 페이지 상태와 ActivityCenter 분리
7. background job, checkpoint, 프로젝트 단위 Undo 설계

### 바로 이어서 구현할 P1

1. 필드·숫자 commit·checkbox/switch 표준
2. Gather/Settings typography 중복 제거
3. ModalActionBar, ProgressBar, Status primitives
4. PageRow와 문제 필터
5. 캔버스 연동 ReviewTable
6. 인페인트 preview/apply와 내보내기 preflight
7. semantic token과 cross-feature CSS 정리

### 구조가 안정된 뒤 P2

1. icon catalog와 tooltip polish
2. 작업공간 프리셋·focus mode
3. checkpoint/version history UI
4. 긴 웹툰 연속 보기·동기 비교
5. 여러 번역 후보, TM/용어 차이, 메모·코멘트

최종 판단은 간단하다. **가장 먼저 예쁘게 만들 대상은 카드가 아니라, 사용자가 “어디서 무엇을 해야 하고 지금 무엇이 일어나는지” 한 번만 보게 만드는 구조다.** 그 구조를 고정한 뒤 primitive와 token을 적용하면 중복 제거가 곧 사용성 개선이 된다.

---

## 19. 사용자 여정에서 발견한 구체적 결함

### 19.1 `번역`과 `가져오기`의 이름이 실제 결과와 다름 — P1

좌측 [`AppSidebar.tsx`](../src/renderer/src/components/AppSidebar.tsx#L143)의 `번역`은 실제로 원본 이미지/폴더/ZIP 선택 흐름을 여는 반면, 우측 [`RunStatusPanels.tsx`](../src/renderer/src/components/RunStatusPanels.tsx#L20)의 `번역`은 이미 열린 챕터의 번역 옵션을 연다. 좌측 `가져오기`는 일반 원본이 아니라 공유 작업 패키지 가져오기에 가깝다.

영향:

- 사용자는 이미지를 열기 위해 `번역`을 눌러야 한다는 내부 데이터 흐름을 추론해야 함
- 같은 단어가 다른 상태 전환을 일으킴
- 빈 화면 중앙, 좌측, 우측에 같은 듯 다른 행동이 중복됨

권장 라벨과 책임:

- `새 원본 추가`: 이미지·폴더·ZIP
- `현재 챕터 번역`: 이미 열린 챕터에서만
- `작업 가져오기` / `작업 내보내기`: 공유 패키지

기존 command ID는 유지하고 노출 라벨과 위치를 바꾸면 단축키·커맨드 팔레트·자동화 회귀를 줄일 수 있다.

### 19.2 원본 선택과 편입 흐름의 설명·기본값 부족 — P1

[`TranslateSourceModal.tsx`](../src/renderer/src/components/TranslateSourceModal.tsx#L20)는 이미지, 폴더, ZIP 세 버튼만 동등하게 보여 주며 지원 확장자, 폴더 정렬, 압축 제한, drag-and-drop, 최근 경로를 설명하지 않는다.

[`ImportModal.tsx`](../src/renderer/src/components/ImportModal.tsx#L37)의 target 초기값은 작품이 있어도 없어도 항상 `new`다. 이미 작품 맥락에서 호출했을 때도 새 작품이 기본이면 잘못된 편입을 만들기 쉽다. 또한 preview의 챕터 제목 input은 [L332](../src/renderer/src/components/ImportModal.tsx#L332)에 명시적 label/accessible name이 없다.

개선:

- 큰 dropzone 하나 + `찾아보기`, 세 소스 유형은 보조 선택
- 지원 포맷, 정렬, ZIP 제한을 짧게 표시
- 작품 화면 호출: `현재 작품에 새 챕터` 기본
- 빈 화면 호출: `새 작품` 기본
- submit disabled 이유를 필드 근처에 표시
- 최근 경로와 마지막 편입 대상 기억은 opt-in/예측 가능한 방식으로 제공

### 19.3 번역 옵션이 묵시적으로 기본값을 바꿈 — P0

[`TranslationOptionsModal.tsx`](../src/renderer/src/components/TranslationOptionsModal.tsx#L79)는 시작 시 다음 값을 `onPersistDefaults`로 저장한 뒤 실행한다.

- workflow
- analysis scope
- block mode
- auto font matching
- natural text layout
- erase original workflow
- bubble layout workflow

화면에는 `이 설정을 다음 실행의 기본값으로 저장`이라는 선택이나 고지가 없다. 특정 챕터에서만 쓰려던 정밀 2차 처리, 원문 제거, 레이아웃 방식이 다음 작품에도 적용되어 예상하지 않은 시간·비용·결과를 만들 수 있다.

개선:

- 기본: `이번 실행에만 적용`
- 명시적 checkbox 또는 secondary action: `다음 번역의 기본값으로 저장`
- 시작 버튼 위 고정 요약: `미번역 4페이지 · 누적 문맥 · 원문 지우기 · 정밀 2차`
- 완료 페이지 포함 시 `완료 2페이지도 다시 번역합니다` 경고
- 기존 저장값은 migration 없이 읽되, 새 실행부터 persist 여부를 분리

회귀 위험: 중~높음. 기존 사용자가 의도적으로 저장해 둔 값은 보존하고, 새로운 변경만 명시적 저장으로 바꿔야 한다.

### 19.4 성공 뒤 다음 행동이 사라짐 — P1

실행 중 진행률·단계·취소는 [`RunStatusPanels.tsx`](../src/renderer/src/components/RunStatusPanels.tsx#L43)에서 비교적 명확하다. 그러나 [`RunStatusFeedback.tsx`](../src/renderer/src/components/RunStatusFeedback.tsx#L36)는 작업이 `completed`이거나 progress가 100%면 `null`을 반환한다. 실패·부분 성공은 지속 카드가 남지만 성공은 주로 toast만 남아 결과 검토·내보내기로 연결되지 않는다.

성공 요약 카드:

```text
6페이지 완료 · 1페이지 검토 필요 · 42개 블록
2분 13초 · 재시도 1 · 건너뜀 0
[첫 검토 항목] [검토 필요만 보기] [내보내기] [로그]
```

작업 ID와 챕터 ID를 함께 보관해 챕터 전환 뒤 이전 결과가 잘못 표시되지 않게 한다. 취소 클릭 뒤에는 `취소 요청 중…`으로 바꾸고 중복 클릭을 막는다.

### 19.5 텍스트 입력과 캔버스 선택이 어긋남 — P1

[`PageBlockListRow.tsx`](../src/renderer/src/components/PageBlockListRow.tsx#L26)는 카드 클릭 시 블록을 선택하지만, translation textarea는 [L71](../src/renderer/src/components/PageBlockListRow.tsx#L71)에서 click propagation을 막기만 하고 focus 시 해당 블록을 선택하지 않는다. 사용자가 텍스트를 직접 클릭해 수정하면 우측 카드와 캔버스 선택이 달라질 수 있다. 카드 자체도 article이면서 click handler를 가지지만 keyboard selection 의미가 없다.

개선:

- textarea `onFocus`에서 해당 블록 선택
- 캔버스 선택 → 카드 scroll/강조, 카드 focus → 캔버스 강조
- 선택 가능한 row의 keyboard semantics와 focus ring
- `전체/검토 필요` 필터와 compact row, 선택 row만 확장
- 외부 선택에 의한 focus 이동과 사용자의 입력 focus를 구분해 cursor jump/scroll loop 방지

### 19.6 자동 저장은 있으나 신뢰 상태가 보이지 않음 — P1

[`useChapterPersistence.ts`](../src/renderer/src/hooks/useChapterPersistence.ts#L93)는 queued autosave와 stale/conflict 처리를 갖지만, UI에는 저장 중·저장됨·저장 실패·충돌이 지속적으로 보이지 않는다. 실패가 toast에만 의존하면 사용자는 창을 닫거나 챕터를 바꿔도 되는지 판단할 수 없다.

상단 breadcrumb 옆 문서 상태:

- `저장 중…`
- `14:32 저장됨`
- `저장 실패 · 재시도`
- `다른 변경과 충돌 · 비교하기`

매 타이핑마다 전체 캔버스를 다시 렌더링하지 않도록 save queue의 작은 external state만 구독한다.

### 19.7 설정 `기본값 복원`이 즉시 실제 설정을 바꿈 — P0

[`SettingsModalView.tsx`](../src/renderer/src/components/settingsModal/SettingsModalView.tsx#L118)에서 `기본값 복원`은 취소·저장과 나란히 있다. 그런데 [`useSettingsDialog.ts`](../src/renderer/src/hooks/useSettingsDialog.ts#L182)의 reset action은 즉시 gateway `resetSettings()`를 호출하고 반환된 설정을 앱 state에 넣으며 locale까지 적용한다. 모달의 임시 draft만 초기화되는 것이 아니다.

또한 [`useSettingsModalController.ts`](../src/renderer/src/components/settingsModal/useSettingsModalController.ts#L147)의 `canSubmit`은 유효성만 보고 초기값과 변경 여부를 비교하지 않아, 변경이 없어도 저장이 가능하다. 변경 후 X/Escape로 닫을 때 폐기 확인도 없다.

가장 안전한 변경:

1. `기본값 복원`은 모든 local draft를 default로 바꿈
2. 화면에 변경된 필드를 표시
3. `저장`을 눌렀을 때만 실제 적용
4. `취소`하면 기존 설정 유지
5. dirty 상태로 닫을 때 `변경 사항을 버릴까요?`

즉시 reset을 유지해야 한다면 `엔진, 하드웨어, 번역 기본값을 초기화합니다`처럼 범위를 구체적으로 설명하는 확인과 Undo가 필요하다. API key·모델 경로·비밀정보가 reset 범위에 포함되는지도 문구와 정책으로 명확히 한다.

회귀 위험: 높음. reset gateway의 계약, locale 즉시 적용, secret 보존, 설정 migration을 별도 통합 테스트해야 한다.

### 19.8 엔진·하드웨어 설정의 정보 밀도 — P1

[`EngineSettingsPanel.tsx`](../src/renderer/src/components/settingsModal/EngineSettingsPanel.tsx)는 provider, 언어, 모델 preset, Hugging Face repository, GGUF/mmproj, GPU, OCR, 인페인트 세부 값을 같은 전문가 밀도로 다룬다.

권장 progressive disclosure:

- 상단 preset: `권장 자동 설정`, `로컬 고품질`, `저사양`, `클라우드`
- provider 카드 안: `연결됨`, `모델 없음`, `VRAM 부족 예상`, `테스트`
- 고급 설정: HF/GGUF/mmproj와 세부 한도
- 감지한 하드웨어를 바탕으로 권장값과 현재값 차이 설명
- 고급 필드는 검색으로 항상 접근 가능

고급 필드를 없애면 안 된다. 초보의 기본 경로에서 접고, 전문가의 직접 접근과 설정 migration은 유지한다.

### 19.9 단축키 화면에 i18n key가 그대로 노출됨 — P1 버그

[`ShortcutsSettingsPanel.tsx`](../src/renderer/src/components/settingsModal/ShortcutsSettingsPanel.tsx#L31)는 `components` namespace에서 `settings.shortcuts.actions.${actionId}`를 찾는다. [`shortcutActions.ts`](../src/renderer/src/lib/shortcuts/shortcutActions.ts#L135)에는 `page-previous`, `page-next`가 있으나 해당 label은 [`ko/renderer.json`](../src/shared/i18n/locales/ko/renderer.json#L183) 등 renderer namespace에 있고 components namespace에는 없다. 실제 화면에 다음 문자열이 그대로 보인다.

- `settings.shortcuts.actions.page-previous`
- `settings.shortcuts.actions.page-next`

조치:

- action label의 canonical namespace/path 결정
- 모든 `ShortcutActionId`가 모든 지원 locale에 존재하는지 테스트
- 한국어만 보충하지 말고 en/ja/zh-Hans/zh-Hant 전체 검사
- 재정의하지 않은 행에는 항상 `기본값 복원`을 노출하지 않고 필요할 때만 표시/overflow

### 19.10 Primary 버튼 색 대비 미달 — P1

현재 accent 배경 `#c15f41`, hover `#cf6d4d`, 전경 `#f4efe6` 조합은 각각 약 **3.68:1**, **3.08:1**이다. 색은 [`foundations.css`](../src/renderer/src/styles/foundations.css#L19)와 [`Button.module.css`](../src/renderer/src/components/ui/Button.module.css#L60)에서 사용된다. 13px/600 버튼 레이블은 큰 텍스트 예외로 보기 어려우므로 [WCAG 2.2의 4.5:1 일반 텍스트 기준](https://www.w3.org/TR/WCAG22/#contrast-minimum)에 못 미친다.

개별 버튼 override 대신 token 단계에서 다음 중 하나를 선택한다.

- accent 배경을 더 어둡게
- 현재 밝기의 accent라면 충분히 어두운 전경 사용
- 브랜드색을 border/icon에 남기고 고대비 filled color 별도 정의

default/hover/pressed/disabled/focus 조합의 contrast를 자동 검사한다.

### 19.11 Text Gather footer가 너무 많은 일을 함 — P1/P2

[`GatherTextFooter.tsx`](../src/renderer/src/components/gatherText/GatherTextFooter.tsx#L38) 한 영역에 검색, 페이지 머리말 제외, CSV/TSV 검토·가져오기, TXT 저장·가져오기, 전체 복사가 모인다. 자주 쓰는 검수와 드문 교환 기능의 중요도가 같다.

개선:

- 검색을 header로 이동
- 본문을 `검토`와 `교환/내보내기`로 분리
- `전체 복사`가 실제 빈도상 대표라면 Primary/직접 action
- CSV/TSV/TXT는 `내보내기/가져오기` 메뉴로 그룹화
- 기존 roundtrip과 Enter 검색을 통합 테스트

### 19.12 내보내기 선택은 좋지만 출력 정책이 늦게 보임 — P2

[`ExportPagePicker.tsx`](../src/renderer/src/components/ExportPagePicker.tsx#L62)의 페이지 선택은 번역과 공통 picker를 써 좋은 사례다. 그러나 [`ExportOptionsModal.tsx`](../src/renderer/src/components/ExportOptionsModal.tsx#L32) 단계에서는 출력 폴더, 파일명 규칙, 동일 파일 충돌 처리, 배율을 알기 어렵고 폴더 선택이 다음 단계에 나타난다.

시작 버튼 가까이에 최소한 다음을 표시한다.

- `다음 단계에서 저장 폴더를 선택합니다`
- 파일명 예시
- 동일 파일: 덮어쓰기 / 건너뛰기 / 번호 추가
- 완료 뒤 `폴더 열기`, `다시 내보내기`

### 19.13 삭제는 안전하지만 찾는 위치가 부자연스러움 — P2

작품·챕터 삭제는 [`RenameModal.tsx`](../src/renderer/src/components/RenameModal.tsx#L34)의 이름 변경 표면 안에 있다. 확인 단계가 있어 즉시 삭제되지는 않지만, 삭제를 찾으려면 이름 변경을 열어야 한다.

작품·챕터 `…` 메뉴에 `이름 변경`, `폴더 열기`, `삭제`를 명시하고 기존 확인 dialog를 재사용한다. 페이지 재시도·삭제도 selection hover에서만 갑자기 나타나기보다 context menu가 있음을 보여 준다.

### 19.14 반응형 shell 규칙이 Settings CSS에 들어 있음 — P1 유지보수

[`settings.css`](../src/renderer/src/styles/settings.css#L981)에 전체 `.app-shell`의 1400px/1180px responsive 규칙이 있다. 설정 feature 스타일이 앱 전역 layout을 소유하는 역방향 결합이다. 1180px 아래에서는 sidebar와 right rail이 전체 폭으로 순서대로 쌓여 캔버스를 보기 전 긴 library를 지나야 한다.

현재 BrowserWindow 최소 너비가 1240px이므로 1180px 분기는 일반 창에서 자주 나타나지 않지만 UI 확대/고배율 또는 향후 창 제한 변경에서 도달할 수 있다.

조치:

- responsive shell 규칙을 `shell-workspace.css`로 이동
- narrow layout은 세로 문서가 아니라 캔버스 중심 + 좌/우 overlay drawer
- 125%, 150%, 200% UI 확대에서 pointer 좌표, zoom, block drag, floating editor 검증

---

## 20. 즉시 착수 순서

구조 개편과 별개로 다음은 작은 범위에서 신뢰를 즉시 높이는 순서다.

1. 설정 reset을 draft 기반으로 바꾸고 dirty-close 보호 추가
2. 번역 옵션의 묵시적 defaults persist 제거
3. primary button 대비 수정
4. 누락 단축키 locale과 locale coverage test
5. progressbar/status 접근성
6. 저장 상태 표시
7. 성공 결과 카드와 다음 행동
8. 텍스트 focus ↔ 캔버스 selection 동기화

그다음 앱 셸, 번역 범위, ActivityCenter, 공통 popup/form/typography를 병렬 작업한다.
