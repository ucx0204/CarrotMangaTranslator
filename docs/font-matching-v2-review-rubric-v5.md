# Font Matching V2 육안검수 규약 v5

이 규약은 앱의 확장 22종 한글 폰트 catalog를 위한 blind 검수, calibration,
adjudication에 공통 적용한다. 목표는 일본어 글자 모양의 복제가 아니라 한국어로
바꿨을 때 원문의 역할, 글꼴 골격, 시각적 목소리와 화 내 운용을 보존하는 것이다.
표본 수보다 한 건의 정확한 crop·role·safe 판정이 우선한다.

후보는 끝까지 `ko-candidate-*` alias로만 본다. font 이름·identity·reveal map·기존
tier·모델 점수·작품 장르명은 production merge 전 검수 화면에 노출하지 않는다.

v5 scored review는 한 장짜리 동시 화면이 아니다. `A/source-only`와
`B/candidate-only`를 서로 다른 파일과 제출 단계로 나눈다. reviewer는 A에서
eligibility, role evidence, family, 6축, hard axis, treatment를 먼저 봉인하고 그 SHA가
검증된 뒤에만 B를 본다. B의 tier는 자유 서술로 정하지 않고 봉인된 A와 고정 blind
prototype으로 계산한 7행 gate/D matrix에서 결정한다. 실패한 이전 round의 답과
identity는 A, B 어느 쪽에도 노출하지 않는다.

여기서 "봉인"은 한 번의 최종 제출 안에 A와 B를 같이 넣는다는 뜻이 아니다. A 전체
batch를 append-only 원장에 먼저 commit하고, 그 원장의 record SHA와 전체 task-set SHA를
검증한 별도 `B release` artifact가 생성돼야 candidate-only 파일을 열 수 있다. B release
이후 A 수정·교체·재봉인은 금지하며, 오류가 있으면 그 batch 전체를 폐기하고 새 task ID와
fresh lineage로 다시 시작한다.

## 1. 판정 순서

아래 순서를 건너뛰거나 뒤집지 않는다.

1. hidden eligibility preflight에서 raw, glyph, context와 원본 페이지로 한 text object의
   완전성과 clean glyph isolation을 확인한다.
2. scored A에서는 후보 픽셀을 열지 않고 observable role evidence를 먼저 기록한다.
3. source skeleton의 family, family confidence, 6축 style과 최대 3개 hard axis를 기록한다.
4. outline, inverse, shadow, texture, distortion, rotation을 skeleton과 분리해 A를 봉인한다.
5. A의 assignment, source-card SHA, annotation SHA를 검증한 뒤에만 B를 연다.
6. 후보 7개의 고정 prototype과 source-geometry probe를 같은 조건으로 비교한다.
7. 각 alias의 family gate, critical gap, D, hard veto를 7행 matrix로 계산한다.
8. safe 후보만 preferred/acceptable로 나누고 safe가 0일 때만 none을 파생한다.
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

scored `present`는 아래 세 조건을 모두 만족해야 한다.

1. 동일 text object 전체와 붙은 필수 부호·장음·treatment가 잘리지 않았다.
2. 한 bbox의 모든 글자는 하나의 source skeleton으로 설명된다.
3. `glyph_224`에서 인물·의복·속도선·패턴·이웃 글자가 글자 mask와 연결되거나
   geometry/component 통계를 바꾸지 않는다.

raw/context에 주변 그림이 보이는 것 자체는 실패가 아니다. 격리 glyph에 그 그림이
남아 source signature를 바꾸는지가 기준이다. 여러 색·골격의 주제목, 부제, 장식 문구,
밑줄을 한꺼번에 묶은 logo는 `none`이 아니라 `crop_needs_review`이며 구성요소별로
split한다. hidden preflight에서 하나라도 실패한 카드는 답을 만들지 않고 같은 stratum의
fresh lineage로 교체한다.

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

### 3.2 v5 결정 precedence

role은 모양이나 장르가 아니라 아래 observable evidence를 순서대로 적용해 파생한다.

1. bounded name·credit·상태·기술명·UI처럼 메타 label 기능이면 `sign_ui_title`이다.
2. 실제 사건 lettering이면 먼저 lexical target과 대상 사건을 적는다. 순간 onset/contact는
   `impact`, 변위·압력·전환의 진행은 `motion`, 지속 환경은 `ambient`, 신음·호흡·생리
   반응은 `emotion`이다. `comic`은 앞 네 역할로 안정 분류되지 않으며 제거할 때 gag
   timing이 사라지는 경우에만 남는 residual role이다.
3. 발화 계열은 tail, 동일 utterance 연속, 청자 반응 같은 external speech evidence를
   먼저 확인한다. 주 발화에 공간·담화적으로 종속된 독립 덧말만 `aside`다.
4. 같은 utterance의 visible 대비가 있으면 `emphasis`, 발화 전체의 의미상 고성,
   크기·굵기, balloon/배경 중 서로 다른 두 cue 이상이면 `shout`, 숨죽임 증거가 있으면
   `whisper`다.
5. external speech evidence 없이 인물 자신의 평가·질문·되짚기이면 `thought`, 시간·장소·
   절차·장면 전환을 화자 밖에서 설명하면 `narration`이다. 나머지 실제 외부 발화는
   `dialogue`다.

회색, 사각, inverse, 방사선, 둥근 획, 큰 글자, 느낌표는 어느 role의 단독 증거도 아니다.
구조화 A annotation은 위 분기의 evidence boolean/enum을 저장하고 role 문자열은 그
evidence에서 결정론적으로 파생한다. 서로 모순되는 evidence는 제출 오류다.

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

### 4.1 serif hard-gate 증거

`serif_printed` hard veto는 감으로 선언하지 않는다. family confidence가 0.85 이상이고,
서로 다른 완전한 glyph 두 개 이상에서 반복되는 (a) thick-thin stroke contrast와
(b) terminal/serif 구조를 raw와 glyph 양쪽에서 직접 확인한 경우에만 확정한다. 한 글자,
저해상도, outline, 붓 terminal, 숫자 혼합 label은 이 조건을 충족하지 않는다. 이때는
`mixed_or_unknown`과 low confidence로 보내며 “명조 같음”만으로 7종 전체 none을 만들지
않는다. 반대로 조건을 충족한 명조 source에는 sans·hand 후보를 safe로 올릴 수 없다.

### 4.2 blind alias 고정 prototype

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

### 6.1 구조화 gate/D matrix

B는 alias마다 다음 값을 빠짐없이 저장한다: `family_gate`, `hard_veto_reasons`, 6축 gap,
hard-axis 최대 gap, normalized `D`, derived tier, mandatory unrenderable 여부. reviewer가
tier 문자열만 자유 입력하는 형식은 invalid다. source-only A에는 candidate alias나
candidate 비교 문구를 넣을 수 없으며, B 계산기는 A SHA와 task의 assignment, seed,
full/source/candidate card SHA를 모두 결박한다.

동일 A와 동일 prototype profile은 플랫폼·후보 배열 순서와 무관하게 같은 matrix와 tier를
내야 한다. safe cap은 계산 단계에서 2개로 강제하고, none은 safe 수 0에서만 자동 파생한다.
수동 override는 렌더 기술 실패를 `unrenderable`로 확정하는 경우 외에는 허용하지 않는다.
경계가 잘못됐다고 판단되면 tier 한 칸만 고치지 않고 A의 observable family/axis evidence를
다시 독립 검수해 새 sealed annotation을 만든다.

`unrenderable` 후보는 배포 가능한 후보의 최저 D, preferred 기준점, safe 수, none 증명에
절대 포함하지 않는다. 기술 실패는 deployment failure 사유로만 기록한다. 그렇지 않으면
가장 가까운 후보가 렌더 실패했다는 이유만으로 실제 배포 가능한 차선 후보까지 marginal로
내려가 safe 0을 만드는 오류가 생긴다.

### 6.2 safe-set 상한

- 기본 `preferred + acceptable` 상한은 2개다.
- scored calibration에서는 세 번째 safe 후보를 허용하지 않는다. production에서는 세
  후보의 D 차이가 0.04 이내, 후보 간 최대 거리 0.18 이하이고 독립 adjudicator가 새
  evidence로 승인한 경우에만 예외를 별도 기록한다.
- safe 4개 이상은 invalid다.
- 각 safe alias는 matched hard axis 2개 이상, largest gap과 D를 근거로 남긴다.

### 6.3 `none_acceptable`

none은 독립적인 감상이 아니라 `safe 후보 수 == 0`에서 자동 파생한다. true일 때는
7개 모두의 gate를 끝내고 nearest two의 alias, D, 실패 hard axis와 아래 reason code
하나를 남긴다.

`missing_serif_printed`, `missing_sans_printed`, `missing_rough_hand`,
`missing_fine_hand`, `missing_heavy_display`, `missing_soft_round`,
`deployment_failure`, `other_explained`.

family pass이고 D ≤ 0.28인 후보가 하나라도 있으면 none은 invalid다. exact clone이
아니라는 이유로 none을 쓰거나 marginal을 안전 tier로 올리지 않는다.

### 6.4 신규 7종 유지·삭제·교체

7종은 최종 catalog 전체가 아니라 기존 15종에 추가한 blind challenger다. calibration
60장만으로 폰트를 삭제하거나 유지하지 않는다. production eligibility를 통과한 전체
primary와 필요한 secondary/adjudication이 끝난 뒤 아래 순서로 판단한다.

1. 각 challenger의 preferred, safe, `기존 15종에는 safe가 없지만 challenger가 구제한
경우`, 기존 후보를 이긴 unique preferred, P1 unique contribution을 집계한다.
2. challenger가 관여한 모든 표본은 기존 15종과 신규 7종을 함께 익명 렌더한 22종
   head-to-head 카드로 다시 확인한다. 서로 다른 rubric 세대의 tier 수를 단순 비교하지
   않는다.
3. 전체 eligible set에서 safe 0이면 삭제한다. safe는 있으나 unique preferred와 P1
   rescue가 모두 0이고 기존 폰트 safe set에 완전히 포함되면 중복으로 판정해 교체한다.
4. 단 하나라도 실제 P1 변칙을 유일하게 구제하면 즉시 삭제하지 않는다. 서로 다른
   작품·페이지 lineage의 targeted confirmation을 추가해 재현되면 유지하고, 재현되지
   않으면 보류 또는 교체한다.
5. ordinary body에서만 드물게 선택되고 chapter anchor를 불필요하게 분산시키는 폰트는
   사용 횟수가 0이 아니어도 유지 근거가 아니다.

삭제·교체 판정은 별도 후처리 메모가 아니라 같은 원장의 catalog transition으로 봉인한다.
`retained`, `deleted_safe_zero`, `deleted_redundant`, `replacement_pending`,
`replacement_admitted` 상태와 전·후 catalog SHA를 모두 저장하며, 삭제된 후보를 포함한
고정 22종을 final이라고 주장해서는 안 된다. 기술적으로 렌더되지 않은 표본은 해당 폰트의
safe 0 효용 분모에서 제외하고 deployment failure로 별도 집계한다.

교체 폰트는 현재 배포 가능한 한글 glyph 범위와 라이선스를 공식 출처에서 다시 확인하고,
폰트 파일·라이선스·출처 URL·SHA를 함께 봉인한다. 기존 실패 카드나 답을 재사용하지 않고
fresh blind calibration 두 회를 같은 gate로 통과해야 catalog에 들어간다. 후보 수를 맞추기
위해 품질이 낮은 폰트를 남기지 않으며, 삭제 후 최종 catalog가 22종보다 적어도 허용한다.

교체 후보는 현대 한글 완성형 11,172자 전부를 지원하는 family를 우선한다. 부분 glyph
family는 짧은 효과음·강조에서 완전 지원 후보가 대체하지 못하는 독자적 P1 효용이 fresh
blind review로 확인될 때만 예외적으로 허용한다. 이 경우 실제 번역 문자열의 모든 code
point를 지원하지 않으면 runtime 후보에서 hard-exclude하고, glyph 미지원 표본은 해당
family의 스타일 효용 분모가 아니라 별도 deployment-coverage 분모로 보고한다. full-coverage
대체 후보가 같은 효용을 내면 부분 glyph family를 유지하지 않는다.

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

### 8.1 scored 이전 hidden eligibility preflight

selector는 목표 60개를 바로 공개하지 않고 같은 quota로 최소 72개의 fresh 후보를 먼저
봉인한다. scored reviewer와 다른 두 검수자가 candidate B와 prior role/tier를 보지 않고
source-only A만 각각 확인한다. 두 명 모두 `complete text object`, `single skeleton`,
`clean glyph isolation`, `role context sufficient`를 yes로 한 카드만 scored pool에 들어간다.
한쪽이라도 absent/crop/insufficient이면 같은 hidden stratum의 fresh page·lineage로 교체한다.

preflight는 font tier나 최종 role 답을 만들지 않는다. eligibility disposition과 증거만
봉인하므로 다음 scored reviewer에게 답을 주지 않는다. incomplete fragment, mixed logo,
glyph art contamination, event/container 문맥이 잘린 SFX·thought 카드는 어려운 표본이
아니라 답이 없는 표본으로 본다. 어려운 role boundary는 남기되 판단에 필요한 자연
픽셀 문맥은 반드시 보인다.

## 9. calibration gate

failed round의 답과 identity는 다음 reviewer에게 공개하지 않는다. 선택 표본과 동일
page, crop SHA, root/variant/normalized glyph, source lineage closure는 합격 여부와 무관하게
영구 development-only train quarantine에 넣는다. public task ID, assignment ID, seed도 새
round와 production에서 재사용하지 않아 과거 답과 join할 수 없게 한다. split 판정은 asset
경로의 `train` 문자열이나 legacy split이 아니라 master의 권위 `split_map`만 사용한다.
canonical val/test가 legacy 경로상 train이어도 즉시 제외한다. test pixel·label은 0회 읽는다.

v1-v3 calibration은 이 canonical 규칙을 만족하지 않은 표본이 확인됐으므로 metric, 답안,
identity를 모두 폐기한다. 그중 canonical train lineage도 fresh evidence로 재사용하지 않고
영구 train quarantine에 남기며, canonical val/test lineage는 어떤 development pool에도
들어오지 않는다.

scored round는 변칙 우선 60개를 기본으로 한다. hidden reserve 72개는 canonical train
작품만 사용하고, 현재 15개 train 작품을 모두 포함해 작품당 최소 4개를 요구한다. 가장
작은 균형 상한인 작품당 5개로 exact quota가 성립할 때만 진행한다. 이론상 구성은 12작품
5개와 3작품 4개이며 특정 작품 쏠림이 아니다. role quota 때문에 상한 5에서 불가능하면
val/test를 끌어오거나 split을 재배정하지 않고 fresh train lineage를 보충한다. 같은 page와
visual cluster는 scored 1개다.

각 scored reviewer는 60개의 source-only A를 모두 제출·봉인한 뒤 candidate B를 받는다.
A에는 후보 alias, font 이름, prior role/style/tier, model score가 0개다. B에는 source
원본을 다시 보여주지 않고 reviewer 자신의 sealed A digest와 blind prototype만 결박한다.
결정 파일은 구조화 annotation에서 결정론적으로 생성하며, 수동으로 preferred/acceptable
배열을 작성하거나 다른 reviewer의 A/B를 읽는 것은 금지한다.

role context는 표본 유형에 맞게 충분해야 한다. thought/aside는 container, tail, 주 발화
관계가 보이는 패널을 포함하고 SFX는 사건 대상과 필요할 때 직전·직후 인접 패널을 포함한다.
번역문, role gloss, selector stratum 이름은 노출하지 않는다. serif control은 한 글자
저해상도 대신 반복 증거가 있는 multi-glyph 명조와 clear sans를 함께 포함한다.

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

- hidden eligibility preflight 두 명이 scored 60개를 모두 present로 합의했는가?
- source-only A 60개가 candidate B를 열기 전에 실제로 봉인됐는가?
- crop과 eligibility를 원본으로 확인했는가?
- 후보를 보기 전에 role과 skeleton을 정했는가?
- family와 treatment를 분리했는가?
- alias 7개 모두에 family gate, hard veto, largest gap, D가 있는가?
- safe 상한과 none 증명 규칙을 지켰는가?
- chapter anchor가 실제 source 변화나 변칙 목소리를 덮지 않았는가?
- 일반 말풍선 반복보다 aside, 손글씨, 강조, shout, SFX 경계를 우선했는가?
- 장르·작품명·후보 순서·모델 제안에 끌리지 않았는가?
- QA, synthetic, calibration, test 누수가 0인가?
