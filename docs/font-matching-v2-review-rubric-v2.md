# Font Matching V2 육안검수 규약 v2

이 문서는 pilot v1의 독립 이중검수 결과가 역할 macro-F1 `0.6362`, tier pairwise agreement `0.5747`, acceptable-set Jaccard `0.4714`로 gate를 통과하지 못한 뒤 만든 보정 규약이다. v1 카드·응답·최종판정은 당시 규약과 hash를 보존하고 소급 수정하지 않는다. v2는 새로운 development calibration 표본에서 독립적으로 검증한 뒤에만 28,115건 전수 라벨링에 사용한다.

목표는 원문의 일본어 글자를 닮은 한글 글자를 고르는 것이 아니다. 원본의 **배치 역할, 시각적 목소리, 작품 안에서의 반복 규칙**을 앱의 실제 한글 후보로 보존하는 것이다.

## 1. 반드시 지키는 네 단계

한 sample 안에서도 아래 단계를 섞지 않는다.

1. **입력 무결성:** 원본 페이지, local context, raw, glyph를 대조해 bbox가 실제 글자 전체를 포함하는지 확인한다. 카드의 `HORIZONTAL` 같은 메타데이터보다 실제 글자 흐름을 우선한다.
2. **역할:** 먼저 배치 채널을 고르고, 그다음 발화 강도 또는 SFX 원인을 고른다. 폰트 후보는 아직 보지 않는다.
3. **원본 모양:** family 골격과 outline·shadow·fill·왜곡 같은 treatment를 분리해 기록한다.
4. **후보와 작품 정책:** 이름이 가려진 후보 15개를 전부 비교한 뒤 tier를 정한다. 작품 anchor 판정은 익명화된 같은 작품 reference가 카드에 있을 때만 내린다.

빨간·청록 bbox, 좌표, 워터마크가 들어간 review 카드는 QA 전용이다. 학습 view나 source crop으로 복사하지 않는다.

## 2. 역할은 계층적으로 고른다

### 2.1 1차: 배치 채널

- **speech:** 인물이 실제로 말하는 본문 발화.
- **inner:** 특정 인물의 내면 목소리.
- **narrator:** 인물 발화 밖에서 시간·장소·상황을 설명하는 캡션.
- **edge-note:** 말풍선 본문과 분리되어 가장자리·꼬리·바깥에 붙은 짧은 덧말이나 메모.
- **sound-mimetic:** 사건·움직임·환경·감정 상태를 나타내는 비발화 효과음·의태어.
- **diegetic-display:** 간판, 표지, 장 표시, UI, 기기 화면 등 세계 안의 표시 텍스트.
- **other/unknown:** 역할은 보이지만 위 채널이 아니면 `other`, crop이나 문맥 부족으로 채널도 판단할 수 없으면 `unknown_needs_review`.

### 2.2 2차: 세부 역할

- speech + 보통 전달 → `dialogue`
- speech + 주 발화 전체가 작고 숨죽인 전달 → `whisper`
- speech + 부모 대사 중 독립된 일부 단어·구만 시각적으로 강조 → `emphasis_dialogue`
- speech + 주 발화 전체가 고함·절규·명령의 높은 음성 에너지 → `shout`
- inner → `thought`
- narrator → `narration`
- edge-note → `aside_balloon_edge`
- diegetic-display → `sign_ui_title`
- sound-mimetic은 아래 원인 순서로 하나를 고른다.
  - 충돌·폭발·타격처럼 순간 사건 → `sfx_impact`
  - 이동·스침·진행·속도 → `sfx_motion`
  - 바람·비·정적·웅성거림처럼 지속 환경 → `sfx_ambient`
  - 두근거림·오싹함·긴장처럼 신체·감정 상태 → `sfx_emotion`
  - 희극적 반응이나 타이밍 자체 → `sfx_comic`

### 2.3 경계 규칙

- **aside 대 whisper:** 작은 글씨라는 이유로 whisper가 아니다. 본문 발화와 분리된 부착 메모면 aside, 주 발화 자체가 약한 목소리면 whisper다.
- **dialogue 대 emphasis:** crop이 부모 대사의 일부로 분리된 강조 구간일 때만 emphasis다. 전체 대사가 굵다는 이유만으로 emphasis로 바꾸지 않는다.
- **emphasis 대 shout:** 폰트 변화만 있고 음성 강도가 유지되면 emphasis, 발화 전체의 고함이 핵심이면 shout다.
- **thought 대 narration:** 특정 인물에게 귀속되는 내면이면 thought, 장면 밖 설명자나 시간·장소 캡션이면 narration이다. 생각 풍선 모양만으로 결정하지 않는다.
- **SFX emotion 대 motion:** 인물 내부 상태가 원인이면 emotion, 물체나 몸의 이동이 원인이면 motion이다.
- **SFX comic:** 그림체가 귀엽다는 이유가 아니라 희극적 타이밍이 텍스트의 기능일 때만 쓴다.
- **sign/UI 대 SFX:** 읽히는 단어의 내용보다 패널·기기·간판에 고정된 표시인지 먼저 본다.
- 제목과 본문처럼 서로 다른 계층이 한 crop에 섞였으면 하나로 타협하지 않고 `crop_needs_review`와 split 필요를 기록한다.

## 3. 원본 style은 보이는 것만 기록한다

`serifness`, `weight`, `width`, `roundness`, `stroke_contrast`, `handwritten`, `angularity`, `irregularity`, `slant`, `energy`는 보조 supervision이다. 후보 tier의 대체물이 아니다.

- 기준점은 `0`, `0.5`, `1`이다. 직접 보이는 중간 단계일 때만 `0.25` 또는 `0.75`를 쓴다.
- 한두 획만 보여 판단할 수 없거나 treatment가 골격을 가리면 `null`과 `unknown_fields`를 쓴다. 억지 중간값을 넣지 않는다.
- 한 눈금(`0.25`) 차이는 calibration에서 허용 오차로 본다. 두 눈금 이상 차이만 style 재판정 사유로 삼는다.
- serif/handwritten/거침/둥글음은 역할이 아니다.
- outline, shadow, 역상, 색, 왜곡은 `treatment`다. family가 그 후처리를 견딜 골격인지 판단할 수는 있지만 treatment 자체를 닮았다는 이유로 preferred로 올리지 않는다.

## 4. 후보 tier는 실사용 행동으로 고정한다

후보 15개를 반드시 정확히 한 tier에 넣고, 다음 질문을 순서대로 적용한다.

1. 실제로 렌더되지 않았거나 fallback·글리프 누락·잘림 때문에 비교할 수 없는가? 그러면 `unrenderable`이다.
2. 이 후보를 적용한 결과를 사용자가 font family 수정 없이 그대로 출고해도 되는가?
3. 아니라면 작은 인상 차이는 있지만 자동 적용을 허용해도 되는가?
4. 아니라면 읽을 수는 있으나 사용자가 거의 확실히 수정하거나 weight/outline 보정이 필요한가?

행동 기준은 다음과 같다.

- `preferred`: font family를 다시 고르지 않고 그대로 출고할 수 있는 최상위 **최소 동률 집합**. 보통 1개, 실제 동급이면 2개다. 3개 이상이면 정말 구분 불가능한지 다시 pairwise 비교한다.
- `acceptable`: preferred보다는 약하지만 사용자가 즉시 수정하지 않아도 될 후보. 자동 적용 가능한 positive다.
- `marginal`: 읽히고 역할이 완전히 틀리지는 않지만 실제 사용자는 바꾸고 싶거나 별도 treatment 보정이 필요하다.
- `unacceptable`: 역할·골격·시대감·에너지가 충돌해 자동 적용하면 안 된다.
- `unrenderable`: 기술적으로 비교 불가. 취향이 나쁜 후보가 아니다.
- `not_reviewed`: 카드에 없거나 기술적 장애로 직접 보지 못한 경우에만 사용한다.

`preferred`와 `acceptable`이 모두 비어 있을 때만 `none_acceptable=true`다. marginal을 억지 승격하지 않는다.

### 4.1 15개를 빠짐없이 비교하는 방법

1. unrenderable을 먼저 분리한다.
2. 나머지를 원본의 serif/sans/필기성, 무게, 폭, 곡선/각, 에너지와 비교해 viable/non-viable로 나눈다.
3. viable 후보 각각을 현재 1위와 pairwise 비교한다.
4. 승자를 다시 모든 viable 후보와 비교해 preferred 최소 집합을 확정한다.
5. preferred에 지지만 실제 자동 적용을 허용할 후보만 acceptable로 둔다.
6. 남은 후보를 marginal과 unacceptable로 나눈 뒤 15개 합집합과 중복 0을 확인한다.

후보에 표시된 표준 한글 probe의 글자 모양이 일본어 원문과 우연히 비슷한지는 보지 않는다. family의 반복 가능한 골격과 역할 적합도를 본다.

## 5. 작품 일관성은 reference 증거로만 결정한다

v2 calibration 카드는 작품명·장르·font 이름을 숨긴 채 같은 작품의 익명 reference를 함께 보여야 한다.

- 일반 대사 reference 3개 이상: 가능한 경우 현재 화 2개와 다른 화 1개.
- narration/thought reference: 같은 역할의 반복 증거가 실제로 있을 때만 추가.
- 같은 SFX/aside 시각 클러스터 reference: 반복 검출 근거가 있을 때만 추가.
- reference 자체가 crop 불량이면 사용하지 않고 manifest에 제외 사유를 남긴다.

정책은 다음처럼 고른다.

- 평범한 dialogue가 reference body와 같은 목소리면 `inherit_work_anchor`.
- narration/thought는 반복되는 별도 anchor가 확인될 때만 그 anchor를 상속한다.
- aside, 필기, 강조, SFX는 원문에서 의도적 대비가 보일 때 `intentional_override`.
- reference가 없거나 서로 충돌하면 `undetermined` + `insufficient_evidence`다.
- 장르나 작품 제목으로 anchor를 추측하지 않는다. 장르는 font ID 정답이 아니며 카드 첫 판정에 노출하지 않는다.

## 6. confidence 기준

- `0.95`: crop·문맥·역할·preferred 경계가 모두 명확하고 같은 판단을 다시 낼 수 있음.
- `0.85`: 작은 미감 차이는 있으나 역할과 자동 허용 경계가 안정적임.
- `0.70`: 두 역할 또는 preferred/acceptable 경계가 실제로 경합함.
- `0.50` 이하: crop·문맥·렌더 또는 catalog가 판정을 막음.

role confidence와 review confidence 중 하나라도 `0.75` 미만이면 `low_confidence`를 붙인다. 어려운 sample이라고 자동으로 confidence를 낮추지 않고, 무엇이 판정을 막는지 flag와 함께 기록한다.

## 7. v2 보정 실험과 동결 조건

v2 규약을 전수 검수에 쓰기 전에 frozen test 작품을 제외한 development 작품에서 pilot과 겹치지 않는 새 sample을 고른다. 현재 calibration inventory에서 이 조건을 만족하는 18개 작품은 작품당 최대 16개를 선택할 수 있으며, 표본이 16개보다 적은 두 작품은 11개와 15개를 전부 써서 총 282개를 만든다. 모든 항목을 두 명이 독립 검수한다. pilot에 이미 전 표본이 노출된 소규모 development 작품 1개는 독립 합의 측정에서 제외하고, 규약 동결 뒤 전수 검수에는 다시 포함한다.

- 작품별 ordinary dialogue 4개 이상.
- dialogue/emphasis/shout, thought/narration, aside/whisper 경계 표본.
- SFX 5종과 handwritten/outline/inverse/color/orientation 위험군.
- v1에서 preferred 집합 크기와 tier 경계가 크게 흔들린 시각 cohort.
- 두 검토자는 서로의 답, 모델 제안, font 이름, 장르, 작품명을 보지 않는다.
- adjudication 결과를 독립 합의 지표로 재사용하지 않는다.

다음 조건을 모두 만족한 규약·카드 renderer·schema hash를 동결한다.

- 상위 배치 채널 macro-F1 `>= 0.92`.
- 최종 역할 macro-F1 `>= 0.85`.
- tier pairwise agreement `>= 0.80`.
- acceptable-set Jaccard `>= 0.70`.
- none-acceptable agreement `>= 0.95`.
- 직접 관찰 가능한 style field의 한 눈금 이내 agreement `>= 0.80`.
- 미검수·손상 렌더·identity leak·QA overlay 학습 유입 각각 0.

하나라도 실패하면 28,115건 전수 라벨링과 모델 학습을 시작하지 않는다. 실패 항목의 경계 예시만 보강해 새 development 표본으로 다시 측정하고, frozen test는 모델·제품 최종 평가 전까지 열지 않는다.

## 8. 완료 전 점검

- 모든 카드와 후보 15개를 original 해상도로 직접 열었는가?
- 역할을 배치 채널과 세부 기능의 두 단계로 골랐는가?
- style과 treatment, role을 섞지 않았는가?
- preferred가 실제 최소 동률 집합인가?
- marginal을 none 회피용 acceptable로 올리지 않았는가?
- 작품 일관성에 익명 reference 증거가 있는가?
- mixed hierarchy, 잘린 글자, 실제 방향 불일치를 숨기지 않았는가?
- 작품명·장르·모델 제안에 먼저 끌리지 않았는가?
- review 카드와 bbox overlay가 학습 view에 들어가지 않았는가?
