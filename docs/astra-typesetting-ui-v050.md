# Astra 번역·식자 UI v0.5.0 인계

2026-09-06 기준 구현된 UI 후보의 동작과 검증 범위다. 앱 정식 릴리스나 자동 번역 레시피의 품질 승격을 뜻하지 않는다. 기존 v049 연구에서 수용한 결과와 이번 UI 검증은 별도이며, 이번 UI 작업에서는 새 ImageGen 실험을 실행하지 않았다.

## 유지한 UI 체계

- 기존 다크 데스크톱 shell, 좌·중앙·우 작업 배치와 기능 진입 위치를 유지한다. 새 제품 비전이나 전역 디자인 체계를 만들지 않았다.
- 색상·상태·레이어의 권위는 `src/renderer/src/styles/foundations.css`, 표면·스크롤·접근성 기준은 [UI 설계 규칙](ui-design-rules.md)이다. 어두운 중립 표면과 기존 적갈색 강조색을 재사용한다.
- 본문은 기존 언어별 시스템 글꼴과 작은 크기의 도구 UI 위계를 따른다. 신규 기능의 안내·입력에 별도 display 서체나 장식용 제목을 도입하지 않았다.
- `Modal`, `Button`, `Field`, `Select`, `SegmentedControl`, `CheckboxField`, `FieldSlider`를 사용한다. 폰트 목록과 보정 도구는 여백과 divider로 구분하며 같은 평면에 장식용 표면을 쌓지 않는다.

## 설정과 실행 경계

`CodexSettingsFields.tsx`의 **모든 작업 Codex에게 맡기기**는 `gpt-6-astra`를 선택한 경우에만 노출하는 명시적 opt-in 스위치다. 저장 설정 `codex.delegateAll`은 명시적 `true` 외에는 꺼짐으로 정규화한다. Astra 모델을 고르는 것만으로 인페인팅 경로나 전역 위임이 바뀌지 않는다.

`canUseCodexTypesetting`은 Codex 공급자, Astra 모델, ChatGPT 계정 인증, 모델 카탈로그 및 선택한 추론 강도 지원을 함께 확인한다. 인증·지원 조건을 만족하지 않거나 설정 작업 중이면 스위치는 비활성화된다. 런타임도 같은 계정·모델·추론 강도를 다시 검증하며 실제 요청에 저장된 추론 강도를 전달한다.

연결 해제 시 토스트로 알리고, 진행 중인 해당 Codex 번역 작업은 `codex-disconnected` 사유의 실패 상태로 중단한다. 위임 설정을 끄고 재연결 후에도 자동으로 다시 켜지 않는다. 연결 실패를 다른 번역 공급자로 자동 대체하지 않는다.

근거: `src/shared/codexCapabilities.ts`, `src/main/settings/appSettingsCodexNormalize.ts`, `src/renderer/src/hooks/useCodexDelegation.ts`, `src/main/ipc/jobControlIpc.ts`, `src/main/pipeline/codexTypesettingRuntime.ts`.

## 영역 번역

`RegionTranslationModal.tsx`는 선택 영역을 확인하고 바로 실행하는 작은 모달이다.

- 원본 래스터를 선택 좌표로 잘라 표시하는 미리보기를 먼저 둔다. 미리보기 로드가 실패하면 오류를 표시하고 실행을 막는다.
- 전역 Codex 위임이 활성화된 경우에만 **결과 형태: 텍스트 / 효과음 이미지**를 표시한다. 일반 경로는 텍스트 결과를 사용한다.
- **원문 지우기**는 라벨 왼쪽에 놓는 단일 토글 스위치다. 전체 번역 모달과 같은 `TranslationOptionControls.ToggleOptionRow`를 직접 재사용하여 글꼴·간격·상태 표시를 맞춘다. ON/OFF 단어, 두 선택지 버튼, 영역 모달 전용 스위치 배치를 만들지 않는다.
- 언어·엔진·추가 설명·영역 다시 선택 동작은 넣지 않는다. footer는 **취소 / 실행**이다.
- 결과 형태 라벨은 줄바꿈하지 않는다. 현재 모달 너비는 360px, 미리보기 높이는 160px이다. 이 수치는 이 모달의 구성값이며 전역 규칙으로 승격하지 않는다.
- 최초 선택은 텍스트·원문 유지다. 성공한 실행의 선택만 일반/Codex 경로별로 세션 안에서 기억한다. 페이지·화·위임 상태가 바뀌면 열린 선택을 닫는다.

일반 경로에서 원문 지우기를 선택하면 기존에 설정된 인페인팅 엔진을 사용한다. 영역 결과는 새 블록과 변경된 배경을 같은 페이지 revision 조건으로 병합한다. 영역 밖과 변경되지 않은 픽셀은 유지하며, 블록·배경을 함께 undo/redo하는 이력을 남긴다.

근거: `src/renderer/src/lib/regionTranslationOptions.ts`, `src/renderer/src/hooks/useRegionTranslationDialog.ts`, `src/main/jobs/regionTranslationArtwork.ts`, `src/main/jobs/translationRegionCompletion.ts`, `src/main/jobs/translationRegionHistory.ts`.

## 전체 번역 옵션

전역 위임이 켜지면 기존 페이지 선택을 유지하면서 원문 지우기, 효과음의 **생성형 / 폰트**, 폰트 프리셋을 표시한다. 프리셋은 내장·등록된 사용자 폰트를 합쳐 최대 10개를 선택하고 각 폰트의 사용 의도를 입력할 수 있다. 이름 변경·복제와 폰트 추가·제거를 지원한다.

위임이 꺼지면 기존 번역 방식·블록·글자 배치·완료 옵션을 다시 사용한다. 위임 설정을 저장하는 과정에서 기존 일반 번역 기본값을 덮어쓰지 않는다. 원문 언어와 대상 언어는 설정을 따른다. 현재 Astra 실행 계약은 일본어 원문만 허용한다.

근거: `src/renderer/src/components/TranslationOptionsModal.tsx`, `src/renderer/src/components/TranslationOptionsForm.tsx`, `src/renderer/src/components/CodexTypesettingOptions.tsx`, `src/main/pipeline/codexTypesettingConfiguration.ts`.

## 생성 효과음과 보정

생성 효과음은 배경에 굽지 않고 `TranslationBlock.generatedLettering`의 별도 RGBA 이미지로 유지한다. 판독에서 받은 자동 가림 polygon은 페이지 좌표에서 적용하여 인물·말풍선 등 전경과 겹치는 부분을 가린다. 효과음 이미지 자체에 전경을 그려 넣지 않는다.

**효과음 보정**에는 다음 실제 도구가 있다.

| 선택                 | 동작                                                        |
| -------------------- | ----------------------------------------------------------- |
| 글자 모양            | 이미지 좌표의 마스크를 수정한다. 블록 이동·변형을 따라간다. |
| 가림 경계            | 페이지 좌표의 가림 마스크를 수정한다.                       |
| 지우기 / 복구        | 선택한 좌표 공간에서 마스크 획을 추가한다.                  |
| 원형 / 사각          | 붓 모양을 고른다.                                           |
| 크기 / 부드러움      | 1–400px, 0–100%를 조절한다.                                 |
| 마스크 표시 / 초기화 | 보정 범위를 보거나 현재 좌표 공간의 수동 획을 지운다.       |

획을 그리는 중에는 미리보기만 갱신하고 pointer 종료 시 블록 변경으로 저장한다. Escape는 진행 중인 획을 취소한다. 저장한 획과 초기화는 기존 블록 변경 undo/redo 경로를 사용한다. 자동 가림 polygon과 수동 획은 별도 데이터다.

원문·번역문이 생성 이미지에 기록된 문구와 달라지면 편집형 글자 표시로 전환한다. 원문 제거 배경은 유지한다. 캔버스와 출력은 공통 `PageArtwork`에서 이미지·변형·가림 마스크를 그리므로 출력 전용의 별도 식자 구현을 두지 않는다.

근거: `src/shared/generatedLettering.ts`, `src/shared/generatedLetteringMaskTypes.ts`, `src/renderer/src/components/GeneratedLetteringControls.tsx`, `src/renderer/src/components/GeneratedLetteringImage.tsx`, `src/renderer/src/hooks/useLetteringStroke.ts`, `src/renderer/src/hooks/useLetteringPageMask.ts`, `src/renderer/src/components/PageArtwork.tsx`, `src/renderer/src/pageExport/browserEntry.tsx`.

## 검증 상태와 한계

실제 production 컴포넌트와 스타일을 불러오는 임시 QA 엔트리로 일반/Codex 영역 모달의 넓은·좁은 화면, 설정, 연결 해제, 전체 옵션의 넓은·좁은 화면, 최종 보정 패널의 넓은·좁은 화면을 캡처했다. 영역 모달은 최종적으로 기존 `ToggleOptionRow`를 재사용하여 스위치를 라벨 왼쪽에 배치했다. 마지막 수정 후 영역 모달 네 캡처를 직접 열어 확인했으며 외부 넘침 없이 기존 모달과 같은 스위치 배치를 확인했다.

최종 QA 캡처 묶음은 `.tmp/astra-ui-v050`의 `standard-shared-wide`, `standard-shared-narrow`, `codex-shared-wide`, `codex-shared-narrow`, `settings-wide`, `disconnected-narrow`, `whole-*`, `brush-*-final`이다. 앞선 `*-toggle-*` 캡처는 최종 스위치 배치의 근거로 사용하지 않는다. 임시 html/tsx와 PNG는 검토 후 프로젝트 지침에 따라 제거하므로 이 문서에 영구 이미지 링크를 만들지 않는다. QA 엔트리 사본은 같은 디렉터리의 `qa-entry.tsx.txt`에 보관한다. 한 번 실행한 Impeccable detector 결과는 `[]`이며 시각 검토나 동작 검증을 대신하지 않는다.

- `.tmp/astra-ui-check-11.log`: 26개 게이트 모두 통과. 테스트 5,465개 통과, 기존 10개 skip. typecheck, lint, 코드 경계, 커버리지 기준, build, page-artwork parity, 이미지 프로토콜 smoke 및 번들 검증을 포함한다.
- 화면/출력 픽셀 검증: `matching-native-size`, `metadata-mismatch-natural-stage` 모두 불일치 픽셀 0, 최대 채널 차이 0. 생성 레이어의 가림·복구·부드러운 경계와 변형을 포함한 fixture의 일치 근거다.
- 기존 커버리지 하한은 낮추지 않았다. 새로 변경한 기존 파일 3개의 기준은 SHA-256이 일치하는 봉인된 baseline에서 가져왔다. 새 파일 23개는 전체 기능 테스트에서 측정한 값으로 추가했다. 이전 accepted artifact와 추가 기록은 `.tmp/astra-ui-v050/coverage-seal.json`에 추적한다.
- 실행 위치: `망가번역기-astra-typesetting-20260905` 워크트리에서 `npm run dev`. 설정 → LLM → Codex → Astra에서 **모든 작업 Codex에게 맡기기**를 켜고 저장하면 전체 번역 및 영역 번역에 반영한다.

자동 번역·식자 품질의 포괄 평가, 새 ImageGen 결과, 안정 버전 게시를 이번 UI 검증으로 주장하지 않는다. 기존 `PRODUCT.md`·`DESIGN.md`가 없었던 사실은 증거의 한계로 남기며, 이 기능 인계에서 새 north star·색상 체계·전역 금지 규칙을 만들지 않았다. 코드에 남은 일회성 치수나 검증 미완료 상태도 재사용할 디자인 규칙으로 정당화하지 않는다.
