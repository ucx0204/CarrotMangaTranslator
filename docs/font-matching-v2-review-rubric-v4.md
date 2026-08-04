# Font Matching V2 육안검수 규약 v4

이 규약은 앱의 확장 22종 한글 폰트 catalog를 위한 blind 검수, calibration,
adjudication에 공통 적용한다. 목표는 일본어 글자 모양의 복제가 아니라 한국어로
바꿨을 때 원문의 역할, 글꼴 골격, 시각적 목소리와 화 내 운용을 보존하는 것이다.
표본 수보다 한 건의 정확한 crop·role·safe 판정이 우선한다.

후보는 끝까지 `ko-candidate-*` alias로만 본다. font 이름·identity·reveal map·기존
tier·모델 점수·작품 장르명은 production merge 전 검수 화면에 노출하지 않는다.

## 1. 판정 순서

아래 순서를 건너뛰거나 뒤집지 않는다.

1. raw, glyph, context와 원본 페이지로 실제 글자와 crop 완전성을 확인한다.
2. 후보를 가린 상태에서 텍스트가 장면에서 하는 일을 한 문장으로 적고 role을 정한다.
3. source skeleton의 family와 6축 style을 기록한다.
4. outline, inverse, shadow, texture, distortion, rotation을 skeleton과 분리한다.
5. 후보 7개의 고정 prototype과 source-geometry probe를 같은 조건으로 비교한다.
6. 각 alias에 hard veto와 `unchanged-safe yes/no`를 먼저 판정한다.
7. safe 후보만 preferred/acceptable로 나누고 unsafe 후보를 기계적으로 정리한다.
8. safe가 0개일 때만 `none_acceptable=true`로 파생한다.
9. source hard 축을 모두 통과한 동률 후보에서만 chapter, 그다음 work anchor를 쓴다.

role 또는 hard-family confidence가 0.75 미만이면 억지 확정하지 않는다. source-only
판정을 후보를 본 뒤 고치는 것도 금지한다.

## 2. font-signal eligibility

- 완전한 글자 골격과 동일 text object의 붙은 문장부호·장음·필수 treatment가 보이면
  짧은 구절도 `font_signal_present`다.
- 점, 선, 말줄임표, 문장부호 하나처럼 family와 획 리듬을 판정할 골격이 없으면
  `font_signal_absent`다.
- 글자가 잘렸거나 이웃 text object가 섞였거나 같은 문장의 필수 부호·outline을 잘라
  style 판단을 바꾸면 `crop_needs_review`다.
- review 카드의 cyan/red bbox와 `REVIEW-ONLY` 표시는 학습 픽셀이 아니다. 원본 view에
  이런 표식이 있으면 즉시 격리한다.
- primary/secondary eligibility가 다르면 tier metric과 merge에서 빼고 새 human audit와
  fresh replacement를 요구한다. 자동 휴리스틱은 최종 eligibility를 정할 수 없다.

## 3. semantic role

- `dialogue`: 보통 크기와 톤의 실제 발화.
- `narration`: 화자 밖에서 시간, 장소, 상황, 장면 전환을 설명하는 문장.
- `thought`: 외부 speaker 없이 인물의 명시적 내면을 나타내는 문장.
- `whisper`: 실제 발화를 작게 하거나 숨죽인다는 페이지 증거가 있는 문장.
- `aside_balloon_edge`: 본 대사와 독립된 말풍선 옆·꼬리·밖의 덧말, 츳코미, 메모.
- `emphasis_dialogue`: 같은 utterance 안에서 주변 글자와 family, weight 또는 size가
  실제로 다른 부분 강조.
- `shout`: 발화 전체가 고함, 절규, 명령으로 연출된 경우.
- `sfx_impact`: 충돌, 타격, 폭발, flash, 발동의 순간 onset/contact.
- `sfx_motion`: 이동, 스침, 휘두름, 전환, 반복 변위의 진행.
- `sfx_ambient`: 바람, 비, 정적, 웅성거림, 긴장처럼 지속되는 환경.
- `sfx_emotion`: 호흡, 신음, 기침, 오싹함, 두근거림 같은 몸·감정 반응.
- `sfx_comic`: 제거하면 gag 또는 punchline timing이 사라지는 반응음.
- `sign_ui_title`: 간판, 장 제목, 인물명, credit, 기술명 label, 상태표, UI, 기기 화면.
- `other`: 기능은 알지만 위 분류에 안정적으로 들어가지 않는 실제 텍스트.
- `unknown_needs_review`: crop/context 부족으로 역할을 판정할 수 없는 경우.

### 3.1 강제 경계

- 느낌표만으로 shout를 고르지 않는다. utterance 전체의 의미상 고성, 크기·굵기,
  balloon/배경 연출 가운데 최소 두 가지가 함께 지지해야 한다.
- emphasis는 같은 utterance의 비교 대상과 visible contrast를 직접 가리킬 수 있어야
  한다. 전체가 강하면 shout/dialogue이고 독립 소문구면 aside다.
- 사각형이라는 이유만으로 narration, 1인칭이라는 이유만으로 thought를 고르지 않는다.
  bounded name, credit, notification은 label 기능이 있으면 sign이다.
- SFX는 둥글다·크다 같은 모양보다 사건의 시간축과 대상을 먼저 쓴다.
- 독립된 기술명은 sign, slash·충돌 프레임에 동기화된 사건 lettering은 impact다.
- handwritten, serif, rough, round는 role이 아니라 source style이다.

## 4. source skeleton과 treatment

6축은 0–4, 0.5 단위로 기록한다. 보이지 않는 축은 `unknown`이며 0으로 대체하지 않는다.

| 축          | 0            | 4                   |
| ----------- | ------------ | ------------------- |
| weight      | hairline     | ultra-black         |
| width       | 매우 협폭    | 매우 확장           |
| roundness   | 직선·각 중심 | 곡선·둥근 접합 중심 |
| handwritten | 기계적 인쇄  | 명백한 손글씨       |
| angularity  | 유순한 곡선  | 날카로운 각·대각선  |
| energy      | 정적인 본문  | 강한 display·충격   |

family gate는 `serif_printed`, `sans_printed`, `handwritten`, `display`,
`mixed_or_unknown` 중 하나다. 각 sample은 목소리를 결정하는 hard axis를 최대 3개
고른다. `energy`는 역할에서 추정하지 않고 glyph의 질량, 대비, 기울기, 리듬에서 본다.

outline, shadow, inverse fill, texture, distortion, rotation은 treatment다. outline 때문에
두꺼워 보이는 면적을 skeleton weight로 세지 않으며, 나중에 outline을 넣을 수 있다는
이유로 명조를 고딕으로, 손글씨를 기계적 인쇄체로 바꾸지 않는다.

### 4.1 blind alias 고정 prototype

이 표는 font metadata나 identity가 아니라 동일 blind render의 운용상 관찰값이다.

| alias                           | weight | width | round | hand | angular | energy | 핵심                             |
| ------------------------------- | -----: | ----: | ----: | ---: | ------: | -----: | -------------------------------- |
| `ko-candidate-2a5d12c7e8f32c30` |    1.5 |   2.0 |   1.5 |  3.0 |     3.0 |    2.5 | 가볍고 거친 각형 hand            |
| `ko-candidate-a0144e95710224a2` |    3.5 |   2.0 |   1.0 |  0.0 |     3.0 |    3.5 | 굵고 정방형인 mechanical display |
| `ko-candidate-9ee53bb2477d92a2` |    1.5 |   2.0 |   3.0 |  2.5 |     1.5 |    1.5 | 가늘고 둥근 casual hand          |
| `ko-candidate-e7b4692fa6ce4ebc` |    4.0 |   1.5 |   0.5 |  0.0 |     4.0 |    4.0 | 초굵고 압축된 각형 display       |
| `ko-candidate-cd8774e1d647c522` |    2.0 |   1.5 |   1.5 |  0.0 |     2.0 |    1.0 | 협폭·절제된 printed sans         |
| `ko-candidate-f11ed4e82c1eacf1` |    0.5 |   2.5 |   2.5 |  4.0 |     2.0 |    2.0 | 초세필의 유기적 hand             |
| `ko-candidate-4cc309d56243eb25` |    2.5 |   2.0 |   2.0 |  0.0 |     1.5 |    1.5 | 중굵고 안정적인 printed sans     |

7개 중 안정적인 serif/Mincho prototype은 없다. source가 명확한 serif라면 가장 덜
나쁜 sans를 자동 승격하지 않는다.

## 5. role별 style distance

`D = Σ w(role, axis) × |source - candidate| / 4`로 계산한다. unknown 축은 제외하고
나머지 weight를 합 1로 다시 정규화한다. critical axis가 unknown이면 low-confidence다.

| role group                 | weight | width | round | hand | angular | energy |
| -------------------------- | -----: | ----: | ----: | ---: | ------: | -----: |
| dialogue/narration/thought |    .20 |   .20 |   .15 |  .20 |     .10 |    .15 |
| aside/whisper              |    .10 |   .10 |   .15 |  .30 |     .15 |    .20 |
| emphasis/shout             |    .25 |   .10 |   .10 |  .10 |     .20 |    .25 |
| impact                     |    .25 |   .10 |   .05 |  .10 |     .25 |    .25 |
| motion                     |    .10 |   .15 |   .10 |  .25 |     .20 |    .20 |
| ambient                    |    .15 |   .15 |   .20 |  .20 |     .10 |    .20 |
| emotion                    |    .10 |   .10 |   .20 |  .30 |     .10 |    .20 |
| comic                      |    .20 |   .10 |   .20 |  .15 |     .10 |    .25 |
| sign/UI/title              |    .20 |   .20 |   .15 |  .05 |     .20 |    .20 |

명조↔고딕, printed↔handwritten, weight 2 bin 이상, quiet body↔aggressive display,
극단 width·regularity 역전은 hard veto다. treatment, 장르, chapter anchor가 hard veto를
구제할 수 없다.

## 6. safe와 tier

`safe=yes`는 앱의 표준 treatment만 사용하고 crop별 수동 재디자인 없이 저장해도
family와 voice가 유지된다는 뜻이다.

- `preferred`: 모든 hard gate pass, `D ≤ 0.16`, 최저 거리에서 `+0.04` 이내. 기본
  1개이고 진짜 동률일 때만 2개까지 허용한다.
- `acceptable`: 모든 hard gate pass, `0.16 < D ≤ 0.28`, critical gap ≤ 1.0.
- `marginal`: `0.28 < D ≤ 0.45` 또는 conditional gate 1개. 자동 적용 금지다.
- `unacceptable`: `D > 0.45`, hard gate fail 또는 critical mismatch 2개 이상.
- `unrenderable`: fallback, glyph missing, clipping 같은 기술 실패만 해당한다.

unsafe 내부 순서는 `hard mismatch 수 → printed/hand 역전 → weight 거리 →
width/regularity → energy`로 고정한다. 카드 배열 순서는 의미가 없다.

### 6.1 safe-set 상한

- 기본 `preferred + acceptable` 상한은 2개다.
- 세 번째 후보는 세 후보의 D 차이가 0.04 이내, 후보 간 최대 거리 0.18 이하이고
  독립 adjudicator가 승인한 경우만 허용한다.
- safe 4개 이상은 invalid다.
- 각 safe alias는 matched hard axis 2개 이상, largest gap과 D를 근거로 남긴다.

### 6.2 `none_acceptable`

none은 독립적인 감상이 아니라 `safe 후보 수 == 0`에서 자동 파생한다. true일 때는
7개 모두의 gate를 끝내고 nearest two의 alias, D, 실패 hard axis와 아래 reason code
하나를 남긴다.

`missing_serif_printed`, `missing_sans_printed`, `missing_rough_hand`,
`missing_fine_hand`, `missing_heavy_display`, `missing_soft_round`,
`deployment_failure`, `other_explained`.

family pass이고 D ≤ 0.28인 후보가 하나라도 있으면 none은 invalid다. exact clone이
아니라는 이유로 none을 쓰거나 marginal을 안전 tier로 올리지 않는다.

## 7. 화 일관성과 실제 font override

화 일관성은 ordinary body의 soft prior다. source family가 같고 hard 축을 통과한 후보가
동률일 때 chapter body consensus, 그다음 work anchor를 preferred tie-breaker로 쓴다.

반대로 다음 source 변화는 anchor보다 우선하며 한국어 폰트도 달라지는 것이 정상이다.

- 같은 utterance 안의 실제 family·weight·size 변화
- 말풍선 옆 독립 handwritten aside
- utterance 전체의 shout·whisper 에너지
- SFX 사건 기능과 반복 visual cluster
- bounded sign/UI/title label

결과의 일관성 action은 `inherit_anchor`, `local_override`, `palette_member`,
`undetermined`로 분리한다. anchor는 unsafe 후보를 safe로 승격하거나 변칙 목소리를
ordinary body로 평탄화할 수 없다. 영애물은 명조, 액션물은 고딕이라는 장르 shortcut도
금지하며 장르는 source evidence가 완전히 동률일 때만 약한 prior다.

## 8. 독립 검수와 quality-first 표본

P0은 prior none과 font-signal 위험, P1은 aside, emphasis, shout, whisper, SFX 5종,
sign/title, handwritten·irregularity ≥ 0.5, manual recrop, 실제 source-family override다.
P0/P1은 100% 독립 secondary 검수한다. 나머지 P2만 작품별 결정론 표본을 이중검수한다.

ordinary dialogue는 전역 삭제하지 않는다. train에서만
`(work, chapter, role, orientation, source_style_cluster)`별 대표 3개를 기본 상한으로
두되 chapter consistency positive, geometry/treatment control, 실제 override, manual
recrop과 모든 변칙군은 보존한다. val/test는 원분포를 유지한다.

primary/secondary가 eligibility, role, safe set, none 또는 tier에서 다르거나 confidence가
낮으면 독립 adjudicator가 원본과 후보를 새로 본다. 교체 crop은 parent label을 상속하지
않는다.

## 9. calibration gate

failed round의 답과 identity는 다음 reviewer에게 공개하지 않는다. 선택 표본과 동일
page, crop SHA, root/variant/normalized glyph, source lineage closure는 합격 여부와 무관하게
영구 development-only train quarantine에 넣는다. test pixel·label은 0회 읽는다.

scored round는 변칙 우선 60개를 기본으로 한다. 현재 corpus가 24작품이므로 작품당
2개 원칙을 적용하되 60개를 채우는 최소 예외로 서로 다른 화·role branch일 때만 최대
3개를 허용한다. 같은 page와 visual cluster는 scored 1개다.

- ordinary dialogue/narration/thought 8
- aside/whisper/handwritten 12
- emphasis/shout 12
- SFX 5종 각 4, 합계 20
- sign/UI/title 8

기존 lock은 낮추지 않는다.

- role macro-F1 ≥ 0.85
- deployment/full tier pairwise agreement ≥ 0.80
- 전체 safe-set Jaccard ≥ 0.70
- candidate-bearing non-empty safe-set Jaccard ≥ 0.70
- `none_acceptable` agreement ≥ 0.90
- eligibility exception 0
- hard-axis inversion 0
- safe-set breadth violation 0, unexplained none 0

빈 safe-set끼리의 Jaccard가 실제 후보 선택 실패를 숨기지 않게 두 값을 분리 보고한다.
같은 rubric으로 서로 겹치지 않는 fresh scored round가 두 번 연속 모든 lock을 통과해야
production merge를 연다.

## 10. 학습·평가 계약

train sampling은 대략 P1 60%, P0 15%, ordinary 25%를 목표로 하고
`work_balance × variant_priority × role_balance × label_quality` weight를 최대 3배로
제한한다. val/test는 재표집하지 않는다. synthetic/generated와 QA overlay는 core와
평가에 0개다.

checkpoint는 P1 변칙 metric, role별 recall@3, none/abstain, local override recall을 먼저
보고 고른다. ordinary top-1은 기존보다 3%p 넘게 악화되면 실패다. chapter 평가는
불필요 body switch/100, anchor coherence, local override recall과 false override rate,
accent cluster consistency를 함께 보고한다.

runtime 결정 순서는 local visual evidence → chapter body consensus → work prior다.
chapter anchor는 allowlist가 아니라 penalty이며 강한 local override evidence가 이긴다.

## 11. 완료 점검

- crop과 eligibility를 원본으로 확인했는가?
- 후보를 보기 전에 role과 skeleton을 정했는가?
- family와 treatment를 분리했는가?
- alias 7개 모두에 hard veto와 unchanged-safe를 판정했는가?
- safe 상한과 none 증명 규칙을 지켰는가?
- chapter anchor가 실제 source 변화나 변칙 목소리를 덮지 않았는가?
- 일반 말풍선 반복보다 aside, 손글씨, 강조, shout, SFX 경계를 우선했는가?
- 장르·작품명·후보 순서·모델 제안에 끌리지 않았는가?
- QA, synthetic, calibration, test 누수가 0인가?
