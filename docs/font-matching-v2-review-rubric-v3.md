# Font Matching V2 육안검수 규약 v3

이 규약은 확장 22종 한글 폰트 catalog의 blind primary, secondary,
adjudication에 공통 적용한다. 목표는 일본어 글자 모양을 복제하는 것이 아니라,
한국어로 바꿨을 때도 원문의 **만화 역할, family 골격, 시각적 목소리와 화 내
일관성**을 보존하는 것이다. 데이터 양보다 한 건의 정확한 eligibility·role·tier
판정이 우선한다.

## 1. 반드시 지킬 판정 순서

1. raw, glyph, context, 원본 페이지를 대조해 crop이 온전한 실제 글자인지 본다.
2. 글자가 수행하는 사건·발화 기능으로 semantic role을 정한다.
3. family 골격과 outline·shadow·역상·왜곡 treatment를 분리한다.
4. 이름이 가려진 후보를 전부 보고 각 후보에 먼저 `save unchanged? yes/no`를
   답한다.
5. yes 후보만 preferred/acceptable 후보가 될 수 있다. 그 뒤 상대 tier를 정한다.
6. source family와 hard style 축이 동률인 후보 사이에서만 익명화된 화/작품 anchor를
   tie-breaker로 쓴다.
7. role confidence와 review confidence 중 하나라도 0.75 미만이면
   `low_confidence`로 보내며 억지 확정하지 않는다.

review 카드의 cyan/red bbox, 좌표, `REVIEW-ONLY` watermark는 학습 픽셀이 아니다.
원본 view 자체에 이런 표식이 있으면 `crop_needs_review`와 `rendering_issue`로
격리한다.

## 2. font-signal eligibility

- 완전한 글자 골격이 있고 이웃 글자를 자르지 않았다면 짧은 구절도
  `font_signal_present`일 수 있다.
- 점·선·말줄임표·문장부호 하나처럼 serifness, 폭, 획 대비, 필기 리듬을 판정할
  골격이 없으면 `font_signal_absent`다.
- glyph가 잘렸거나, 동일 text object의 장음·붙은 문장부호·outline·변형을 잘라
  family/style 판정을 바꾸면 `crop_needs_review`다. 단지 문장의 중간 구절이라는
  이유만으로는 제외하지 않는다.
- `font_signal_absent`는 catalog에 적합 후보가 없다는 `none_acceptable`과 다르다.
- eligibility가 primary/secondary 사이에 다르면 font tier agreement 분모에서 빼고
  fresh replacement로 교체한다. 자동 휴리스틱은 최종 eligibility를 정할 수 없다.

## 3. semantic role

- `dialogue`: 보통 크기·톤의 실제 발화.
- `narration`: 화자 밖에서 시간·장소·상황을 설명하는 캡션.
- `thought`: 소리 내지 않은 내면 독백이라는 페이지 문맥 증거가 있는 문장.
- `whisper`: 작게 말함·숨죽임이 실제 발화로 명확한 경우.
- `aside_balloon_edge`: 본 대사와 독립된 말풍선 옆·꼬리·바깥의 덧말, 츳코미,
  작은 손글씨 메모.
- `emphasis_dialogue`: 같은 utterance 안에서 주변 글자와 family·weight·size가 실제로
  다른 부분 강조.
- `shout`: 발화 전체가 고함·절규·명령인 경우.
- `sfx_impact`: 충돌·폭발·타격·flash·발동처럼 순간 사건.
- `sfx_motion`: 이동·스침·휘두름·상태 전환의 진행.
- `sfx_ambient`: 바람·비·정적·웅성거림처럼 지속되는 배경.
- `sfx_emotion`: 두근거림·오싹함·호흡·신음처럼 몸이나 감정 상태.
- `sfx_comic`: punchline, gag 반응, 희극적 timing.
- `sign_ui_title`: 간판·장 제목·상태표·게임/UI·기기 화면 등 bounded label.
- `other`: 역할은 알지만 위 분류에 안정적으로 들어가지 않는 실제 텍스트.
- `unknown_needs_review`: crop/context가 부족해 역할 자체를 판정할 수 없는 경우.

### 3.1 강제 경계 규칙

- SFX를 고르기 전에 “무엇이 충돌하고, 움직이고, 지속되고, 느껴지고, 웃음을
  만드는가”를 한 문장으로 적는다. 둥글거나 귀여운 family라는 이유로 comic을
  고르지 않는다.
- 말풍선 밖의 호흡·신음이 몸 상태를 나타내면 `sfx_emotion`이다. 실제 발화라는
  증거가 있을 때만 whisper/dialogue다.
- bounded 상태표는 comic timing이 있어도 `sign_ui_title`이다.
- `emphasis_dialogue`는 같은 utterance의 비교 대상이 context에 보여야 한다.
  비교 대상이 없으면 emphasis로 추정하지 않는다.
- 자유 배치·사각 캡션·작은 글자만으로 thought/narration을 정하지 않는다.
  발화 여부와 전달 기능을 페이지 문맥에서 확인한다.
- handwritten, serif, rough, round는 역할이 아니라 `source_style`이다.

## 4. source style과 treatment

연속 style 값은 기본적으로 `0, 0.25, 0.5, 0.75, 1` 눈금을 쓴다. 보이지 않으면
추측하지 않고 `null` 및 `unknown_fields`에 넣는다.

- `serifness`, `weight`, `width`, `roundness`, `stroke_contrast`
- `handwritten`, `angularity`, `irregularity`, `slant`, `energy`

outline, shadow, inverse fill, distortion은 treatment다. 내부 skeleton을 먼저 본다.
outline 때문에 굵어 보이는 glyph를 초굵은 family로 오인하지 않는다. 반대로 나중에
outline을 넣을 수 있다는 이유로 초세필 family를 굵고 거친 손붓 source에 안전
승격하지 않는다. 앱에서 실제 지원하는 treatment만 고려하며 family-level 굵기와
리듬 차이가 후처리로 사라진다고 가정하지 않는다.

## 5. 후보 tier

7개 delta 후보를 각각 정확히 한 tier에 넣는다.

- `preferred`: 그대로 적용하고 저장할 수 있는 후보 중 원문의 목소리를 가장 잘
  보존하는 최소 top set.
- `acceptable`: family를 손으로 바꾸지 않고 저장할 수준이지만 preferred보다 한
  축에서 경미하게 다름.
- `marginal`: 읽히지만 family 변경 또는 강한 보정이 필요할 가능성이 높음.
- `unacceptable`: 역할 목소리나 hard family 축을 뒤집어 자동 적용을 허용할 수 없음.
- `unrenderable`: fallback·글리프 누락·잘림 등 기술 실패로 비교 자체가 불가능함.

각 후보는 아래 네 축을 확인한다.

1. 역할의 목소리를 유지하는가.
2. weight, width, serifness, roundness, handwritten, irregularity, energy가 같은
   방향인가.
3. 한국어, 축소, 세로쓰기와 현재 treatment에서 실제 배포 가능한가.
4. ordinary body anchor 또는 의도적 palette 안에서 반복 사용 가능한가.

`preferred/acceptable`은 단순히 읽히거나 무난하다는 뜻이 아니다. aside, 손글씨,
부분 강조, shout, SFX를 generic body로 평탄화하는 후보는 읽혀도 acceptable이
아니다. handwritten/irregularity/energy/weight/width 중 목소리를 결정하는 hard 축이
반대로 뒤집히면 marginal 이하이며, 역할 목소리까지 사라지면 unacceptable이다.

hard family/role 역전은 없고 treatment 또는 경미한 weight 차이만 있으면 marginal,
명조↔고딕·handwritten↔mechanical·저에너지 body↔공격적 display처럼 목소리가
뒤집히면 unacceptable이다. 후보 배열 순서는 의미가 없다.

### 5.1 `none_acceptable`

`preferred`와 `acceptable`이 모두 비어 있을 때만 true다. 여기서 none은 22종 전체가
아니라 **새 7종 중 unchanged-safe 후보가 없다**는 뜻이다.

- source가 명조/세리프 또는 굵고 불규칙한 손글씨인데 새 7종이 core family를
  재현하지 못하면 generic sans/display를 강제로 뽑지 않는다.
- neutral Gothic ordinary dialogue가 weight·width·roundness까지 맞으면 exact
  clone이 아니라는 이유만으로 none을 쓰지 않는다.
- marginal 하나가 있다는 이유로 safe tier로 올리지 않는다.

## 6. 화/작품 일관성과 intentional override

ordinary `dialogue`는 source의 hard family 축을 먼저 판정한다. clear
명조↔고딕, handwritten↔mechanical, 초세필↔굵은 display 역전을 anchor로 덮지
않는다. hard family 축이 모두 맞는 후보가 동률일 때만 chapter anchor, 그 다음 work
anchor를 preferred tie-breaker로 쓴다.

화 내 일관성은 soft prior다. source family 변화가 페이지에서 명확하면 같은 말풍선
안팎이라도 대응되는 한국어 폰트가 달라지는 것이 정상이다. 다음 중 하나를 rationale에
직접 인용할 수 있을 때 `intentional_override`가 가능하다.

- 같은 utterance 주변 글자와 실제 family·weight·size가 다름.
- 말풍선 밖 독립 handwritten aside.
- utterance 전체의 shout/whisper 에너지.
- SFX 사건 기능과 반복 visual cluster.
- bounded sign/UI/title label.

장르, detector 위치, 큰 글자, outline만으로 override를 만들지 않는다. 영애물이라서
명조, 액션물이라서 고딕을 고르는 식의 shortcut도 금지한다. 장르는 source evidence와
동률일 때만 약한 prior다. 사용자 block lock, 화/작품 role lock, 저장된 anchor가 자동
추천보다 우선한다.

ordinary body 중복은 작품·화·동일 visual cluster당 대표와 실제 경계 사례만 남긴다.
anchor가 충분히 관찰된 중복 crop은 label count가 아니라 consistency audit 용도로만
둘 수 있다. 변칙군을 밀어낼 만큼 body 사례를 반복하지 않는다.

## 7. 독립검수와 변칙군 우선순위

secondary는 primary 답, font 이름, reveal map, 기존 tier, 작품 제목·장르, 모델 점수를
보지 않는다. 다음은 100% 독립 secondary review 대상이다.

- 기존 `none_acceptable` 및 eligibility 위험군
- `aside_balloon_edge`, `emphasis_dialogue`, `shout`, `whisper`
- SFX 5종과 `sign_ui_title`
- handwritten 또는 irregularity가 높은 사례
- 수동 재크롭과 actual source family override

나머지 ordinary body도 결정론적 표본을 이중검수한다. primary/secondary role, safe
set, tier ordering, none, eligibility가 다르거나 confidence가 낮으면 adjudicator가
원본과 모든 후보를 새로 보고 근거와 review-card SHA를 봉인한다. 교체 crop은 parent
label을 상속하지 않는다.

## 8. fresh calibration gate

round 1 실패 답은 round 2 reviewer에게 노출하지 않는다. fresh round는 아래를 모두
통과해야 production을 연다.

- role macro-F1 ≥ 0.85
- tier pairwise agreement ≥ 0.80
- acceptable-set Jaccard ≥ 0.70
- `none_acceptable` agreement ≥ 0.90
- eligibility exception 0건; 발견 시 해당 sample을 fresh replacement로 교체

기존 val double-review 표본을 재사용하지 않는다. fresh val이 부족하면 independent
double-review train pool에서 결정론적으로 40개를 뽑아 즉시
`calibration_only`로 전환한다. 선택 sample뿐 아니라 동일 page, crop SHA, root/variant,
normalized glyph, source lineage closure를 영구 training quarantine에 넣는다. 이 목록과
rubric/card manifest SHA를 계약에 봉인하며 feature cache, prototype fitting, optimizer,
augmentation, hard-negative mining에서 0회 읽는다. test pixel·label도 0회다.

calibration은 ordinary dialogue를 소수 anchor/경계 사례로 제한하고, aside·handwritten,
partial emphasis, shout, whisper, sign/UI, SFX 기능 경계를 우선 층화한다. 동일 visual
cluster 반복은 하나만 gate metric에 넣고 나머지는 weight 0의 repeat-consistency
진단으로 둔다.

## 9. 완료 전 점검

- eligibility, role, family, treatment 순서를 지켰는가?
- 후보 7개 모두에 unchanged-save 판단을 했는가?
- generic body로 변칙 목소리를 지우지 않았는가?
- none을 두려워해 marginal을 승격하지 않았는가?
- anchor가 실제 source family 변화를 덮지 않았는가?
- 같은 화의 불필요한 폰트 전환과 필요한 override를 모두 구분했는가?
- 장르·작품명·모델 제안·후보 순서에 끌리지 않았는가?
- QA overlay, synthetic/generated pixel을 학습 view로 쓰지 않았는가?
