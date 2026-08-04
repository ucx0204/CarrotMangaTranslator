# Font Matching V2 calibration probe v4

## 0. 결론

Round 2는 production 판정을 열 수 없다. 문제는 단순히 40건이 적어서가 아니다.
두 검수자가 같은 7개 blind alias를 보면서도 **source의 hard style을 기록하는 공통
좌표계 없이**, `읽히는가`, `가장 가까운가`, `그대로 저장 가능한가`를 서로 다른
기준으로 섞어 사용했다.

v4의 핵심 변경은 다음 네 가지다.

1. 후보를 보기 전에 role과 source style signature를 별도 봉인한다.
2. 7개 alias의 시각적 signature를 고정된 0–4 축으로 공유한다.
3. role별 가중 거리와 hard-family veto로 tier 경계를 수치화한다.
4. 넓은 safe set과 근거 없는 `none_acceptable`을 각각 fail-closed로 막는다.

이 문서는 검수 규칙과 다음 fresh calibration 설계안이다. 코드, ledger, review
decision은 변경하지 않았다.

## 1. 검토 범위와 blind 무결성

사용한 근거는 Round 2의 공개 agreement report, 공개 primary/secondary blind tasks,
공개 reviews, 공개 decision schema, calibration subset, 그리고 해당 task가 직접
가리키는 review card뿐이다. 후보는 끝까지 `ko-candidate-*` alias로만 비교했다.

직접 육안 비교한 범위는 다음과 같다.

- 서로 다른 source 9건의 primary card
- 그중 horizontal 1건과 vertical 1건의 secondary 재배열 card
- 각 card의 source page, local/raw/context/glyph view
- 각 card에 공통으로 들어간 7개 alias의 `dialogue-body`, `narration`,
  `sfx-impact` probe
- horizontal/vertical 두 writing mode에서의 동일 alias 골격

비공개 binding, reveal 정보, font identity/name, model score는 열거나 사용하지 않았다.
아래 signature는 font 정체가 아니라 card에 실제로 보인 픽셀의 운용상 기술이다.

## 2. Round 2에서 확인된 실패 모양

### 2.1 공식 결과와 추가 진단

| 항목                        |  결과 | 판정                         |
| --------------------------- | ----: | ---------------------------- |
| role macro-F1               | 0.578 | 기준 0.85 미달               |
| tier pairwise agreement     | 0.560 | 기준 0.80 미달               |
| safe-set Jaccard            | 0.525 | 기준 0.70 미달               |
| `none_acceptable` agreement | 0.900 | 기준 0.90 통과               |
| eligibility exception       |  0/40 | crop eligibility 문제는 아님 |

공개 review 80개를 alias 기준으로 다시 집계하면 다음이 더 분명하다.

- 40건 중 role 불일치가 14건이다.
- 11건은 양쪽 safe set이 모두 비었다. 빈 집합끼리의 Jaccard 1을 제외하고,
  **적어도 한쪽이 후보를 고른 29건만 보면 평균 Jaccard는 0.345**다.
- 7 alias × 40건 = 280개의 exact tier 중 같은 tier에 놓인 것은 133개,
  즉 47.5%뿐이다.
- Primary safe 판정은 64개, Secondary safe 판정은 48개다. sample당 각각
  1.60개와 1.20개다.
- 두 검수자의 preferred 총수는 각각 27개로 같다. 차이는 주로
  `acceptable` 37 대 21, `marginal` 97 대 56, `unacceptable` 119 대 176에서
  벌어졌다. 즉 top-1 개수보다 **안전 경계의 폭**이 다르다.
- role이 같은 26건의 평균 safe Jaccard도 0.545이고 그중 8건은 0이다.
  role 불일치만 고쳐서는 후보 경계 실패가 해결되지 않는다.

`none_acceptable` 0.90 통과도 독립적으로 해석해야 한다. 11건의 합의된 빈 집합이
지표를 안정시켰지만, 실제 후보가 등장한 사례의 safe 경계는 훨씬 불안정했다.

### 2.2 alias별 safe 경계

`safe = preferred ∪ acceptable`로 두 검수자의 선택을 비교했다.

| alias 축약 | 양쪽 safe | Primary만 safe | Secondary만 safe | 양쪽 비-safe |
| ---------- | --------: | -------------: | ---------------: | -----------: |
| `2a5d…`    |         1 |             15 |                5 |           19 |
| `a014…`    |         3 |              6 |                3 |           28 |
| `9ee5…`    |         7 |              2 |                3 |           28 |
| `e7b4…`    |         1 |              3 |                0 |           36 |
| `cd87…`    |         6 |              1 |                6 |           27 |
| `f11e…`    |         5 |              4 |                1 |           30 |
| `4cc3…`    |         6 |              4 |                1 |           29 |

가장 큰 기준점 붕괴는 `2a5d…`다. Primary는 이 alias를 safe 16회,
`marginal` 22회, `unacceptable` 2회로 보았지만 Secondary는 safe 6회,
`marginal` 10회, `unacceptable` 24회로 보았다. 같은 픽셀을 한쪽은 넓게
쓸 수 있는 캐주얼체로, 다른 쪽은 특정 거친/각진 장면에만 쓰는 변칙체로 운용했다.

## 3. 7개 blind alias의 고정 style signature

### 3.1 눈금 정의

다음 calibration부터는 모든 reviewer가 동일한 정의를 사용한다. 각 축은 0–4,
0.5 단위다. 보이지 않는 축을 0으로 넣지 않고 `unknown`으로 둔다.

| 축          | 0            | 4                   | 관찰 기준                                           |
| ----------- | ------------ | ------------------- | --------------------------------------------------- |
| weight      | hairline     | ultra-black         | 같은 높이에서 glyph ink coverage와 주획 두께        |
| width       | 매우 협폭    | 매우 확장           | 같은 probe·크기에서 median glyph advance/em         |
| roundness   | 직선·각 위주 | 곡선·둥근 접합 위주 | 외곽 곡률, 접합부와 종단의 둥근 비율                |
| handwritten | 기계적 인쇄  | 명백한 손글씨       | baseline/획 종단/자소 반복의 의도적 변동            |
| angularity  | 유순한 곡선  | 날카로운 각·대각선  | corner density, 대각 주획, 뾰족한 종단              |
| energy      | 정적인 본문  | 강한 display/충격   | 질량, 대비, 기울기, 리듬, 문장부호 압력의 합성 인상 |

`energy`는 role이 아니다. `sfx`라서 4를 주거나 `dialogue`라서 0을 주지 않는다.
오직 glyph 자체의 시각적 압력만 기록한다.

### 3.2 Round 2 card에서 봉인할 운용 signature

아래 값은 horizontal/vertical card에서 동일 alias를 여러 번 대조해 얻은
**v4 reviewer reference**다. font metadata가 아니라 blind render의 관찰값이며,
다음 fresh round 전에 canonical probe asset의 hash와 함께 고정해야 한다.

| blind alias                     | weight | width | round | hand | angular | energy | 운용상 핵심 모양                                              |
| ------------------------------- | -----: | ----: | ----: | ---: | ------: | -----: | ------------------------------------------------------------- |
| `ko-candidate-2a5d12c7e8f32c30` |    1.5 |   2.0 |   1.5 |  3.0 |     3.0 |    2.5 | 가볍지만 거칠고 끊기는 각형 hand; 작은 변칙음과 dry motion 쪽 |
| `ko-candidate-a0144e95710224a2` |    3.5 |   2.0 |   1.0 |  0.0 |     3.0 |    3.5 | 굵고 정방형인 mechanical display; 깨끗한 shout/강조 쪽        |
| `ko-candidate-9ee53bb2477d92a2` |    1.5 |   2.0 |   3.0 |  2.5 |     1.5 |    1.5 | 가늘고 둥근 casual hand; 낮은 압력의 감정·ambient 쪽          |
| `ko-candidate-e7b4692fa6ce4ebc` |    4.0 |   1.5 |   0.5 |  0.0 |     4.0 |    4.0 | 초굵고 압축된 각형 display; impact와 극단 강조 쪽             |
| `ko-candidate-cd8774e1d647c522` |    2.0 |   1.5 |   1.5 |  0.0 |     2.0 |    1.0 | 협폭·중간 굵기의 얌전한 printed sans; compact body 쪽         |
| `ko-candidate-f11ed4e82c1eacf1` |    0.5 |   2.5 |   2.5 |  4.0 |     2.0 |    2.0 | 초세필의 유기적 hand; whisper, 섬세한 aside, 미세 motion 쪽   |
| `ko-candidate-4cc309d56243eb25` |    2.5 |   2.0 |   2.0 |  0.0 |     1.5 |    1.5 | 중굵고 안정적인 neutral printed sans; body/narration 쪽       |

세 가지 혼동군을 먼저 기억해야 한다.

1. `f11e…` / `9ee5…` / `2a5d…`: 모두 hand/casual 신호가 있으나,
   각각 **세필 유기성 / 둥근 저압 / 거친 각형 리듬**이 다르다.
2. `cd87…` / `4cc3…`: 모두 낮은 에너지의 printed sans지만,
   각각 **협폭·절제 / 더 굵고 중립적**이다.
3. `a014…` / `e7b4…`: 모두 heavy display지만,
   각각 **깨끗한 굵은 인쇄 / 초굵은 공격적 블록**이다.

공개 probe에서는 7개 중 어느 것도 높은 획 대비의 안정적인 serif/Mincho 골격을
보이지 않았다. 따라서 source의 serifness가 실제로 명확하면 `가장 덜 나쁜 sans`를
자동으로 safe 승격하지 않는 것이 맞다. 다만 그 판단을 free-text 인상으로 두지 말고
아래 family gate로 증명해야 한다.

## 4. 왜 preferred/acceptable/marginal/unacceptable 경계가 갈라졌는가

### 4.1 Jaccard 0인 10개 대표군 전수 비교

| sample                        | role P → S          | Primary safe | Secondary safe | 경계가 갈라진 직접 원인                                                                 |
| ----------------------------- | ------------------- | ------------ | -------------- | --------------------------------------------------------------------------------------- |
| `fm_0875a5921f9903a2017b9338` | emotion → emotion   | `2a5d, cd87` | `f11e, 9ee5`   | 억눌린 신음을 “캐주얼 중간”과 “저에너지 세필 hand”로 다르게 읽음                        |
| `fm_234f813fe9466cc8aa5befd3` | emotion → motion    | `2a5d`       | `4cc3, cd87`   | 사건 기능부터 갈렸고 outline을 skeleton과 분리한 정도도 다름                            |
| `fm_3a528e799884f555a9b1e672` | shout → shout       | `a014, 4cc3` | 없음           | 같은 source를 굵은 Gothic과 printed Mincho로 반대로 판정                                |
| `fm_475eece7c15d9ebdbe17fbc6` | ambient → ambient   | `e7b4, a014` | `9ee5, 2a5d`   | 반복 ambient의 outline/면적을 weight로 읽을지, 내부의 둥근 irregular hand를 읽을지 갈림 |
| `fm_66e90f6f5fee836f4ed429d1` | motion → motion     | `f11e, 9ee5` | `2a5d`         | 빠른 시선 효과를 세필·유기성으로 볼지, dry angular snap으로 볼지 갈림                   |
| `fm_95063d4e33698771f5a8fb2d` | emotion → emotion   | `f11e`       | `2a5d`         | 한 글자 긴장을 세필 sharpness와 거친 compactness 중 어디에 고정할지 갈림                |
| `fm_9779f656923f774d27a6c79d` | emotion → emotion   | 없음         | `2a5d`         | “거친 손글씨와 정확히 같지 않음”과 “거친 각형 hand로 unchanged-safe”의 none 기준 차이   |
| `fm_a86c8743326649c8eab142db` | comic → aside       | `e7b4, a014` | 없음           | punchline SFX와 editorial aside가 갈렸고, heavy energy와 serif family 중 우선축도 갈림  |
| `fm_ad95aca8951b194a2974653e` | motion → motion     | `f11e, 9ee5` | `2a5d`         | 반복 흔들림을 가는 리듬과 거친 마찰 리듬으로 다르게 해석                                |
| `fm_b66c441f9338a42187ceb005` | dialogue → dialogue | 없음         | `cd87, a014`   | 명조를 hard family로 볼지, 굵은 printed voice를 sans로 근사 가능하다고 볼지 갈림        |

이 표에서 중요한 점은 어느 reviewer가 항상 옳았다는 결론이 아니다. 둘 다 rationale은
그럴듯하지만 **같은 축을 측정한 숫자와 candidate별 최대 오차가 없다**. 그래서
상반된 결론도 현재 schema를 모두 통과한다.

### 4.2 role 불일치 14건

role 혼동은 다음과 같이 전부 묶인다.

- `shout → dialogue` 4건:
  `fm_0ee7…`, `fm_43f4…`, `fm_6c83…`, `fm_b4de…`
- `narration → thought` 3건:
  `fm_a5de…`, `fm_b505…`, `fm_ffbc…`
- 각 1건:
  `aside → dialogue` (`fm_8849…`),
  `comic → aside` (`fm_a86c…`),
  `emotion → motion` (`fm_234f…`),
  `sign → impact` (`fm_49da…`),
  `sign → shout` (`fm_18fc…`),
  `thought → sign` (`fm_17e…`),
  `shout → thought` (`fm_f863…`).

후보 cell에 항상 `dialogue-body`, `narration`, `sfx-impact`라는 단어와 예문이 동시에
보이므로, source-only role 판단과 candidate suitability 판단이 한 화면에서 섞인다.
v4에서는 role을 후보를 가린 상태로 먼저 봉인해야 한다.

### 4.3 card와 schema의 구조적 원인

1. **generic probe가 source 역할을 재현하지 않는다.** 모든 source에 body,
   narration, impact 세 문구만 보여 준다. ambient, emotion, whisper, aside, motion,
   comic, sign/title의 리듬과 크기에서 alias가 어떻게 보이는지는 확인할 수 없다.
2. **source geometry로 합성하지 않는다.** 실제 bbox 폭·높이, 글자 수, native size,
   축소 size, 세로쓰기 줄바꿈에 넣어 보지 않으므로 `save unchanged?`가 mental
   simulation이 된다.
3. **family와 treatment를 눈으로만 분리한다.** outline, inverse, distortion,
   halftone 때문에 생긴 면적을 weight로 세거나, 반대로 skeleton의 거칠음을
   지우기 쉽다.
4. **source style이 구조화되어 저장되지 않는다.** 현 decision schema는 role,
   전체 confidence, tier partition, free-text rationale만 요구한다. reviewer가 실제로
   weight 3.5를 봤는지 1.5를 봤는지 비교할 수 없다.
5. **candidate별 근거가 없다.** 7개 각각의 distance, critical-axis gap,
   family veto가 없으므로 한 rationale로 넓은 safe set도, 전부 비-safe도 설명할 수 있다.
6. **`acceptable`의 폭이 정량화되지 않았다.** Primary는 readable하고 보정 가능해
   보이는 후보를 acceptable 가까이 두는 경향이 있고, Secondary는 hard-axis가 조금만
   다르면 unacceptable로 내리는 경향이 있다. `marginal`의 용법도 서로 다르다.

## 5. v4 candidate probe 설계

### 5.1 두 단계 card

#### 단계 A — source-only 봉인

후보 영역을 완전히 숨기고 다음을 먼저 기록한다.

- eligibility
- semantic role와 사건 근거 한 문장
- family gate: `serif_printed`, `sans_printed`, `handwritten`, `display`,
  `mixed_or_unknown`
- 6축 source signature와 axis별 confidence
- hard axes 최대 3개
- treatment: outline, shadow, inverse, distortion, texture
- writing mode, native bbox, source text-object completeness

role 또는 hard family confidence가 0.75 미만이면 candidate tier 단계로 넘어가지 않고
`low_confidence`/adjudication으로 보낸다.

#### 단계 B — alias 비교

단계 A의 봉인값과 role만 가져오고 source 판단은 수정할 수 없게 한다. 7개 alias
순서는 계속 독립 randomize하되 다음 probe를 각 alias에 같은 조건으로 보여 준다.

| probe                     | 목적                        | 고정 조건                                                                 |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| canonical structure strip | alias signature 기억 안정화 | 같은 12자, 같은 em, treatment 없음, horizontal+vertical                   |
| role-conditioned phrase   | source 역할의 리듬 비교     | sealed role별 같은 한국어 문구, 글자 수 4/8/14 중 source에 가장 가까운 것 |
| source-geometry fit       | 실제 배포 폭·높이 확인      | source bbox aspect ratio, 같은 writing mode, 동일 line budget             |
| native/small pair         | 축소 시 획과 개성 보존 확인 | 예상 native 크기와 50% 크기를 나란히 표시                                 |
| treatment A/B             | family와 효과 분리          | 왼쪽 skeleton-only, 오른쪽 앱이 실제 지원하는 source treatment 재적용     |

SFX에는 하나의 `쾅!!`만 재사용하지 않는다. sealed role에 따라 최소 다음 문구군을
따로 둔다.

- impact: 짧고 무거운 1–3음절 + 큰 문장부호
- motion: 반복·늘임·대각 리듬이 보이는 2–5음절
- ambient: 저압 반복과 긴 호흡이 보이는 3–6음절
- emotion: 신음·호흡처럼 작은 1–4음절
- comic: 둥근 punchline과 과장 문장부호
- aside/whisper: 작은 문장 6–12자
- emphasis/shout: 같은 문장을 normal과 emphasis 두 크기로 나란히

probe 문구는 alias마다 반드시 같아야 한다. font가 잘 맞도록 문구나 tracking을
후보별로 조정하면 거리를 측정할 수 없다.

### 5.2 probe 품질 fail 조건

- source actual size에서 한글이 너무 작아 skeleton을 판정할 수 없으면 확대 view를
  추가하되 native view를 없애지 않는다.
- 후보별 fallback, glyph missing, clipping은 `unrenderable`로 분리한다.
- cyan/red QA bbox와 watermark는 계속 review-only이며 학습 view가 아니다.
- treatment A/B 중 skeleton-only가 없으면 해당 sample의 weight/roundness calibration을
  gate 지표에서 제외하고 fresh replacement한다.
- source와 candidate의 writing mode가 다르면 tier를 제출할 수 없다.

## 6. 거리표와 판정 순서

### 6.1 style distance

source와 candidate의 6축 벡터를 각각 `s_i`, `c_i`라고 두고 role `r`의 거리를
다음처럼 계산한다.

```text
D_style(r, s, c) = Σ_i w(r, i) × |s_i - c_i| / 4
```

관찰 불가능한 축은 합에서 빼고 남은 weight를 다시 합 1로 정규화한다. 단, role의
critical axis가 unknown이면 거리 계산으로 억지 확정하지 않고 low confidence다.

### 6.2 role별 고정 weight

| role group                 | weight | width | round | hand | angular | energy | critical axes               |
| -------------------------- | -----: | ----: | ----: | ---: | ------: | -----: | --------------------------- |
| dialogue/narration/thought |    .20 |   .20 |   .15 |  .20 |     .10 |    .15 | family, weight, width, hand |
| aside/whisper              |    .10 |   .10 |   .15 |  .30 |     .15 |    .20 | hand, energy, weight        |
| emphasis/shout             |    .25 |   .10 |   .10 |  .10 |     .20 |    .25 | weight, angular, energy     |
| sfx_impact                 |    .25 |   .10 |   .05 |  .10 |     .25 |    .25 | weight, angular, energy     |
| sfx_motion                 |    .10 |   .15 |   .10 |  .25 |     .20 |    .20 | hand, angular, energy       |
| sfx_ambient                |    .15 |   .15 |   .20 |  .20 |     .10 |    .20 | round, hand, energy         |
| sfx_emotion                |    .10 |   .10 |   .20 |  .30 |     .10 |    .20 | hand, round, energy         |
| sfx_comic                  |    .20 |   .10 |   .20 |  .15 |     .10 |    .25 | weight, round, energy       |
| sign/UI/title              |    .20 |   .20 |   .15 |  .05 |     .20 |    .20 | family, width, angular      |

이 weight는 Round 2 정답을 맞추도록 sample별로 바꾸는 값이 아니다. 별도 calibration
anchor deck에서 먼저 확인하고 fresh gate를 열기 전에 hash와 함께 동결한다.

### 6.3 distance 외 hard gate

| gate         | pass                                    | conditional/marginal             | fail/unacceptable                                            |
| ------------ | --------------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| family       | source와 같은 printed/hand/display 골격 | 경계가 불명확하거나 한 단계 차이 | clear serif↔sans, hand↔mechanical, body↔extreme display 역전 |
| critical gap | 모든 critical axis 차이 ≤ 1.0           | 한 축 차이 1.5–2.0               | 한 축 ≥ 2.5 또는 두 축 ≥ 2.0                                 |
| treatment    | 앱이 같은 효과를 재적용 가능            | 일부만 가능해 수동 보정 필요     | 효과 제거 시 역할 목소리가 사라지거나 지원 불가              |
| deployment   | native/small과 writing mode 모두 정상   | 한 크기에서 개성 또는 fit 저하   | clipping, fallback, unreadable                               |

family gate는 장르 prior가 아니다. 영애물/액션물이라는 이유로 serif/sans를 정하지
않고 source glyph에서 보이는 획 대비와 종단으로만 정한다.

### 6.4 tier의 기계적 경계

threshold는 다음 fresh round 전 별도 anchor deck에서 한 번 검증하고 고정한다.

- `preferred`
  - 모든 hard gate pass
  - `D_style ≤ 0.16`
  - 최저 거리에서 `+0.04` 이내
  - 기본 1개, 진짜 동률일 때만 최대 2개
- `acceptable`
  - 모든 hard gate pass
  - `0.16 < D_style ≤ 0.28`
  - critical-axis gap ≤ 1.0
  - 손으로 family를 바꾸지 않고 저장 가능
- `marginal`
  - `0.28 < D_style ≤ 0.45`, 또는 conditional gate 1개
  - family 교체나 강한 보정 가능성이 있으므로 자동 적용 금지
- `unacceptable`
  - `D_style > 0.45`, hard gate fail, 또는 critical mismatch 2개 이상
- `unrenderable`
  - 오직 fallback, glyph missing, clipping 등 기술 실패

`preferred`가 없고 `acceptable`만 있는 것은 허용한다. 가장 가까운 후보라는 이유만으로
`preferred`를 강제하지 않는다.

### 6.5 넓은 safe set 차단

quality-first 정책으로 다음을 validation error로 취급한다.

1. 기본 `preferred + acceptable` 상한은 2개다.
2. 세 번째 safe 후보는 세 후보 모두 `D_style` 차이가 0.04 이내이고,
   role-weighted candidate 간 최대 거리도 0.18 이하이며, adjudicator가 명시적으로
   승인한 경우에만 허용한다.
3. safe 4개 이상은 자동 invalid다.
4. 각 safe alias는 최소 2개의 `matched_hard_axes`, `largest_gap`, `D_style`을 남긴다.
5. safe set 안 두 후보가 서로 다른 confusion cluster에 있으면서 pairwise distance가
   0.18을 넘으면 둘 중 먼 후보를 marginal 이하로 내린다.
6. `읽힌다`, `무난하다`, `본문에도 가능하다`만으로 acceptable을 줄 수 없다.

이 규칙은 ordinary body 후보 중복을 줄이고, 실제 변칙 목소리가 있는 사례의 정밀한
positive/negative 경계를 남긴다.

### 6.6 근거 없는 전부 비-safe 차단

`none_acceptable=true`는 다음을 모두 만족해야 한다.

1. 7개 alias 모두 distance와 gate를 계산했다.
2. family pass이면서 `D_style ≤ 0.28`인 후보가 없다.
3. 가장 가까운 두 후보의 alias, distance, 실패한 hard axis를 기록했다.
4. controlled reason code를 하나 고른다:
   `missing_serif_printed`, `missing_sans_printed`, `missing_rough_hand`,
   `missing_fine_hand`, `missing_heavy_display`, `missing_soft_round`,
   `deployment_failure`, `other_explained`.
5. source family와 hard axis confidence가 모두 0.75 이상이다. 아니면 none이 아니라
   low confidence/adjudication이다.

반대로 하나라도 family pass + 거리 0.28 이하이면 none은 invalid다. “exact clone이
아니다”는 none 사유가 아니며, “7개 모두 비슷하지 않다”는 설명도 허용하지 않는다.

## 7. reviewer가 따라야 할 단일 decision order

1. source-only eligibility를 판정한다.
2. 후보를 보지 않고 semantic role을 봉인한다.
3. family와 treatment를 분리한다.
4. source 6축 signature와 hard axes를 봉인한다.
5. candidate canonical signature strip이 정상인지 확인한다.
6. role-conditioned/native/small/treatment A/B probe를 본다.
7. 7개 각각의 family gate, critical gap, deployment gate를 기록한다.
8. role weight로 `D_style`을 계산한다.
9. threshold로 임시 tier를 자동 산출한다.
10. safe-set diameter와 상한을 검사한다.
11. none guard를 검사한다.
12. 이 단계까지 통과한 후보가 동률일 때만 chapter anchor, 그다음 work anchor를
    tie-breaker로 쓴다.
13. source가 명확히 변칙이면 chapter ordinary-body anchor가 override를 덮지 못한다.
14. 마지막에만 rationale을 쓴다. rationale은 이미 기록한 축과 gate를 요약해야 한다.

이 순서에서 chapter 일관성은 ordinary balloon body에는 강한 soft prior가 되지만,
aside, 끄적인 문장, 부분 강조, shout, SFX의 실제 source 변화보다 앞설 수 없다.

## 8. 다음 fresh calibration 운영안

### 8.1 anchor deck와 gate deck 분리

- 12–16건의 adjudicated anchor deck으로 축 정의, distance 예제,
  none/non-none 경계를 reviewer가 먼저 맞춘다.
- anchor deck은 training과 fresh gate에서 영구 제외한다.
- reviewer가 anchor 답을 본 뒤 rubric/threshold를 바꾸지 않고 새 gate deck으로 간다.
- gate 실패 후 같은 sample을 보며 threshold를 조정하지 않는다. 수정 후 완전히 새
  sample로 다음 round를 연다.

### 8.2 60건 variant-priority 층화

| 층                                  | 수량 | 목적                                         |
| ----------------------------------- | ---: | -------------------------------------------- |
| ordinary dialogue/narration/thought |    8 | chapter consistency와 serif/sans 경계만 검증 |
| aside/whisper/handwritten           |   12 | 작은 글씨와 손글씨 변칙                      |
| emphasis/shout                      |   12 | utterance 내부 변화와 전체 고함 분리         |
| SFX 5종                             |   20 | impact/motion/ambient/emotion/comic 각 4건   |
| sign/UI/title                       |    8 | bounded label과 SFX/대사 경계                |

한 작품의 반복 visual cluster가 gate를 채우지 못하게 work당 최대 2건, 같은 page당
1건을 기본으로 한다. 동일 cluster 반복은 metric weight 0의 consistency audit로만 둔다.

### 8.3 두 번의 독립 판정

1. 두 reviewer가 source-only role/style card를 독립 판정한다.
2. role 또는 hard family가 다르면 후보 card를 열지 않고 adjudicate한다.
3. 합의된 role/style snapshot을 두 reviewer에게 동일하게 제공한다.
4. candidate order를 각각 다르게 randomize한 tier card를 독립 판정한다.
5. decision 제출 후에만 agreement를 계산한다.

### 8.4 gate

기존 gate에 다음 진단을 추가한다.

- role macro-F1 ≥ 0.85
- tier pairwise agreement ≥ 0.80
- 전체 safe Jaccard ≥ 0.70
- **non-empty safe Jaccard ≥ 0.70**
- `none_acceptable` agreement ≥ 0.90
- hard-family agreement ≥ 0.90
- observable 6축의 평균 reviewer 차이 ≤ 0.5 bin
- safe-set breadth violation 0건
- unexplained none 0건
- eligibility exception 0건

빈 집합끼리의 합의와 실제 후보 선택 합의를 분리 보고해야 한다. Round 2처럼
overall Jaccard 0.525가 candidate-bearing Jaccard 0.345를 가리는 상황을 허용하지 않는다.

## 9. 향후 decision record에 필요한 근거 구조

현재 free-text rationale만으로는 판정을 재현할 수 없다. 다음 구현 단계에서는 최소
다음 구조를 공개 blind decision에 추가한다.

```text
source_style:
  family_gate
  six_axis_values
  axis_confidence
  hard_axes
  treatment

candidate_evidence[alias]:
  family_gate_result
  six_axis_distance
  critical_gaps
  deployment_result
  provisional_tier

safe_set_check:
  size
  diameter
  override_reason

none_evidence:
  reason_code
  nearest_two
```

이 값은 model score나 font identity가 아니다. reviewer가 어떤 픽셀 차이를 근거로
판정했는지 감사 가능하게 만드는 blind evidence다.

## 10. production으로 넘길 때의 원칙

- ordinary body는 같은 화에서 source family가 같으면 chapter anchor를 유지한다.
- ordinary body가 충분히 중복되면 학습 weight를 줄이고 consistency audit에 남긴다.
- variant는 role 이름만으로 고르지 않고 source signature와 candidate distance로 고른다.
- 같은 말풍선 안에서도 실제 weight/family/handwritten 변화가 있으면 대응 한국어
  font도 달라지는 것이 정상이다.
- SFX, aside, 끄적인 문장, 부분 강조는 generic body로 평탄화하지 않는다.
- catalog가 source family를 제공하지 못하면 none을 정확히 남기되, nearest-two와
  missing-family reason을 함께 남겨 다음 font 추가 우선순위로 사용한다.

v4의 목적은 safe 후보 수를 늘리는 것이 아니다. **작은 safe set은 설명 가능하게,
빈 safe set은 반증 가능하게**, 그리고 변칙적인 source의 시각적 목소리는 chapter
일관성보다 우선해서 보존하는 것이다.
