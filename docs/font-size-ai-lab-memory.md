# 글자 크기 AI · HayaiOCR 실험 씨육수 노트

최종 정리: 2026-09-02 KST
작업 브랜치: `codex/font-size-ai-lab-20260902-r1`
작업 워크트리: `C:\Users\sam40\Downloads\망가번역기-font-size-ai-lab-20260902-r1`
현재 내부 실험 버전: `fsai-lab-v0.4.0` (v0.2.3의 효과음 누적 인페인팅·자동 맞춤
기본값과 v0.3.0의 peer-gated 하향 교정 위에, 후보 자체의 반복 component/major-axis
증거로만 낮은 오추정을 복구하는 peer-gated 상향 교정을 반영)

이 파일은 성공·실패·애매한 결과를 계속 증류하는 단일 판단 노트다. 상세 원시 수치와
이미지는 화별 HTML 보고서에 두고, 여기에는 다음 실험에서 같은 실수를 막는 데 필요한
결론·조건·반례·승격 상태만 남긴다. 내용이 길어지면 중복 경과를 합치되 실패 조건과
근거 링크는 지우지 않는다.

## 고정 실험 규칙

1. 원본은 `C:\Users\sam40\AppData\Local\Tachidesk\downloads\mangas`에서만 읽는다.
   원본·보관함·기존 출력물은 수정하거나 정리하지 않는다.
2. 설정 경로는 항상 `ocrPipeline=hayai`, managed provider는 `hayai-regions`로 고정한다.
   일반 텍스트 사각형은 Koharu detector 후처리, 문자열 판독은 HayaiOCR 결과를 쓴다.
3. 후보 화 목록과 제외 목록을 먼저 정렬·해시한 뒤 암호학적 난수 seed로 한 화를 봉인한다.
   이미 본 화는 결과가 실패했거나 실행이 중단됐어도 다시 쓰지 않는다.
4. 한 화에서 비교하는 제품 가설은 최대 5개다. 같은 조합의 계수만 미세하게 돌리는 것은
   별도 가설로 부풀리지 않는다.
5. 각 페이지 전체 bbox 오버레이를 보고, bbox마다 원본 해상도 확대 crop을 하나씩 확인한다.
   누락·과병합·과분할·글자 절단·과도한 여백을 기록한다.
6. 화가 끝나면 실제 이미지를 포함한 self-contained HTML 보고서를 만든다. 다음 화를
   고르기 전에 이 노트와 사용 화 레지스트리를 갱신한다.
7. 명확한 개선만 내부 버전을 올리고 앱 기본 동작에 반영한다. 애매한 결과는 승격하지
   않으며 장점·단점·적용 가능 범위를 모두 기록한다.
8. 한 화에서 5개 가설을 소진하고도 큰 개선이 없으면 즉시 수백 건 규모 상세 조사로
   전환한다. 검색식, 중복 제거 수, 1차 자료, 채택 가설, 실제 적용 결과를 연결한다.
9. 효과음/FX bbox는 사용자가 별도 선택 흐름으로 처리하므로 이 캠페인의 판정·지표·수정
   대상에서 제외한다. 일반 대사/텍스트 bbox와 글자 크기만 제품 승격 근거로 사용한다.

## 데이터 권위

- 사용자 첨부 사례와 과거 보관함 결과는 **고정 진단용**이다. 후보를 고르거나 승격률을
  계산하는 human gold가 아니다.
- `docs/font-matching-v2-production-handoff.md`의 v11 수동 감사는 evaluation-only다.
- 1,347개 direct visual label은 training-only다.
- 2026-08-31 Koharu 180장 v11은 기하 회귀 참고용이며 별도 수동 gold가 아니다.
- 새 랜덤 화의 자동·수동 판정도 이 캠페인에서 본 뒤에는 다음 모델 선택용 locked test로
  재사용하지 않는다.

## 2026-09-02 사용자 첨부 사례에서 확정한 실패

고정 진단 화:
`RawINU (JA)/BUCHI KIRE REIJO HA HOFUKU WO CHIKAIMASHITA. MA SHIRUBE SHO NO CHIKARA/Chapter 31`
페이지 `004.jpg`. 새 랜덤 실험에는 사용하지 않는다.

- 원본의 `あれ?`와 `私たち地下に潜ってたッスよね?`는 육안상 거의 같은 본문 크기다.
- `あれ?`는 `sourceFontFacePx=21.5624`, confidence `0.9055`로 측정됐다.
- 아래 3열 대사는 Hayai/Koharu가 하나의 105×189px 영역과 candidate 하나로 고정했다.
  Paddle 계열처럼 열별 `sourceFontLineGeometry`가 없었다.
- production raster-core는 15 glyph에서 3열을 예상했지만 binary cross-profile을
  `[5,25]`, `[35,90]`, `[101,105]`로 잘못 나눴다. 열 face가 `[20,53,4]`, 상대
  dispersion `0.8`이 되어 안전하게 abstain했다.
- 그 결과 아래 블록에는 source-face 증거가 없고 12px fallback만 남았다. 위 블록은
  source-match 역산이 작동해 첨부 이미지처럼 같은 원문 크기가 크게 갈라졌다.

따라서 현재 핵심 병목은 “전역 최소 글자 크기 부족”이 아니라 **Hayai의 하나짜리 다열
영역 안에서 열 geometry를 안정적으로 다시 얻지 못하는 것**이다.

### 추가 고정 진단 · 매우 좁고 긴 세로 원문

사용자 첨부: `神の慈悲により → 신의 자비로`. 무작위 실험 화가 아니라 사용자가 앱에서
직접 발견한 회귀 진단이다. 원본 첨부 SHA-256은
`93982a8f0bd08f5e04073641a94d0817e998f88817722c14333acae2a2620e51`이며,
`artifacts/font-size-ai-lab/fixed-diagnostics/narrow-tall-missing-face-2026-09-02/`
아래에 보존한다.

- 실제 블록은 normalized bbox `x=196, y=590.43, w=73, h=158.34`, 세로 원문·가로 번역,
  `fontSizeIntent=source-match`, `autoFitText=false`였다.
- 이 블록만 `sourceFontFacePx`가 없었다. 같은 페이지의 정상 세로 대사 측정값은
  `19.624/20.821/20.264/19.630/20.880/26.359px`였지만, 기존 fallback 생성기는
  **측정값이 있는 동시에 geometry가 의심스러운 블록**만 대상으로 삼아 완전 누락을
  제외했다. 그래서 기본 `12px`가 그대로 렌더됐다.
- 해결: source-match 일반 대사이면서 원문 방향·2글자 이상 증거가 있는 완전 누락에도,
  같은 원문 방향 → 같은 font role → 같은 굵기 순으로 좁힌 신뢰 peer median을 허용한다.
  페이지 전체 글자 크기를 무차별 복사하지 않으며 효과음은 제외한다.
- 실제 production `PageArtwork` 전/후 QA에서 `12px → 21px`로 회복했다. 1000×760과
  620×900 뷰포트 모두 잘림·겹침·가로 오버플로가 없었다. 회귀 테스트는
  `tests/sourceFontSizeCap.test.ts`의 실제 bbox/문자열 fixture로 잠갔다.
- 이 보수적 누락 경로는 기존 측정값을 덮지 않고 고정 반례를 명확히 개선했으므로 내부
  patch 버전을 `fsai-lab-v0.1.1`로 올렸다.

### 앱 UI 회귀 · 서식의 글자 크기 +/-가 화면에 반영되지 않음

- 사용자 실기 확인에서 `텍스트 블록 > 서식 > 크기`의 증감 버튼을 눌러도 AI 맞춤
  블록의 화면 크기가 변하지 않았다.
- 원인은 두 겹이었다. 증감 로직이 저장된 fallback 크기만 바꾸고
  `fontSizeIntent=source-match`를 유지해 source-face 값이 계속 우선했고, 수동 0.5px 값도
  layout에서 정수로 내림되어 첫 클릭이 사라졌다.
- 해결: 첫 증감의 기준을 저장 fallback이 아니라 현재 실제 렌더 크기로 잡고, 그 즉시
  `fontSizeIntent=manual`, `autoFitText=false`로 전환한다. 수동 고정 크기는 소수 px를
  보존하며 auto-fit 탐색만 기존 정수 단위를 유지한다. 미리보기 layout 재사용 조건에도
  font-size intent를 포함했다.
- 숫자 직접 입력뿐 아니라 단일/다중 증감, 서식 일괄 적용, 모아보기 직접 서식,
  곡선 넘침 축소와 블록 보관함 편집도 명시적 수동 크기 우선권을 갖도록 맞췄다.
- 실제 production `EditorPanel`과 `PageArtwork`를 결합한 자동 클릭 QA에서 시작 45.0px,
  첫 `+` 45.5px, `+` 8회 후 `-` 1회 48.5px, intent `manual`을 확인했다. 1440×900과
  620×900 모두 잘림·겹침·가로 오버플로가 없었다. 관련 98개 회귀 테스트, typecheck,
  Electron/page-export compile을 통과했으므로 내부 patch 버전을 `fsai-lab-v0.2.1`로
  올렸다.

### 앱 UI 회귀 · 자동 맞춤 실제 px 대신 12px seed만 표시

- 사용자 실기 확인에서 크기 변경 자체는 다시 작동했지만, 자동 맞춤 블록의 서식 숫자 칸은
  캔버스가 실제로 렌더하는 크기와 무관하게 저장 fallback `12px`만 표시했다.
- 원인은 캔버스가 page scale에서 auto-fit/source-match 레이아웃을 계산하는 반면,
  `EditorFormatGroups`는 계산 결과를 받지 않고 `block.fontSizePx`만 읽은 데 있었다.
- 해결: 증감 동작과 서식 패널이 동일한 natural-page layout resolver를 공유한다. 메인·분리
  패널 모두 현재 폰트 catalog와 페이지별 신뢰 OCR peer fallback을 사용해 실제 base px를
  표시한다. 자동을 끌 때도 표시 중인 실제 px를 `manual` 값으로 저장해 12px로 튀지 않는다.
- production `EditorPanel`+`OverlayText` QA에서 저장 seed `12px`, 실제 page `63px`일 때
  숫자 칸이 `63px`로 표시됨을 1180×760과 700×980에서 확인했다. 잘림·겹침·패널 가로
  overflow는 없었다. 관련 회귀 74개, typecheck, lint, renderer/Electron build를 통과해
  내부 patch 버전을 `fsai-lab-v0.2.2`로 올렸다.

### 효과음 후속 처리 회귀 · 기존 대사 인페인팅이 원본으로 되돌아감

- 일반 대사 인페인팅이 끝난 페이지에 효과음 번역 블록을 추가하면 completion receipt가
  `pending`으로 바뀌었다. 효과음 전용 인페인팅은 이를 새 전체 작업으로 오인해 기존
  inpainted image가 아니라 원본 이미지를 베이스로 열었다. 결과적으로 선택한 효과음은
  지워졌지만 기존 대사 원문이 전부 되살아났다.
- 해결: 효과음 전용 targeted pass는 저장된 inpainted image 위에만 누적한다. 기존에
  지운 block id를 보존하고 새 효과음 id를 합쳐 completion receipt를 다시 완성한다.
  픽셀 회귀 테스트에서 효과음 마스크 밖의 기존 정리 픽셀 `[41,42,43]`이 출력에도
  동일하게 남는 것을 확인했다.
- 새로 번역되는 효과음 블록은 보수적인 seed 크기에 고정되지 않도록 `autoFitText=true`를
  기본값으로 사용한다. 스샷의 `크기 > 자동`이 처음부터 켜지고, 이후 사용자가 숫자를
  직접 바꾸면 기존 계약대로 수동 크기로 전환된다.
- 관련 효과음/인페인팅 47개 회귀 테스트, typecheck, lint, production build를 통과해
  내부 patch 버전을 `fsai-lab-v0.2.3`으로 올렸다. 이미 잘못 덮인 사용자 산출물은 자동
  재작성하지 않으며 별도 복구 실행 전 원본·현재 결과를 보존한다.

## 반복 금지 조합

| 조합                                                         | 반복하지 않는 이유                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 전역 `min 16px`·`min 14px`                                   | 실제 후리가나·속삭임·측면 광고의 정답인 작은 글씨를 망친다.                                                                                                |
| merged bbox의 짧은 축/면적을 바로 글자 크기로 사용           | 행간·말풍선 여백·여러 열 때문에 양방향 큰 오차가 이미 확인됐다.                                                                                            |
| Koharu 채움 마스크 두께를 font-size로 사용                   | 마스크는 glyph 획이 아니라 문장/열 영역을 채우는 사례가 있다.                                                                                              |
| Hayai confidence 하나로 bbox trim/삭제                       | 실제 글자도 0.28까지 낮고 그림 오검출은 0.94까지 높았다.                                                                                                   |
| Sauvola/Niblack만 교체                                       | 배경 후보에는 도움되지만 geometry 붕괴 자체를 해결하지 못했다.                                                                                             |
| 일반 VLM에 px 직접 회귀                                      | 절대 좌표 손실·비결정성·typography 인식 약점에 비해 현재 문제와 맞지 않는다.                                                                               |
| raw bbox/글자 수 fallback을 무조건 적용                      | 과거 합성 P90 오차가 59%를 넘었다. abstain보다 위험하다.                                                                                                   |
| page-wide 대화 median을 모든 누락 블록에 복사                | 강조·속삭임 계층을 지운다. 방향→역할→굵기 peer가 있는 source-match 누락만 허용한다.                                                                        |
| repulsive valley로 duplicate graph union을 차단              | 상위 복합 mask는 남고 내부 조각도 별도 출력돼 같은 문구를 중첩 번역하는 과분할이 생겼다.                                                                   |
| 미검증 formula 열 수로 component graph를 먼저 분할           | 실제 열 수가 다르면 인접 열을 합쳐 face가 약 1.44~1.57배가 되고 정상 projection까지 포기한다.                                                              |
| component/major 두 값이 대략 비슷하다는 이유만으로 상향 보정 | 캠페인 001 P009/D004·P032/D007에서 정상 projection을 1.35~1.43배 키웠다. 상향은 두 독립값 비율 1.12 이하와 projection line-fill 0.55 미만을 함께 요구한다. |
| 후보 자체 증거 없이 page peer만 복사하는 하향 clamp          | 작은 속삭임·큰 강조 계층을 평준화한다. peer는 안정성 gate로만 쓰고 후보 자체의 반복된 낮은 mode가 있어야 한다.                                             |
| gate 없는 cross-hypothesis lattice                           | 캠페인 003에서 정상 본문까지 21개를 줄여 같은 글꼴 불일치를 0.0919→0.0962로 악화시켰다. 안정 peer와 독립적인 자기 증거 없이 재시도하지 않는다.             |
| near-square bbox를 전부 세로 원문으로 뒤집기                 | 캠페인 004 P005/D003은 `23.7636→24.50px`뿐이었고 P004/D002는 `30.387→23.34px`로 오히려 작아질 위험이 있었다. 방향 반전은 해결책이 아니다.                  |
| 후보 자체 mode 없이 page peer를 복사하는 상향 clamp          | 실제 작은 글씨와 강조 계층을 평준화할 수 있다. 상향도 후보 자신의 component와 여러 line-count의 major-axis mode가 반복될 때만 peer를 수락 gate로 쓴다.     |

## 다음 가설 우선순위

1. 다음 미사용 랜덤 화에서 v0.4.0을 기준선으로 전 페이지·전 일반 대사 crop 감사한다.
   하향·상향 peer gate의 변경 수가 적더라도 정상 hierarchy와 과거 706개 exact expectation을
   먼저 보존한다.
2. 캠페인 004 `P009/D008`처럼 반복된 낮은 projection은 있지만 손글씨·긴 다열 구조 때문에
   상향/하향 어느 쪽도 안전하지 않은 사례는 text-island/line ownership으로 접근한다. page
   peer 값을 강제로 복사하지 않는다.
3. 캠페인 004 `P004/D001-D002`, `P010/D001-D002`, 캠페인 003 `P003/D009`,
   `P005/D005`의 병합·겹침·분할은 owner-aware 상호 배타적 cluster partition으로 검토한다.
   단순 valley veto로 parent와 child가 동시에 남았던 과거 중복 실패를 먼저 회귀로 막는다.
4. 캠페인 003 `P013/D011`과 캠페인 004의 잘린/split bbox는 crop 경계 stroke 접촉과 소량
   확장 후 containment를 별도 평가한다. 폰트 크기 보정으로 bbox 결함을 숨기지 않는다.

초기 H1~H4의 채택·실패 조건은 아래 캠페인 001/002 절에 역사로 보존한다. 현재 우선순위는
캠페인 004에서도 남은 불규칙·손글씨 다열 원문, 병합/겹침, 경계 절단 세 축이다.

## 캠페인 001 · 실험 1 기준선에서 증류한 사실

봉인 화: `Rawkuma (JA)/Ossan, Tensei shite Tensai Yakusha ni Naru/Chapter 28.2`

- 32페이지 전체 오버레이 32장, 일반 대사 crop 230장, 효과음 crop 114장을 각각 확대해
  전부 열어 봤다. 자동 source-face는 198건 적용, 32건 abstain이었다.
- 같은 본문 글꼴인데 측정값이 갈린 고정 비교군은 P008 D003-D006, P010 D002/D004/D005,
  P015 D003-D006, P016 D002/D004, P019 D004-D007, P032 D002/D003,
  P032 D006/D007이다. 이후 이 화의 수치를 보고 계수를 맞추지 않고 회귀 sentinel로만 쓴다.
- 가장 강한 재현은 P032 D002/D003의 31.6px 대 18.4px다. 같은 생각 말풍선의 인접 열이며
  사용자 첨부 사례와 동일한 유형이다. P015 D003-D006도 42.4/28.7/26.0/abstain으로 갈렸다.
- 반대로 P022 D008(약 15px), P029 D007(약 14.5px)은 실제로 작은 글씨다. 같은 크기로
  평준화하거나 전역 최소값을 올리는 해법은 이 두 sentinel에서 즉시 탈락시킨다.
- 심각한 일반 대사 bbox는 P011/P023/P025/P027/P031의 다중 mask 패널 횡단 union과
  P024/P030의 단일 mask 패널 횡단 사례로 나뉜다. 둘을 같은 작은 threshold tweak으로
  해결하려 하지 않는다.
- `카타카타`류처럼 dialogue/effect 양쪽에 중복되거나 효과음이 dialogue로 들어간 사례도
  확인했다. 다만 글자 크기와 panel ownership을 먼저 해결하고 분류 중복은 별도 평가한다.
- 실험 1은 문제를 명확히 재현했지만 제품보다 좋아진 것이 없으므로 승격하지 않는다.
  내부 버전은 `fsai-lab-v0.0.0` 그대로다.

원시 판정과 candidate ID는
`artifacts/font-size-ai-lab/campaign-001/exp-01-production-baseline/visual-audit.json`이
권위다.

## 캠페인 001 · 실험 2~5에서 증류한 사실

### 실험 2 · density-valley bands

- binary zero-gap run이 무너질 때 가중 projection cluster와 density valley로 열을 복원했다.
- 적용률은 `0.8609 → 0.9043`, 같은 글꼴 점수는 `0.3315 → 0.1963`으로 좋아졌고,
  사용자 고정 진단의 아래 3열 대사는 `22.009px`로 복구돼 위 `21.5624px`와 맞았다.
- 하지만 crop 가장자리 satellite/ruby가 남아 P006 같은 큰 outlier를 해결하지 못했다.
- 결론: density valley는 유효한 fallback이지만 단독 승격하지 않는다.

### 실험 3 · 95% dense-mass trim

- 각 band의 가장 짧은 95% 투영 질량 span을 사용해 P006 D006을 `36.9 → 25.2px`로 고쳤다.
- 점수는 `0.1391`, 적용률은 `0.9087`로 더 좋아졌다.
- 반례 P013 D005에서는 ruby/satellite가 95% 질량 안에 남아 `33.8 → 41px`로 악화됐다.
- 반복 금지: **고정 95% 질량을 본문 core로 간주하지 않는다.** 두 high mode와 한 low mode의
  median도 본문이라는 보장이 없다.

### 실험 4 · 85% dominant-column core

- 열마다 연속된 85% 주질량 구간을 찾고 `1/0.85`로 face를 복원했다. 15% 이하의 ruby와
  satellite mode는 본문 core에서 제외하되 작은 글자 자체를 전역으로 버리지는 않는다.
- 같은 글꼴 점수 `0.0981`, 적용률 `0.9043`, 비교군 coverage `1.0`, 작은 글자 퇴행 `0`.
- P006 D003/D005/D006은 `22.1/20.9/23.3`, P013 D005는 `41 → 28.2`,
  P032 D002/D003은 `18.50/20.25`가 됐다.
- 결론: 캠페인 001의 글자 크기 승리 경로. 다음 미사용 화에서 유지되는지 반드시 본다.

### 실험 5 · robust mask + ownership-preserving bbox

- text mask 양끝 0.5% quantile tail은 raw/robust box 면적 개선이 1.25배 이상일 때만 잘랐다.
  confidence로 자르지 않는다.
- page 면적 5.5% 이상, grid density 4% 이하, bubble/panel mask support 25% 미만을 모두
  만족한 broad sparse proposal만 거부했다. 이 화에서는 P023 T026 한 건만 해당했다.
- bubble owner 또는 고유 free owner를 보존했다. lossless cut이 없더라도 서로 다른 owner의
  dialogue를 파괴적 union하지 않았다.
- bbox containment만으로 nested text를 지우지 않고 mask overlap을 요구한다. 감사에서 발견한
  P014 판매문구 이중 검출은 `box containment ≥ 0.8`와 `smaller-mask overlap ≥ 0.9`라는 강한
  픽셀 근거로만 접었다.
- 결과는 dialogue `230 → 258`, 심각한 최대 page-area bbox는 P011 `.3654 → .0330`,
  P025 `.2771 → .0308`, P027 `.1947 → .0330`, P030 `.1583 → .0177`,
  P031 `.2168 → .0180`으로 줄었다.
- 새/변경 bbox 82개를 원본 해상도 확대 검사했고 중복 한 건을 고친 뒤 81개를 재검증했다.
  나머지 80개 이미지는 이전 감사와 SHA-256이 동일했다. 기존 정상 177개는 기준선 감사로
  연결돼 최종 258개 전부 사람이 본 상태다.
- 실제 HayaiOCR CUDA/cu126를 32페이지에 다시 실행했다. manifest는 replay와 32/32 byte-level
  구조가 같았고, 빈 OCR 0, `258/258` 처리, source-face `248`, abstain `10`이었다.
- 결합 점수는 coverage `0.9612`, 같은 글꼴 불일치 `0.0994`, 비교군 coverage `1.0`,
  작은 글자 퇴행 `0`이다.

## 캠페인 001 승격과 남은 위험

- 글자 크기 `dominant-column core`와 bbox `robust tail + ownership + pixel-overlap duplicate`를
  제품 경로에 반영하고 내부 버전을 `fsai-lab-v0.1.0`으로 올렸다.
- 명확한 승격 근거는 기준선 대비 같은 글꼴 불일치 약 70% 감소, 적용률 10.03%p 상승,
  심각한 패널 횡단 bbox 7개군 개선, 작은 글자 퇴행 0, 실제 HayaiOCR 완주다.
- 광고 띠·작가명·페이지 번호도 dialogue 후보로 남는 사례가 있다. 이는 합침보다 안전하지만
  semantic filtering 문제이며, confidence-only 삭제로 되돌리지 않는다.
- 대사/효과음 중복 분류는 이번 승격의 해결 범위 밖이다.
- 다음 미사용 화에서 나빠지면 v0.1.0의 해당 부분을 조건부 적용으로 축소하거나 되돌린다.

## 200개 검색 뒤 추가한 다음 가설

상세 근거와 정확한 질의 manifest는 `docs/font-size-ai-lab-research-2026-09-02.md`와
`artifacts/font-size-ai-lab/research-2026-09-02/query-manifest.json`이 권위다.

1. `R1` — 85% projection core와 connected-component affinity graph가 각각 face를 추정하고,
   둘이 합의할 때만 신뢰도를 올린다. component 높이/폭 scale, 방향축 간격, 직교축 겹침으로
   본문 최대 일관 군집과 ruby secondary scale을 분리한다.
2. `R2` — bbox는 같은 owner/high mask overlap을 양의 link, 다른 owner/repulsive valley를
   음의 link로 하는 instance graph를 만들고 작은 core에서 완전 mask로 확장한다. 단,
   아래 잠긴 회귀에서 단순 음의-link union 차단은 폐기됐다. 재시도하려면 상위 composite를
   남겨 둔 채 child를 추가하지 않는 **상호 배타적 mask partition/suppression** 계약이 먼저다.
3. `R3` — 누락·과병합·과분할·대사/효과음 중복·잘림·ruby 혼합·작은 글자 퇴행을 별도
   metric으로 유지한다. 하나의 IoU나 적용률로 합치지 않는다.

반복 금지에 추가: morphology로 작은 component 전부 삭제, 고정 95% mass, bbox containment만
쓴 nested suppression, 새 모델을 검증 없이 Koharu와 즉시 교체.

### R2 사전 회귀에서 폐기한 조합 · 실험 횟수 미차감

캠페인 002 이미지를 보기 전에, 잠긴 캠페인 001의 32페이지 Koharu capture로
`eroded core + positive/repulsive instance graph`를 사전 재생했다. 이 검증은 새 화의
제품 가설 실험이 아니므로 캠페인 002의 5회에는 넣지 않는다.

- 최초 재생은 dialogue `258 → 274`, 변경 candidate `28`, 변경 페이지 `9`, repulsive
  merge skip `23`이었다.
- 변경된 전체 페이지 9장과 old/new 확대 crop 28쌍을 전부 확인했다. P014/P028 일부처럼
  광고 띠를 의미 단위로 잘 나눈 이점도 있었지만, P001/P002 게시판과
  P007/P015/P020/P021/P024 측면 광고에서는 상위 전체 bbox가 그대로 남으면서 내부 child
  bbox가 추가됐다. 결과적으로 같은 글자를 겹쳐 OCR·번역하는 명백한 퇴행이다.
- 원인은 음의 edge가 union만 막을 뿐, 양쪽 child를 모두 덮는 composite proposal의
  픽셀을 어느 쪽에 배정하거나 parent를 억제하지 못한 데 있다. 빈 valley 자체는 분리
  근거가 될 수 있어도 출력 partition 계약 없이 hard veto로 쓰면 안 된다.
- 해당 hard veto·eroded-core graph를 제품 코드에서 제거했다. v0.1.0의
  `robust tail + ownership + pixel-overlap duplicate`만 보존한 재생은 `258 → 258`, 변경 `0`,
  broad sparse reject `1`, ownership overlap skip `4`로 exact parity를 회복했다.
- 상세 판정은
  `artifacts/font-size-ai-lab/campaign-002/preflight-r2-locked-regression.json`, 실패 출력은
  `artifacts/font-size-ai-lab/campaign-001/v0.1.1-regression-replay/`, 최종 parity 출력은
  `artifacts/font-size-ai-lab/campaign-001/v0.1.1-regression-replay-r3/`가 권위다.

## 캠페인 002 · 실험 1에서 증류한 사실

봉인 화: `RawINU (JA)/TENSEI RENKIN SHOUJO NO SLOW LIFE/Chapter 2`

- 32/32 전체 페이지 오버레이와 일반 텍스트 crop 297/297을 원본 해상도로 개별 확인했다.
  사용자가 효과음은 별도 사용자 선택 흐름이라고 확정했으므로 FX 52개는 이후 모든 판정,
  지표, 수정에서 제외한다.
- v0.1.1 projection-only는 `277/297`을 측정했다(coverage `0.9327`). R1 component-affinity는
  `252/297`만 측정했다(`0.8485`): 새 abstain 25, 복구 0이다.
- 원인은 component graph 자체보다 **검증되지 않은 formula 열 수로 먼저 band를 고정한 순서**다.
  실제 열보다 적게 가정하면 인접 열 전체 폭을 한 body face로 보고 projection의 약
  `1.44~1.57배`를 주장했다. P009 D005, P014 D002, P021 D003, P028 D007, P029 D013 같은
  정상·좁은 대사를 오히려 포기했다.
- 따라서 R1은 실패로 봉인하고 앱 기본 경로에서 opt-in 실험으로 분리했다. 내부 버전은
  `fsai-lab-v0.1.1`을 유지한다. 같은 조합의 threshold만 바꿔 재시도하지 않는다.
- 새 locked same-font 비교군은 P009, P015, P018, P027, P028이며 작은 글자 sentinel은
  P010 D002, P028 D007, P029 D013, P031 D007이다. 상세 ID와 육안 판정은
  `artifacts/font-size-ai-lab/campaign-002/visual-audit.json`이 권위다.
- 일반 텍스트 bbox의 명확한 구조 문제는 P003 D001, P013 D001, P029 D012와 P031
  D006/D007 경계다. threshold-only 분할은 캠페인 001/002의 중복 실패를 반복할 수 있어
  글자 크기 실험과 분리해 보존한다.
- 고정 `神の慈悲により` 진단에서 formula는 2열을 골라 abstain하지만 1열 가설은
  `30.58px`로 복구된다. 신뢰 peer 중앙값 `20.8px`보다 과대이므로 **복구 성공만으로
  승격하지 않고, 같은 방향 peer 합의까지 요구**한다.

## 캠페인 002 · 실험 2에서 증류한 사실

### 세 방향 geometry 합의

- 한 crop에서 서로 다른 오류 모드를 가진 세 측정값을 분리했다: 짧은 축의 dominant
  projection, 연결 성분의 body face, 쓰기 축의 glyph-run pitch. formula 열 수가 틀리더라도
  projection 하나를 버리지 않고, 독립 측정 둘이 강하게 합의할 때만 수정한다.
- 8글자 미만은 표본 부족으로 기존 projection을 보존한다. major band 최대/최소가 2배를
  넘는 혼합 크기 블록도 보존한다. 상향 보정은 component/major 비율 `≤1.12`와 기존
  projection line-fill `<0.55`를 모두 만족해야 한다. 하향 보정과 abstain 복구는 세 값의
  최대/최소 비율 `≤1.30`을 요구한다.
- 일반 대사 297개에서 projection-only 대비 실제 변경은 6개뿐이었다. P007 D004
  `28.0479→20.3803`, P007 D006 `25.7119→18.5461`, P008 D004
  `13.5586→19.38`, P017 D008 `14.7303→19.5084`, P018 D003
  `32.1754→19.3854`, P029 D001 `abstain→19.38`이다. 여섯 crop과 인접 본문을 다시
  확대해 모두 방향이 맞음을 확인했다.
- 적용률은 `277/297 (0.9327) → 278/297 (0.9360)`, locked same-font 불일치는
  `0.1543 → 0.1340`으로 약 13.2% 감소했다. 비교군 coverage는 `1.0`, 작은 글자
  regression penalty는 `0`이다.
- 첫 상향 gate는 캠페인 001 P009 D004와 P032 D007을 잘못 키워 폐기했다. 강화한 gate로
  캠페인 001 실제 Hayai 결과 258개를 재평가하자 `248/258`, score `0.0994`, group
  coverage `1.0`, 작은 글자 penalty `0`이 v0.1.1과 정확히 같아졌다.
- 따라서 세 방향 합의를 raster-core 기본 경로에 반영하고 내부 minor 버전을
  `fsai-lab-v0.2.0`으로 올렸다. R1 component-first hard abstain은 계속 opt-in 실패
  실험으로 남기며 다시 섞지 않는다.
- 권위 결과는 `artifacts/font-size-ai-lab/campaign-002/exp-02-three-geometry-consensus/`
  의 `module-evaluation-r3.json`, `evaluation-r6.json`, `verdict.json`과 캠페인 001의
  `source-size-evaluation-v0.2.0-regression-r2.json`이다.

## 캠페인 003 · peer-gated cross-hypothesis 승격

봉인 화:
`Rawkuma (JA)/Isekai Tensei Reijou, Shuppon Suru/Chapter 4`

- HayaiOCR CUDA/cu126로 21페이지를 실행했다. 전체 페이지 오버레이 21/21과 일반 대사
  crop 151/151을 각각 원본 확대 확인했고, 일반 대사 151개 중 146개를 측정했다. 효과음
  42개는 사용자 별도 선택 흐름이므로 모든 판정·지표에서 제외했다.
- 실험 1 기준선의 같은 글꼴 불일치는 `0.0919`, hierarchy penalty는 `0`이었다. 주요 높은
  오추정은 분리 cluster, 가로 다행, 불규칙/산개 원문, 좁고 긴 다열 원문에서 나왔다.
- 실험 2의 gate 없는 cross-hypothesis lattice는 21개를 바꿨지만 정상 본문도 함께 줄여
  score를 `0.0962`로 악화시켰다. 이 조합은 폐기했다. threshold만 조절해 반복하지 않는다.
- 실험 3은 페이지의 안정적인 같은-tier peer가 3개 이상일 때만 후보를 심사한다. 실제
  교정값은 peer 중앙값을 복사하지 않고, 후보 자신의 projection/component/major-band가
  ±2 line-count 가설에서 반복해 만드는 낮은 mode만 쓴다. 기존 confidence `≥0.75`, glyph
  `≥8`, 독립 source, 의심 geometry 등의 gate를 모두 통과해야 하향한다.
- 실험 3의 실제 변경은 6개다:
  `P003/D009 37.8059→24.48`, `P004/D013 39.8908→23.46`,
  `P005/D003 31.5459→24.582`, `P008/D006 38.8677→29.8701`,
  `P010/D006 34.014→26.0819`, `P013/D009 29.7959→20.4`.
  coverage는 `146/151` 그대로고 score는 `0.0604`로 개선됐으며 hierarchy penalty는 `0`이다.
- `P004/D011 13.535px`, `P013/D013 12.7804px`의 작은 tier와
  `P003/D011 33.0781px`, `P017/D001 48.6492px`의 큰 tier는 그대로 보존됐다.
  `P008/D001 36.1719px`은 높아 보이지만 후보 자체의 반복된 낮은 mode가 부족해 일부러
  손대지 않았다. peer-only 강제 clamp를 막는 보수적 반례다.
- 실험 4는 실험 계산을 제품 코드에 넣은 뒤 같은 21페이지를 실제 제품 page estimator로
  다시 실행한 확인 단계다. bbox, OCR 문자열, crop SHA-256은 기준선과 151/151 같았고 제품
  출력은 실험 3 예상값과 151/151 일치했다. 예상 mismatch `0`, source evidence mismatch
  `0`이다.
- 현재 제품으로 캠페인 001의 258개와 캠페인 002의 297개를 재생했다. 잠긴 현재 예상과
  총 555/555 일치했고 이번 peer gate가 새로 건드린 과거 후보는 `0`이다. 캠페인 002 최초
  source report의 109개 역사적 차이는 v0.2.1 이전 자료와의 차이이며 peer-gate 퇴행이 아니다.
- 남은 일반 대사 구조 문제는 `P003/D009`, `P005/D005`의 cluster 병합과
  `P013/D011`의 세로 글리프 좌측 절단이다. `P008/D006`은 산개 원문이라 단일 grid bbox의
  크기 해석이 여전히 제한적이다. 이 문제들을 폰트 크기 개선으로 해결됐다고 표시하지 않는다.
- 4/5회 안에 명확한 개선과 과거 회귀 통과가 나왔으므로 사용자 규칙상 수백 건 상세 조사
  전환 조건은 발생하지 않았다. peer-gated 경로를 제품 기본에 반영하고 내부 minor 버전을
  `fsai-lab-v0.3.0`으로 올렸다.
- 권위 결과는 `artifacts/font-size-ai-lab/campaign-003/exp-04-production-peer-gated/`의
  `evaluation.json`, 두 `campaign-00*-product-regression.json`, `verdict.json`이다. 모든
  페이지와 crop이 내장된 보고서는
  `artifacts/font-size-ai-lab/campaign-003/chapter-report.html`이다.

## 캠페인 004 · 후보 소유 증거 기반 상향 복구 승격

봉인 화:
`Rawkuma (JA)/Saijaku Kizoku ni Tensei Shita node Akuyaku Tachi wo Atsumete Mita/Chapter 13.2`

- seed `eca7c21077bbdf12e583ddb98dffb610e7422b446343f15174a36d2cc7e97fe0`로
  1,164개 inventory 중 과거 184개를 제외한 980개 후보에서 검사 전에 봉인했다. 10페이지
  전체 오버레이 10/10과 일반 대사 crop 70/70을 각각 원본 해상도로 확대 확인했다. 효과음
  4개는 사용자 별도 선택 흐름이므로 모든 판정·지표에서 제외했다.
- 실험 1의 v0.3.0 기준선은 일반 대사 70개 중 65개를 측정하고 문장부호 5개는 abstain했다.
  같은 글꼴 불일치는 `0.1178`, hierarchy penalty는 `0`이었다. 가장 명확한 낮은 오추정은
  `P008/D002 18.4736px`로, 후보 자신의 component와 major-axis 증거는 약 `20~22px`에
  반복됐다.
- near-square bbox를 세로로 뒤집는 진단은 승격하지 않았다. `P005/D003`은 가로
  `23.7636px`, 세로 `24.50px`로 차이가 작았고, `P004/D002`는 가로 `30.387px`에서 세로
  `23.34px`로 오히려 본문 hierarchy를 망칠 위험이 있었다. 방향 추정 문제와 글자 크기
  문제를 전역 규칙 하나로 합치지 않는다.
- 실험 2는 기준선이 안정적인 같은-tier page peer보다 1.12배 이상 낮을 때만 후보를 심사한다.
  실제 교정값은 peer 중앙값을 복사하지 않고, 후보 자신의 connected-component body mode와
  여러 line-count 가설에서 반복되는 major-axis mode가 합의할 때만 올린다. component mass,
  line-fill, mode weight, uplift 범위와 mode/peer 범위를 모두 통과하지 못하면 보존한다.
- 실제 변경은 `P008/D002 18.4736→21.522px` 한 건이다. coverage는 `65/70`으로 유지됐고
  같은 글꼴 불일치는 `0.1178→0.1124`, hierarchy penalty는 `0`이다. 실제 CUDA/cu126
  HayaiOCR 재실행은 bbox/OCR/source evidence와 사전 예상이 70/70 일치했다.
- 과거 캠페인 재생에서 캠페인 001은 258개 중 새 변경 `0`, score `0.0994`; 캠페인 002는
  `P018/D002 14.17→17.65px` 한 건을 올바르게 복구해 `0.1340→0.1259`; 캠페인 003은
  `P002/D001 18.37→21.52`, `P004/D005 19.04→23.46`,
  `P010/D002 19.07→22.56px` 세 건을 올바르게 복구했고 score `0.0604`와 hierarchy `0`을
  보존했다. 총 706개 실제 제품 예상 mismatch는 `0`이다.
- 남은 문제는 `P009/D008`의 높은 손글씨·긴 다열 오차, `P004/D001-D002` 겹친 bbox,
  `P010/D001-D002`와 `P007/D005-D006`의 split/경계 구조다. `P009/D009-D010` 손글씨는
  판정이 애매해 승격 근거로 쓰지 않았다. 이 문제들을 상향 복구로 해결됐다고 표시하지 않는다.
- 2/5회 안에 명확한 개선과 과거 회귀 통과가 나왔으므로 수백 건 상세 조사 전환 조건은
  발생하지 않았다. peer-gated upward mode를 제품 기본에 반영하고 내부 minor 버전을
  `fsai-lab-v0.4.0`으로 올렸다.
- 권위 결과는
  `artifacts/font-size-ai-lab/campaign-004/exp-02-peer-gated-upward-mode-hayai/`의
  `evaluation.json`과 `verdict.json`이다. 모든 페이지와 일반 대사 crop이 내장된 보고서는
  `artifacts/font-size-ai-lab/campaign-004/chapter-report.html`이다.

## 내부 버전 승격 규칙

- `v0.0.0`: 현재 제품 기준선.
- patch: 실패 없이 적용률·감사 가능성만 개선한 보수적 보정.
- minor: 새 geometry/fallback 경로가 한 화 전체·고정 진단·실제 runtime을 모두 이기면 올릴
  수 있다. 단, 다음 미사용 화에서 유지 검증 전까지는 조건부 승격으로 기록한다.
- major: 모델·데이터 계약 또는 렌더 계약이 바뀌고 새 locked 평가까지 통과.

버전은 사용자 화면에 표시하지 않는다. 승격마다 커밋/가설/검증 화/회귀를 이 파일에
기록한다.

## 실험 이력 요약

| 화                         | 가설 수 | 결론                                                          | 내부 버전 | HTML 보고서                                                   |
| -------------------------- | ------: | ------------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| `Ossan…/Chapter 28.2`      |     5/5 | 크기·bbox 모두 명확한 개선, 실제 HayaiOCR 완주, 조건부 승격   | `v0.1.0`  | `artifacts/font-size-ai-lab/campaign-001/chapter-report.html` |
| 고정 진단 `神の慈悲により` |     1/1 | 좁고 긴 세로 원문의 완전 측정 누락을 동종 peer로 복구         | `v0.1.1`  | 다음 화 보고서에 합산 예정                                    |
| `TENSEI…/Chapter 2`        |     2/5 | R1 폐기; 세 방향 geometry 합의가 일반 대사에서 개선·회귀 통과 | `v0.2.0`  | `artifacts/font-size-ai-lab/campaign-002/chapter-report.html` |
| `Isekai…/Chapter 4`        |     4/5 | raw lattice 폐기; peer-gated 교정 6개·과거 555개 회귀 통과    | `v0.3.0`  | `artifacts/font-size-ai-lab/campaign-003/chapter-report.html` |
| `Saijaku…/Chapter 13.2`    |     2/5 | 낮은 mode 1개 복구·과거 706개 실제 제품 기대값 일치           | `v0.4.0`  | `artifacts/font-size-ai-lab/campaign-004/chapter-report.html` |

## 워크트리 링크 주의

이 워크트리의 `node_modules`는
`C:\Users\sam40\Downloads\망가번역기\node_modules`를 가리키는 정션이다.
의존성 설치·수정은 이 링크를 통해 실행하지 않는다. 워크트리를 제거할 때는 원본 보존을
확인한 뒤 정션 자체만 먼저 분리하고, 링크가 연결된 상태에서 재귀 삭제하지 않는다.
