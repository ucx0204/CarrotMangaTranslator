# 일괄 편집 일관성 검사

2026-09-09, 기준 커밋 `1639badadc4b552b91ad992592dd48d891c7bb02`.
이전 요청의 줄바꿈 선택지 수정이 포함된 작업 트리를 기준으로 검사했다.

## 범위와 방법

일괄 편집을 구성하는 프로덕션 소스 **36개를 전체 읽고**, 속성 **61개**
(변경 가능 42개, 조회·검사 전용 19개)를 대조했다. 이름·선택지·단위·범위·초기값·해제,
조건 판정·미리보기·적용·충돌 검사, 저장 규칙·YAML·연속 실행이 범위다.
부분 서식은 지원하는 모든 속성의 입력과 명시된 서식만 비교하는 계약을 함께 확인했다.
일반 서식 화면, 글꼴 선택기, 프리셋 생성기, 텍스트 서식 파서와 기존 테스트를 비교 기준으로 사용했다.

세 Hunter가 소스 범위를 나누어 읽고, 각 후보를 Skeptic과 별도 Referee가 실제 코드로
다시 확인했다. 최종 동작 결함 8건은 모두 Medium이며 재현 경로가 확인됐다.
표시 단위와 명칭 차이는 동작 결함 수에 중복 계산하지 않았다.

## 수정한 동작

| ID      | 재현 조건                                                 | 수정 결과                                                                                                                                     |
| ------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| LOCAL-1 | 일반 서식에서 정확한 글꼴 굵기를 저장한 프리셋 선택       | 유효한 `fontWeight`를 수용한다. 굵기만 바뀌어도 미리보기·적용·연속 실행·충돌 검사에 반영한다.                                                 |
| LOCAL-2 | 자동 지정된 굵기가 있는 글자의 글꼴·굵게 속성을 수동 변경 | 일반 편집기의 `normalizeFontWeightPatch`와 같은 규칙으로 이전 정확한 굵기를 해제한다. 기존 꺼짐 상태에 불필요한 false 속성을 추가하지 않는다. |
| LOCAL-3 | 부분 서식에서 밑줄·취소선·강조점이 꺼진 글자 선택         | 생략된 boolean 값을 꺼짐으로 판정한다. 혼합 서식에서도 해당 글자에만 적용한다.                                                                |
| UI-1    | 꺼 둔 프리셋 작업에서 다른 프리셋 선택                    | 작업의 활성 상태와 메모를 유지한다.                                                                                                           |
| UI-2    | 기본 글꼴을 조건으로 선택                                 | 블록·부분 서식 선택기에서 실제 기본 글꼴 ID를 유지한다. 블록 조건에 과거 UI가 저장한 빈 문자열도 기본 글꼴로 판정한다.                        |
| STATE-1 | 규칙 삭제 후 연결된 연속 실행에 비활성 단계만 남음        | 실행 가능한 단계가 없는 연속 실행을 정리해 삭제를 완료한다. 비활성 단계를 임의로 켜지 않는다.                                                 |
| STATE-2 | 고급 정규식의 선택 캡처가 일치하지 않은 경우              | 존재하는 미일치 캡처를 빈 문자열로 치환한다. 캡처 기호가 번역문에 들어가지 않는다.                                                            |
| STATE-3 | 용어집 로딩 중 또는 로딩 실패 상태에서 용어집 조건 적용   | 필요한 용어집이 준비될 때까지 판정과 적용을 보류한다. 실패를 빈 용어집으로 처리하지 않는다. 다른 작품의 이전 응답도 재사용하지 않는다.        |

부분 서식의 글꼴 조건은 명시적인 inline 글꼴을 비교한다. 말풍선의 기본 글꼴을
inline 서식으로 추측해 적용 범위를 넓히지 않는다. 저장된 YAML의 숫자 단위도 바꾸지 않는다.

## 표시와 입력 통일

- 불투명도·장평·신뢰도는 `%`로 표시하며, 입력 시 기존 저장 단위로 변환한다.
- 글자 크기·외곽선·효과 길이는 `px`, 자간은 `em`, 회전은 `°`, 배율은 `×`로 표시한다.
- 조건·부분 서식 조건·적용 값·요약·변경 전후·판정 내역에서 같은 표시 함수를 사용한다.
- 줄바꿈 조건과 결과에서도 실제 서식 선택지의 이름을 사용한다.
- `행간`, `글자 너비`, `불투명도`를 일반 서식의 `줄 간격`, `장평`, `글자 투명도`에 맞췄다.
- 직접 만든 숫자 입력 5개를 공용 `NumberField`로 교체했다. 입력 확정·취소와 범위 처리는 공용 컨트롤이 담당한다.

## 검증

- 프리셋 생성 → 규칙 검증 → 미리보기 → 적용 → 데이터 직렬화와 연속 실행을 연결해 검증했다.
- 동일 값·미지정 값·혼합 서식·기본/사용자 글꼴·미일치 캡처·비활성 단계·용어집 지연/실패/작품 변경을 검증했다.
- 실제 속성 선택 UI에서 기본값과 연관 옵션을 생성하고, 생성된 규칙의 적용 결과를 검증했다.
- 실제 프로덕션 조건·작업·결과 컴포넌트를 `qa:ui`로 1600×980, 1240×760에 캡처했다.
  두 화면을 직접 확인했으며 바깥 스크롤이나 컨트롤 겹침은 없었다. 긴 내용은 각 패널 안에서 스크롤된다.
  임시 QA 엔트리와 PNG는 확인 후 제거했다.
- Impeccable 정적 검사: 변경한 UI 파일 7개에서 탐지 항목 0개.
- 최종 `npm run check`: 전체 26개 단계 통과. 테스트 735개 파일에서 6,274개 통과, 2개 건너뜀, 실패 0개.
  타입 검사·린트·커버리지·빌드·페이지 이미지 동일성·이미지 프로토콜 검증을 포함한다.

정적 전수 대조와 재현 가능한 회귀 검증 결과이며, 모든 사용자 데이터·정규식·글꼴 조합을
실제 실행했다는 의미는 아니다. 이 검사는 기존 저장소 전체 감사와 별도 범위다.

회귀 테스트: `tests/conditionalBatchConsistency.test.tsx`,
`tests/conditionalBatchGlossaryReadiness.test.tsx`, `tests/conditionalBatchRules.test.ts`,
`tests/conditionalBatchSetFieldsEditor.test.tsx`, `tests/conditionalBatchEditor.test.tsx`.

로컬 상세 근거: `.bug-hunter/conditional-batch-20260909/`의 `scope.json`,
`field-matrix.json`, 각 `*-coverage.json`, `findings.json`, `skeptic.json`, `referee.json`.

## 속성 대조 목록

아래 61개는 정적 계약 대조 목록이다. 동적 회귀 시나리오는 위 검증 절에 기록했다.

| 속성                    | 표시 이름          | 기능      | 저장값 해제 |
| ----------------------- | ------------------ | --------- | ----------- |
| `sourceText`            | 원문               | 변경      | 필수값 유지 |
| `translatedText`        | 번역문             | 변경      | 필수값 유지 |
| `fontFamily`            | 글꼴               | 변경      | 가능        |
| `speakerId`             | 화자               | 변경      | 가능        |
| `reviewNote`            | 검수 메모          | 변경      | 가능        |
| `textRole`              | 텍스트 역할        | 변경      | 가능        |
| `fontRole`              | 글꼴 역할          | 변경      | 가능        |
| `sourceDirection`       | 원문 방향          | 조회·검사 | 해당 없음   |
| `renderDirection`       | 출력 방향          | 변경      | 필수값 유지 |
| `textAlign`             | 정렬               | 변경      | 필수값 유지 |
| `wordBreak`             | 줄바꿈             | 변경      | 가능        |
| `reviewStatus`          | 검수 상태          | 변경      | 가능        |
| `confidence`            | OCR 신뢰도         | 조회·검사 | 해당 없음   |
| `fontRoleConfidence`    | 글꼴 신뢰도        | 조회·검사 | 해당 없음   |
| `fontSizePx`            | 글자 크기          | 변경      | 필수값 유지 |
| `lineHeight`            | 줄 간격            | 변경      | 필수값 유지 |
| `letterSpacing`         | 자간               | 변경      | 가능        |
| `fontWidthScale`        | 장평               | 변경      | 가능        |
| `rotationDeg`           | 회전               | 변경      | 가능        |
| `textOpacity`           | 글자 투명도        | 변경      | 가능        |
| `outlineWidthPx`        | 외곽선 두께        | 변경      | 가능        |
| `outlineWidthScale`     | 외곽선 배율        | 변경      | 가능        |
| `outerOutlineWidthPx`   | 바깥 외곽선 두께   | 변경      | 가능        |
| `pageIndex`             | 페이지 순번        | 조회·검사 | 해당 없음   |
| `blockIndex`            | 말풍선 순번        | 조회·검사 | 해당 없음   |
| `lineCount`             | 줄 수              | 조회·검사 | 해당 없음   |
| `sourceLength`          | 원문 글자 수       | 조회·검사 | 해당 없음   |
| `translatedLength`      | 번역문 글자 수     | 조회·검사 | 해당 없음   |
| `bboxWidth`             | 말풍선 너비        | 조회·검사 | 해당 없음   |
| `bboxHeight`            | 말풍선 높이        | 조회·검사 | 해당 없음   |
| `bboxAspectRatio`       | 말풍선 비율        | 조회·검사 | 해당 없음   |
| `textColor`             | 글자색             | 변경      | 필수값 유지 |
| `outlineColor`          | 외곽선색           | 변경      | 가능        |
| `outerOutlineColor`     | 바깥 외곽선색      | 변경      | 가능        |
| `textBackgroundColor`   | 글자 영역 배경색   | 변경      | 가능        |
| `bold`                  | 굵게               | 변경      | 가능        |
| `italic`                | 기울임             | 변경      | 가능        |
| `underline`             | 밑줄               | 변경      | 가능        |
| `strikethrough`         | 취소선             | 변경      | 가능        |
| `emphasisMark`          | 강조점             | 변경      | 가능        |
| `textBackgroundEnabled` | 글자 영역 배경     | 변경      | 가능        |
| `autoFitText`           | 자동 맞춤          | 변경      | 가능        |
| `inpaintExcluded`       | 인페인팅 제외      | 변경      | 가능        |
| `hasInlineStyle`        | 부분 서식 있음     | 조회·검사 | 해당 없음   |
| `hasSpeaker`            | 화자 있음          | 조회·검사 | 해당 없음   |
| `hasGlossary`           | 용어 연결 있음     | 조회·검사 | 해당 없음   |
| `textEffectEnabled`     | 그림자 사용        | 변경      | 가능        |
| `textEffectColor`       | 그림자색           | 변경      | 가능        |
| `textEffectOffsetX`     | 그림자 가로 위치   | 변경      | 가능        |
| `textEffectOffsetY`     | 그림자 세로 위치   | 변경      | 가능        |
| `textEffectBlur`        | 그림자 흐림        | 변경      | 가능        |
| `textEffectOpacity`     | 그림자 불투명도    | 변경      | 가능        |
| `textGlowEnabled`       | 광선 사용          | 변경      | 가능        |
| `textGlowColor`         | 광선색             | 변경      | 가능        |
| `textGlowBlur`          | 광선 퍼짐          | 변경      | 가능        |
| `textGlowOpacity`       | 광선 불투명도      | 변경      | 가능        |
| `sameAsSource`          | 원문과 동일        | 조회·검사 | 해당 없음   |
| `numberMismatch`        | 숫자 불일치        | 조회·검사 | 해당 없음   |
| `unbalancedPunctuation` | 괄호·따옴표 불균형 | 조회·검사 | 해당 없음   |
| `suspiciousWhitespace`  | 의심스러운 공백    | 조회·검사 | 해당 없음   |
| `glossaryMismatch`      | 용어집 불일치      | 조회·검사 | 해당 없음   |

## 전체 읽은 소스 목록

```text
src/main/conditionalBatchSchemeStore.ts
src/main/ipc/conditionalBatchIpc.ts
src/renderer/src/api/conditionalBatchGateway.ts
src/renderer/src/app/session/createConditionalBatchEditorProps.ts
src/renderer/src/components/ConditionalBatchActionCard.tsx
src/renderer/src/components/ConditionalBatchAdvancedTools.tsx
src/renderer/src/components/ConditionalBatchConditionsCard.tsx
src/renderer/src/components/ConditionalBatchControls.tsx
src/renderer/src/components/ConditionalBatchEditor.tsx
src/renderer/src/components/ConditionalBatchFooter.tsx
src/renderer/src/components/ConditionalBatchPreviewPane.tsx
src/renderer/src/components/ConditionalBatchRecipePicker.tsx
src/renderer/src/components/ConditionalBatchResultsCard.tsx
src/renderer/src/components/ConditionalBatchRulePanel.tsx
src/renderer/src/components/conditionalBatchRulePanelTypes.ts
src/renderer/src/components/ConditionalBatchSchemeManager.tsx
src/renderer/src/components/ConditionalBatchSequenceForm.tsx
src/renderer/src/components/ConditionalBatchSequenceManager.tsx
src/renderer/src/components/conditionalBatchSequenceModel.ts
src/renderer/src/components/ConditionalBatchSetFieldPicker.tsx
src/renderer/src/components/ConditionalBatchSetFieldsEditor.tsx
src/renderer/src/components/conditionalBatchSetFieldsModel.ts
src/renderer/src/components/conditionalBatchUi.ts
src/renderer/src/components/ConditionalPatternBuilder.tsx
src/renderer/src/components/useConditionalBatchEditorModel.ts
src/renderer/src/components/useConditionalBatchSchemeController.ts
src/renderer/src/components/useConditionalBatchSequenceEditor.ts
src/renderer/src/components/useConditionalBatchTypography.ts
src/renderer/src/lib/conditionalBatchTypography.ts
src/shared/conditionalBatchEngine.ts
src/shared/conditionalBatchErrorPresentation.ts
src/shared/conditionalBatchExchangeTypes.ts
src/shared/conditionalBatchFieldRegistry.ts
src/shared/conditionalBatchRules.ts
src/shared/conditionalTextPattern.ts
src/shared/ipcConditionalBatchContracts.ts
```
