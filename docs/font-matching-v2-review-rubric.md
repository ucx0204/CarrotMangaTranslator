# Font Matching V2 육안검수 규약

이 규약은 `font-label-v1` primary, secondary, adjudication에 공통으로 적용한다. 목표는 원문의 일본어 글자 내용을 맞히는 것이 아니라, 앱의 한글 후보 중 **같은 만화 역할과 시각적 목소리로 보이는 후보**를 판정하는 것이다.

> 2026-08-01 재보정 상태: 첫 255건 독립 이중검수는 role macro-F1 0.6362,
> tier pairwise agreement 0.5747, acceptable-set Jaccard 0.4714로 gate를
> 통과하지 못했다. 아래의 v2 판정 보강 규칙으로 fresh calibration gate를 먼저
> 통과하기 전에는 수만 건 production label을 확정하지 않는다.

## 1. 판정 순서

각 sample은 아래 순서대로 한 번도 건너뛰지 않고 본다.

1. 원본 페이지의 bbox와 raw/context/glyph를 대조해 crop이 온전한 실제 글자인지 확인한다.
2. 페이지 문맥으로 의미 역할을 정한다.
3. 외곽선·색·역상·그림자와 font family의 골격을 분리해 기록한다.
4. 이름이 가려진 15개 family 후보를 전부 보고 tier를 정한다.
5. 작품 본문 anchor를 상속할지, 의도적 예외인지 정한다.
6. role confidence와 전체 review confidence 중 하나라도 `0.75` 미만이면 `low_confidence`를 붙인다.

빨간 bbox, 좌표, 워터마크가 들어간 review 카드 자체는 학습 이미지가 아니다. 원본 view에서 그런 표식이 발견되면 `crop_needs_review`와 `rendering_issue`를 기록하고 재검수 큐로 보낸다.

### 1.1 font family 식별 가능성 gate

crop이 올바른 실제 텍스트여도 family 학습에 항상 유효한 것은 아니다. 말줄임표,
마침표, 물음표·느낌표 하나, 장식선처럼 family의 serifness·폭·획 대비·필기 리듬을
판정할 글자 골격이 없으면 `font_signal_absent`로 별도 격리한다.

- `font_signal_absent`는 `none_acceptable`과 다르다. 전자는 원문에서 family를
  식별할 수 없다는 뜻이고, 후자는 원문 family는 식별되지만 현재 catalog에 안전한
  대응 후보가 없다는 뜻이다.
- 식별 불가능 sample은 role·orientation·treatment 학습에는 사용할 수 있지만 font
  retrieval/listwise/pairwise loss, catalog ceiling, 새 후보 rescue 분모에서는 제외한다.
- 자동 휴리스틱은 audit 후보만 만들 수 있다. 최종 absent/eligible 결정은 raw,
  glyph, context와 페이지를 본 사람이 내리고 별도 sealed eligibility ledger에 남긴다.
- 한두 글자라도 `획 골격`이 충분하면 짧다는 이유만으로 제외하지 않는다. 반대로
  긴 crop이어도 같은 점·선만 반복되면 family signal이 생기지 않는다.

## 2. 역할 결정

- `dialogue`: 보통 크기·톤의 실제 발화. 말풍선 유무만으로 결정하지 않는다.
- `narration`: 화자 밖의 설명, 시간·장소·상황을 전달하는 캡션.
- `thought`: 인물의 내면 독백. 생각 풍선뿐 아니라 독백형 자유 배치도 포함한다.
- `whisper`: 작게 말함, 숨죽임, 약한 목소리가 문맥과 조판에서 명확한 발화.
- `aside_balloon_edge`: 말풍선 옆·꼬리·바깥에 붙은 짧은 덧말, 츳코미, 작은 손글씨 메모. 단순 detector 위치만으로 지정하지 않는다.
- `emphasis_dialogue`: 한 대사 안에서 일부 단어·구만 별도 서체나 굵기로 강조된 경우.
- `shout`: 발화 전체가 고함·절규·명령처럼 높은 에너지를 갖는 경우.
- `sfx_impact`: 충돌·폭발·타격처럼 순간적인 강한 사건.
- `sfx_motion`: 이동·스침·휘두름·속도·진행을 나타내는 소리나 의태어.
- `sfx_ambient`: 바람·비·정적·웅성거림처럼 장면에 지속되는 배경음.
- `sfx_emotion`: 두근거림·오싹함·초조함 등 인물의 신체·감정 상태를 나타내는 의태어.
- `sfx_comic`: 삐질, 짜잔, 데헷 같은 희극적 반응·타이밍용 효과.
- `sign_ui_title`: 간판, 표지 제목, 장 표시, 게임/UI, 기기 화면 등 세계 안의 표시 텍스트.
- `other`: 실제 역할은 알지만 위 분류에 안정적으로 들어가지 않는 텍스트.
- `unknown_needs_review`: crop 또는 문맥이 부족해 역할 자체를 판정할 수 없는 경우. 어려워 보인다는 이유만으로 쓰지 않는다.

손글씨·명조·거침·둥글음은 역할이 아니라 `source_style`이다. 예를 들어 손글씨는 말풍선 옆글, 독백, 감정 효과음 어디에도 나타날 수 있다.

### 2.1 자주 혼동된 역할의 강제 판별 규칙

- `emphasis_dialogue`는 **같은 발화 안의 주변 글자와 다른 family·weight·크기라는
  대비 증거**가 있을 때만 쓴다. 대사 전체가 굵거나 크게 쓰였으면 감정과 문맥에
  따라 `dialogue` 또는 `shout`이며, 굵다는 이유만으로 emphasis가 아니다.
- `thought`는 인물이 소리 내지 않았다는 페이지 문맥 증거가 필요하다. 자유 배치,
  작은 글자, 둥근 풍선 모양만으로 thought로 올리지 않는다. 문맥을 판정할 수 없으면
  억지 추론하지 않고 `unknown_needs_review`로 보낸다.
- `narration`은 장면 밖 설명·시간·장소·상황 전달이어야 한다. 사각 캡션 안에 있다는
  이유만으로 narration이 아니며, 인물의 내면 문장이면 thought다.
- `aside_balloon_edge`는 본 대사와 독립된 짧은 덧말·메모라는 관계가 보여야 한다.
  단순히 말풍선 경계 가까이에 검출됐다는 이유로 지정하지 않는다.
- `shout`는 발화 전체의 높은 음량·절규·명령이 문맥으로 확인돼야 한다. 한 단어만
  다른 서체면 emphasis다.
- SFX 하위 역할은 원문의 읽기보다 사건의 기능으로 나눈다. 순간 충돌은 impact,
  이동 과정은 motion, 지속 환경은 ambient, 신체·감정 상태는 emotion, 희극적
  타이밍은 comic이다. 둘 이상이 정말 동률이면 confidence를 0.75 미만으로 낮춰
  adjudication으로 보낸다.

## 3. 시각 속성 점수

모든 연속값은 `0, 0.25, 0.5, 0.75, 1`을 기본 눈금으로 쓴다. 중간값은 실제로 두 눈금 사이임이 분명할 때만 사용한다. 보이지 않거나 crop 때문에 판단할 수 없는 필드는 `null`과 `unknown_fields`에 함께 기록한다.

- `serifness`: 획 끝 장식과 명조 구조가 없음 → 강함.
- `weight`: 매우 가는 획 → 매우 굵은 획.
- `width`: 극도로 압축됨 → 넓게 벌어짐.
- `roundness`: 각지고 직선적임 → 둥글고 부드러움.
- `stroke_contrast`: 획 굵기 차가 거의 없음 → 굵고 가는 획 대비가 큼.
- `handwritten`: 기계적 활자 → 사람 손의 필기 리듬이 강함.
- `angularity`: 곡선 중심 → 날카로운 모서리·절단이 강함.
- `irregularity`: 글자별 크기·기선·간격이 일정함 → 의도적으로 크게 흔들림.
- `slant`: 수직에 가까움 → 일관된 기울기·속도감이 강함.
- `energy`: 정적·차분함 → 폭발적·공격적 움직임.

외곽선, 그림자, 흰 글자/검은 배경, 왜곡은 `treatment`로 기록하고 family tier의 주된 근거로 삼지 않는다. 다만 후보 family의 본래 골격이 후처리를 견딜 수 있는지는 style fit에 포함할 수 있다.

## 4. 후보 tier

15개 후보를 반드시 정확히 한 tier에 넣는다.

- `preferred`: 이 sample에 그대로 적용해도 원작의 역할과 목소리를 충실히 보존한다. 공동 1위가 실제로 동급이면 여러 개를 허용한다.
- `acceptable`: 약간의 인상 차이는 있지만 독자가 부자연스럽다고 느끼지 않고 작품 정책에도 사용할 수 있다.
- `marginal`: 읽을 수 있고 역할도 완전히 틀리지는 않지만, 원작 인상이 분명히 약해지거나 별도 weight/outline 보정 없이는 쓰고 싶지 않다.
- `unacceptable`: 역할·시대감·골격·에너지가 충돌해 실제 자동 적용을 허용하면 안 된다.
- `unrenderable`: 실제 카드가 깨짐, fallback, 글리프 누락, 잘림으로 비교 자체가 불가능하다. 취향이 나쁘다는 뜻이 아니다.
- `not_reviewed`: 기술적 이유로 후보가 카드에 없거나 확인하지 못했다. 시간 절약 용도로 쓰지 않는다.

### 4.1 v2 배포 가능성 기준

`preferred/acceptable`의 질문은 "비슷한 부분이 있는가"가 아니다. 다음 질문에
**예**라고 답할 수 있는가다.

> 이 후보가 현재 앱에서 자동 적용되고 페이지 전체를 보았을 때, 내가 family를
> 손으로 바꾸지 않은 채 결과를 저장할 것인가?

각 후보를 아래 네 축에서 `0/1/2`로 확인한다. 점수는 근거를 빠뜨리지 않기 위한
체크리스트이며 취향 점수를 평균내기 위한 것이 아니다.

1. 역할의 목소리: 해당 대사·독백·옆글·SFX의 기능과 충돌하지 않는가.
2. 골격과 리듬: weight, width, serifness, roundness, handwritten,
   irregularity, energy가 원문과 같은 방향인가.
3. 실제 배포성: 한글로 렌더했을 때 읽을 수 있고 후처리·축소·세로쓰기에서도
   family의 인상이 무너지지 않는가.
4. 작품 정책: ordinary body는 익명화된 같은 작품 anchor와 어울리고, 의도적
   예외는 같은 역할 palette 안에서 반복 사용 가능한가.

- `preferred`: 네 축 모두 충족하고, 동급 후보 중 원문의 시각적 목소리를 가장 잘
  보존하는 최소 top set이다.
- `acceptable`: 자동 적용 후 family를 유지할 수준이지만 preferred보다 한 축에서
  경미한 차이가 있다.
- `marginal`: 읽을 수는 있으나 실제 페이지에서는 family를 바꾸거나 강한 보정이
  필요할 가능성이 높다.
- `unacceptable`: 역할 충돌, 뚜렷한 style 역전, 가독성/글리프/방향 문제 중 하나라도
  있어 자동 적용을 허용할 수 없다.

preferred/acceptable 개수에 임의 상한을 두지는 않는다. 다만 전체 후보의 절반을
넘으면 "서로 다른 family들을 실제로 그대로 둘 것인가"를 한 번 더 확인하고,
preferred·acceptable·marginal 경계 근거를 notes에 남긴다. 단순히 무난하거나 읽을
수 있다는 이유는 acceptable 근거가 아니다.

`preferred`와 `acceptable`이 모두 비어 있으면 `none_acceptable=true`다. `marginal`이 하나 있다는 이유로 억지 추천하지 않는다. 반대로 acceptable이 하나라도 있으면 false다.

일본어와 한글의 글자 모양이 우연히 닮았는지를 평가하지 않는다. 획의 무게, 폭, 대비, 둥글음, 필기성, 불규칙성, 에너지와 만화 역할을 비교한다.

## 5. 작품 일관성

- 평범한 `dialogue`는 `inherit_work_anchor`가 기본이다. 개별 crop마다 근소한 차이로 폰트를 바꾸지 않는다.
- `narration`과 `thought`는 작품에서 반복되는 별도 anchor가 관찰될 때만 분리한다.
- `aside_balloon_edge`, 손글씨, 강조, SFX는 `intentional_override`가 가능하다.
- SFX 다양성은 무작위로 늘리지 않는다. 같은 작품·같은 역할·비슷한 시각 클러스터는 2–4개 허용 palette 안에서 반복 일관성을 유지한다.
- 장르는 약한 참고값일 뿐이다. 영애물이라는 이유만으로 명조를, 액션물이라는 이유만으로 고딕·display를 선택하지 않는다. 먼저 원본 style과 작품 내 반복 증거를 보고, 장르 정보가 없어도 같은 판정이 나와야 한다.
- 사용자 block lock, 작품 역할 lock, 사용자가 저장한 anchor는 자동 추천보다 항상 우선한다.

## 6. 독립검수와 재판정

secondary reviewer는 primary 결과, font 이름, reveal map, 모델 제안을 보지 않는다. 다음은 전부 adjudication 대상이다.

- primary/secondary role 불일치
- preferred/acceptable 집합 또는 tier 순서 불일치
- `none_acceptable`
- role/review confidence 중 하나라도 0.75 미만
- `crop_needs_review`, `catalog_gap`, `rendering_issue`, `policy_uncertain`
- 수동 재크롭 39건

adjudicator는 두 답 중 하나를 기계적으로 고르지 않고 원본 페이지와 모든 후보를 다시 본다. 최종 레코드는 어떤 증거를 보고 무엇을 바꿨는지와 review-card SHA를 함께 봉인한다.

### 6.1 확장 22종 delta review

- 기존 15종 final은 새 7종의 tier를 자동으로 결정하지 않는다. 활성 sample 1,189개
  모두에서 새 후보 7개, 총 8,323 candidate cell을 다시 본다.
- reviewer에게 font 이름, 기존 tier, split, 작품 제목·장르, 모델 점수를 숨긴다.
  같은 작품 참고가 필요하면 익명화된 anchor 이미지만 제공한다.
- 기존 `none_acceptable`, SFX, 옆글, 강조, shout, 손글씨/불규칙, 수동 재크롭은
  100% 독립 secondary review한다. 나머지도 결정론적으로 최소 20%를 이중검수한다.
- 새 후보가 preferred/acceptable이면 기존 후보와 상대 순위를 adjudicator가 다시
  확인한다. 기존 tier와 새 tier의 단순 합집합으로 22종 final을 만들지 않는다.
- 교체된 crop successor에는 parent label을 승계하지 않는다. successor 자체의
  22종 카드가 완료되기 전까지 unlabeled로 남긴다.

### 6.2 production 진입 calibration gate

fresh development-only calibration에서 아래 세 항목을 모두 통과해야 전수 review를
시작한다.

- role macro-F1 ≥ 0.85
- tier pairwise agreement ≥ 0.80
- acceptable-set Jaccard ≥ 0.70

실패하면 사람 수를 늘려 평균내지 않는다. confusion pair와 tier 경계 예시를 다시
합의하고, 기존 calibration 답을 보지 않은 새 표본으로 재측정한다.

## 7. 완료 전 빠른 점검

- 모든 후보를 보았는가?
- 역할과 손글씨/명조 같은 style을 섞지 않았는가?
- 외곽선·역상 때문에 다른 family로 오인하지 않았는가?
- `none_acceptable`을 두려워해 marginal 후보를 억지 승격하지 않았는가?
- 일반 대사에 불필요한 작품 내 폰트 전환을 만들지 않았는가?
- 작품명·장르·모델 제안에 먼저 끌리지 않았는가?
- QA 표식이 학습 view로 들어가지 않았는가?
