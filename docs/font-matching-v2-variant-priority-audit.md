# Font Matching V2 변칙 폰트 우선 감사

## 결론

현재 자산은 변칙 폰트를 우선하는 최종형의 좋은 출발점이지만, 그대로 학습·배포하면 사용자가 원하는 동작을 보장하지 못한다.

핵심 원인은 네 가지다.

1. 데이터에는 `work_id`, `chapter_id`, `page_id`가 실제로 들어 있지만 trainer와 evaluator가 `chapter_id`와 `page_id`를 학습 예제/평가 단위에서 버린다.
2. 일반 본문 일관성은 현재 **작품 전체 hard anchor**로 구현되어 있다. 화 단위 soft prior가 아니며, 원문 서체가 실제로 바뀐 본문도 사전에 저장된 override가 없으면 anchor를 벗어나지 못한다.
3. 현재 runtime은 학습된 visual ranker를 아직 사용하지 않는다. `resolveAutomaticFontDecisionV2()`가 정적 의미 규칙을 만들고 `calibratedConfidence: 0`을 넣기 때문에, 프로필이 없는 실제 자동 적용은 confidence gate를 통과할 수 없다.
4. 검수 규약은 변칙군 100% 독립 이중검수를 요구하지만 실제 새 7종 queue의 mandatory secondary 계약은 `none`, SFX, aside, manual recrop만 포함한다. `emphasis`, `shout`, `handwritten`, `irregular`가 빠져 있다.

따라서 데이터 수를 더 늘리기 전에 아래 순서로 바꿔야 한다.

- 변칙군의 라벨·검수 품질 계약을 먼저 고친다.
- 일반 대사는 화/시각 클러스터 단위로 중복을 줄이되, 일관성 positive pair와 실제 서체 변경 counterexample은 남긴다.
- ranker에는 변칙 가중치와 화 단위 pair loss를 추가한다.
- runtime에서는 작품 anchor를 hard constraint가 아닌 약한 초기 prior로 낮추고, 화 단위 state와 원문 변화 override gate를 둔다.

## 확인된 현재 상태

### 데이터와 split

- `datasets/font-matching-master-v2/manifest.jsonl`
  - 28,096개 real crop
  - 24개 작품, 214개 화
  - train 19,665 / val 4,218 / test 4,213
  - 작품 단위 disjoint split이며 duplicate component도 같은 split에 묶는다.
- `datasets/font-matching-training-export-v2/samples.jsonl`
  - 최종 라벨 1,189개, 24개 작품, 214개 화, 1,077개 페이지
  - train 727 / val 204 / test 258
  - dialogue 427개
  - 변칙 우선 역할(`whisper`, `aside`, `emphasis`, `shout`, SFX 5종, `sign_ui_title`, `other`) 580개
  - 일반 역할(`dialogue`, `narration`, `thought`) 609개
- font-signal audit 뒤 실제 새 7종 검수 가능 표본은 1,151개다.
  - priority 0: 83개
  - priority 1: 397개
  - priority 2: 671개

즉 전체 구성이 일반 대사에만 쏠린 것은 아니다. 다만 dialogue 427개 중 화별 최대치가 26개와 16개인 화가 있고, 중복은 일부 화에 집중되어 있다. 반대로 dialogue의 단순 style signature는 349종이라서 `dialogue`라는 이유만으로 일괄 삭제하면 안 된다.

권장 방식은 **일반 대사 전체 축소가 아니라 같은 화·같은 style cluster 안에서만 cap**하는 것이다.

### 화 단위 평가 가능성

현재 export만으로도 그룹 metric을 만들 최소한의 밀도는 있다.

- 전체 214개 화 중 body sample이 2개 이상인 화: 122개
- body와 변칙 sample이 함께 있는 화: 154개
- body 2개 이상과 변칙 sample이 함께 있는 화: 98개
- val 46개 화 중 body 2개 이상: 22개
- test 34개 화 중 body 2개 이상: 34개
- test 34개 화 중 dialogue 2개 이상: 30개

그러나 `TrainingExample`과 evaluator의 `Target`에 chapter/page가 없어서 현재 코드는 이 정보를 활용하지 못한다.

### 검수 카드

`datasets/font-matching-catalog-rescue-cards-primary-v3/manifest.json` 기준:

- 카드 1,151개 모두 `qa_overlay: true`, `training_asset: false`다.
- 원본 전체 페이지, cyan bbox, local context, raw/context/glyph가 들어간다.
- 따라서 cyan/red bbox가 있는 review card는 학습 이미지로 사용하면 안 되며 현재 계약도 그렇게 막고 있다.
- 카드에 같은 작품 reference를 넣는 기능은 있지만 이번 v3 manifest의 `work_reference_count`는 0이다.
- render bank에는 10개 probe가 있지만 카드에는 고정된 세 개만 나온다.
  - `dialogue-body`
  - `narration`
  - `sfx-impact`

이 구성은 일반 본문 비교에는 쓸 만하지만, `aside-whisper`, `emphasis-shout`, `sfx-motion`, `sfx-ambient`, `sfx-emotion`, `sfx-comic-reaction` 후보가 이미 render bank에 있는데도 실제 변칙 검수 카드에서는 보이지 않는다는 문제가 있다.

### 라벨 agreement

fresh calibration v1은 40개를 두 명이 독립 검수했고 comparable 38개에서 모두 실패했다.

- role macro-F1: 0.6081 / 요구 0.85
- tier pairwise agreement: 0.5414 / 요구 0.80
- acceptable-set Jaccard: 0.3136 / 요구 0.70
- 38개 중 37개가 adjudication 대상

이 상태에서 production 1,151개를 진행하면 표본 수는 늘어도 label noise가 핵심 변칙군을 압도한다. fresh rubric calibration을 통과하기 전 production 진입을 막는 현재 fail-closed 방향은 맞다.

## 현재 구현과 요구의 차이

### 1. 일반 대사 일관성의 범위가 너무 강하고 너무 넓다

현재 `scripts/build_font_matching_work_profiles.py`는 모든 final을 `work_id`로만 모은다. `inherit_work_anchor` dialogue가 최소 20개 모이면 작품 전체 `dialogueAnchor`를 만든다. chapter/page binding은 입력으로 받지 않는다.

`src/main/pipeline/fontMatchingDecisionV2Profile.ts`는 body anchor가 있으면 다음처럼 동작한다.

- anchor allowlist 밖 후보를 `outside_anchor_set`으로 거부한다.
- render 가능하면 primary anchor를 local score보다 먼저 선택한다.
- 다른 폰트를 쓰려면 `profile.intentionalOverrides`에 이미 block/cluster override가 있어야 한다.

그런데 실제 builder와 migration은 `intentionalOverrides: []`를 만든다. production 코드에서 원문 시각 변화로 override를 새로 만드는 경로도 없다. 따라서 원문 서체가 실제로 달라져도 role이 그냥 `dialogue`로 남으면 work anchor가 바뀐 서체를 덮을 수 있다.

이는 다음 요구와 정면으로 충돌한다.

- 화 안의 일반 본문은 대체로 일관되어야 한다.
- 하지만 말풍선 안이라도 원문 폰트가 달라지면 한국어 폰트도 달라져야 한다.

### 2. chapter/page는 보존되지만 학습에 쓰이지 않는다

`scripts/export_font_matching_training_examples.py`는 `chapter_id`, `page_id`, `consistency`를 sample에 보존한다. 반면 `scripts/train_font_matching_siglip_baseline.py`의 `TrainingExample`은 아래만 가진다.

- `sample_id`, `work_id`, `split`
- candidate gains/mask/pairs
- role/style/treatment target
- `work_balance_weight`

`chapter_id`, `page_id`, `cohorts`, `consistency.policy`, label confidence는 없다. 따라서 현재 loss는 같은 화의 평범한 대사 두 개가 같은 family를 유지해야 하는지, 특정 block이 의도적 변화인지 알 수 없다.

`scripts/evaluate_font_matching_v2.py`도 load 시 sample에서 consistency reason을 읽지만 `Target`에는 chapter/page를 넣지 않는다. 현재 evaluator는 work/role/cohort macro는 계산하지만 다음 지표는 계산하지 않는다.

- 화별 본문 불필요 전환 수
- 화별 anchor coherence
- 의도적 local override 재현율
- 반복 accent cluster 일치율

### 3. 변칙군 priority가 sampling까지만 있고 loss에는 없다

`scripts/build_font_matching_catalog_rescue_inputs.py`는 다음을 priority 1로 올린다.

- SFX
- aside / emphasis / shout
- handwritten >= 0.5
- irregularity >= 0.5
- manual recrop

queue 순서는 사용자 요구와 잘 맞는다. 그러나 trainer는 `work_balance_weight`만 사용한다. role/variant/quality 가중치가 없어서 batch와 total validation loss가 sample 수가 많은 일반 역할에 다시 끌려간다.

현재 best checkpoint도 전체 val multitask loss 최솟값으로 고른다. 변칙군 성능이 좋아지고 ordinary가 조금 흔들리는 모델보다, ordinary 평균이 좋아진 모델이 선택될 수 있다.

### 4. 변칙군 이중검수 계약이 규약과 다르다

`docs/font-matching-v2-review-rubric.md` 6.1은 기존 none, SFX, aside, emphasis, shout, handwritten/irregular, manual recrop을 100% secondary review하라고 적는다.

하지만 `scripts/build_font_matching_catalog_rescue_inputs.py::_secondary_sample_ids()`의 실제 mandatory 조건은 아래뿐이다.

- prior none
- SFX
- `MANDATORY_SECONDARY_ROLES = {aside_balloon_edge}`
- manual recrop

따라서 emphasis, shout, handwritten, irregular은 ordinary와 같은 20% sampling으로 떨어질 수 있다. 이 계약부터 고치지 않으면 “변칙군 품질 우선”이 artifact에 반영되지 않는다.

### 5. 새 7종 delta schema는 중요한 기존 의미 라벨을 고칠 수 없다

`datasets/font-matching-catalog-delta-ledger-production-v1/blind-decision.schema.json`은 다음만 받는다.

- eligibility
- 새 7종 font tier
- role / role confidence
- rationale / 전체 confidence

기존 `source_style`, `treatment`, `consistency`는 수정할 수 없다. 즉 새 7종을 꼼꼼히 봐도 기존 15종 review에서 생긴 잘못된 `inherit_work_anchor`/`intentional_override` 또는 handwritten/irregular 점수는 그대로 학습에 들어간다.

변칙군 P0/P1에는 별도 semantic correction pass가 필요하다. P2 ordinary의 고확신 기존 라벨까지 전부 다시 할 필요는 없다.

### 6. runtime은 page-local이고 실제 visual ranker가 없다

`src/main/pipeline/translatedPageResult.ts`는 페이지를 만들 때마다 `createAutomaticFontPageCoordinatorV2()`를 새로 만든다. 따라서 palette 사용량과 visual cluster font는 페이지를 넘지 못한다.

`src/main/pipeline/automaticFontMatchingV2.ts`는 현재:

- LLM이 준 `fontRole`과 confidence를 사용하고,
- metadata/static Korean role prior로 후보를 정렬하고,
- `localEvidence.calibratedConfidence = 0`을 전달한다.

학습한 SigLIP ranker의 crop embedding, candidate logits, none probability, source style/treatment prediction은 여기로 들어오지 않는다. 현재 모델 artifact는 offline provisional baseline일 뿐 product hot path와 연결되지 않았다.

## 권장 데이터·라벨 패치

### A. local font fit과 consistency action을 분리한다

현재 `font_judgment`는 “이 block 자체에 visually 맞는가”와 “작품 anchor와 어울리는가”를 한 tier에 섞는다. soft prior와 실제 변화 override를 동시에 구현하려면 두 라벨을 분리해야 한다.

새 schema 예시는 다음과 같다.

```json
{
  "chapter_id": "...",
  "page_id": "...",
  "page_index": 12,
  "variant": {
    "class": "handwritten_aside",
    "priority": 1,
    "confidence": 0.96
  },
  "local_font_judgment": {
    "preferred": [],
    "acceptable": [],
    "marginal": [],
    "unacceptable": [],
    "unrenderable": [],
    "none_acceptable": false
  },
  "consistency": {
    "scope": "chapter",
    "action": "inherit_anchor",
    "source_style_relation": "same",
    "reference_sample_ids": ["..."],
    "confidence": 0.94
  },
  "label_quality": {
    "font_signal": "present",
    "resolution": "blind_agreement",
    "confidence": 0.92
  }
}
```

`consistency.action`은 최소 다음 네 값으로 제한한다.

- `inherit_anchor`: 같은 화의 같은 body role과 같은 source style
- `local_override`: 말풍선 안/밖과 무관하게 실제 source family/style 변화가 확인됨
- `palette_member`: aside, emphasis, shout, SFX 같은 accent 역할
- `undetermined`: reference 부족 또는 관계 판정 불가

후보 tier는 local visual fit만 반영한다. chapter anchor와 다르다는 이유로 locally 좋은 후보를 `marginal`로 내리지 않는다. anchor 결합은 별도 consistency policy가 담당한다.

### B. ordinary 중복은 chapter/style cluster 안에서만 줄인다

frozen val/test는 현재 비교 가능성을 위해 그대로 둔다. train selection만 다음 규칙으로 새 export를 만든다.

group key:

```text
(work_id, chapter_id, role, orientation, source_style_cluster_id)
```

각 ordinary group에서 기본 최대 3개를 남긴다.

1. 가장 품질이 높은 canonical sample 1개
2. 다른 페이지에서 같은 style을 보여 주는 consistency positive 1개
3. geometry/treatment가 다른 hard control 1개

다음은 cap에서 제외하고 전부 남긴다.

- human-confirmed `local_override`
- emphasis/shout/whisper/aside/SFX/sign/title
- manual recrop successor
- prior `none_acceptable`이지만 font signal이 확인된 catalog-gap sample
- rare treatment/orientation/style cluster

이렇게 하면 평범한 말풍선 수는 줄지만, “같아야 하는 pair”와 “달라져야 하는 pair”를 모두 보존한다.

### C. batch는 변칙군을 의도적으로 우선한다

초기 sampler 목표 비율은 다음으로 두고 val에서만 조정한다.

- 60%: priority 1 변칙군
- 15%: priority 0 catalog-gap/none 군
- 25%: ordinary anchor/control

priority 1 안에서는 role effective-number weighting을 써서 `sfx_emotion`처럼 많은 하위군이 `sfx_impact`/`sfx_ambient` 같은 희소 하위군을 덮지 않게 한다. 한 sample의 최종 배율은 3배를 넘지 않게 cap한다.

`example_weight`는 다음 요소를 곱하되 평균 1로 다시 정규화한다.

```text
work_balance × variant_priority × role_balance × label_quality
```

낮은 confidence를 작은 weight로 억지 활용하기보다 아래처럼 fail closed한다.

- `font_signal_absent`: font ranking loss 0
- unresolved disagreement / confidence < 0.80: ranking 학습 제외, adjudication queue
- recrop pending: 전체 학습 제외
- high-confidence primary 또는 blind agreement/adjudication만 ranking truth로 사용

### D. 변칙군은 전부 독립 secondary로 올린다

`scripts/build_font_matching_catalog_rescue_inputs.py`의 mandatory 조건은 개별 role 나열이 아니라 `priority_rank <= 1`로 단순화한다.

즉 P0/P1 전부 independent secondary, P2만 결정론적 소수 secondary가 된다. 현재 20% ordinary secondary를 줄이고 그 review 시간을 P1에 재배치한다. report에는 다음 hard invariant를 추가한다.

```text
priority_0_missing_secondary = 0
priority_1_missing_secondary = 0
```

fresh calibration도 P1을 충분히 포함하고, 전체 gate 외에 P1-only role/tier/Jaccard를 별도로 통과해야 한다.

### E. 검수는 두 단계로 나눈다

기존 role을 이용해 probe를 고르면 독립 role review에 prior label이 새어 들어간다. 따라서 한 카드에서 억지로 해결하지 말고 두 단계로 분리한다.

1. **semantic pass**
   - full page/local/raw/context/glyph로 eligibility, role, style, treatment를 판정
   - 기존 role/모델 제안/폰트명은 숨김
2. **font-fit + consistency pass**
   - semantic role이 blind agreement/adjudication으로 봉인된 뒤 시작
   - 해당 role용 probe 3개를 표시
   - 같은 화의 익명 ordinary anchor reference를 2–3개 표시
   - local font tier와 consistency action을 별도로 판정

role별 probe 예시:

- dialogue/narration/thought: 대응 body probe 중심
- whisper/aside: `aside-whisper`, `thought-monologue`, `dialogue-body`
- emphasis/shout: `emphasis-shout`, `dialogue-body`, `sfx-impact`
- SFX: 정확한 SFX 하위 probe + 인접 에너지 probe 2개
- sign/title: 별도 `sign-title` probe를 render bank에 추가

`scripts/build_font_matching_work_references.py`는 same-work가 아니라 same-chapter를 1순위로 뽑도록 바꾼다. 같은 화에서 reference가 부족할 때만 다른 화의 work prior를 fallback으로 넣고, 카드에 scope를 익명 상태로 명시한다.

## 권장 trainer 패치

### 파일/스키마

`scripts/export_font_matching_training_examples.py`

- 새 `font-matching-training-sample-v2`를 별도 output에 생성한다.
- `page_index`, `variant`, `label_quality`, 새 consistency 구조를 봉인한다.
- `chapter-pairs.jsonl`을 추가한다.
  - positive: 같은 chapter/role/style cluster의 `inherit_anchor`
  - override: 같은 chapter/body role이지만 `local_override`
  - 모든 pair는 같은 split 안에서만 생성
  - pair 양끝 sample SHA와 label SHA를 함께 봉인
- 기존 v1 export를 덮어쓰지 않는다.

`scripts/train_font_matching_siglip_baseline.py`

- `TrainingExample`에 `chapter_id`, `page_id`, `variant_class`, `priority`, `consistency_action`, `label_quality_weight`를 보존한다.
- work ID나 chapter ID는 model feature로 넣지 않는다. 오직 grouping/weight/loss 구성에만 쓴다.
- batch sampler를 priority/role aware로 바꾼다.
- early stopping을 전체 val loss 하나가 아니라 변칙 metric 우선 constrained selection으로 바꾼다.

### loss

기존 listwise/pairwise/none/role/style/treatment loss는 유지하되 sample별 위 weight를 적용한다. 여기에 두 loss를 추가한다.

1. `chapter_anchor_consistency_loss`
   - human-confirmed positive pair에만 적용
   - 두 candidate distribution의 Jensen-Shannon divergence 또는 acceptable-set mass 차이를 줄임
   - exact font one-hot을 강요하지 않음
2. `local_override_margin_loss`
   - human-confirmed override pair에만 적용
   - local block의 preferred/acceptable mass가 chapter anchor 선택보다 지정 margin 이상 높도록 hinge loss
   - 두 block의 acceptable set이 실질적으로 같으면 억지로 다른 font를 강요하지 않음

none loss는 현재 provisional 결과에서 threshold가 0.05까지 내려가고 abstain F1이 낮았으므로 class-balanced BCE/focal 후보를 val grid로 비교한다. P0의 font-signal과 catalog-gap 구분을 먼저 정확히 한 뒤에만 적용한다.

### checkpoint 선택

다음 순서의 constrained selection을 권장한다.

1. P1 variant macro `Acceptable@1` 최대
2. P1 `Preferred@1`, tier NDCG, none F1 순
3. ordinary `Acceptable@1`이 기준 모델보다 3%p 넘게 하락한 checkpoint는 제외
4. chapter false-switch와 override recall gate를 통과하지 못하면 제외

전체 sample 평균 loss는 tie-breaker로만 쓴다.

## 권장 evaluator 패치

`scripts/evaluate_font_matching_v2.py`의 `Target`, `Prediction`, `SampleScore`에 chapter/page/action을 보존한다. 평가를 두 층으로 나눈다.

### local ranker 지표

- P1 전체 macro 및 하위 role별 Preferred@1 / Acceptable@1 / NDCG
- aside, handwriting, emphasis, shout, SFX 5종을 각각 보고
- none precision/recall/F1을 P0와 P1에서 분리
- confidence ECE와 selective accuracy를 ordinary/variant별 분리
- 작품 macro뿐 아니라 variant role macro와 하위 10% 작품 성능

### chapter policy 지표

- `unnecessary_body_switches_per_100`
  - `inherit_anchor` body에서 불필요하게 family가 바뀐 횟수
- `local_override_recall`
  - confirmed override에서 anchor를 풀고 locally acceptable font를 선택한 비율
- `false_override_rate`
  - confirmed inherit에서 anchor를 불필요하게 푼 비율
- `chapter_anchor_coherence`
  - 같은 chapter/body cluster가 같은 선택 또는 동급 acceptable family를 유지한 비율
- `accent_cluster_consistency`
  - 같은 visual style cluster가 같은 font를 재사용한 비율

metric bootstrap은 chapter를 독립 표본처럼 부풀리지 말고 최상위 work 단위로 resample한다.

현재 sample에는 안정적인 `page_index`가 없으므로 순차 switch metric을 위해 `scripts/build_font_matching_master.py`에서 chapter의 canonical page order를 구조화된 필드로 보존해야 한다. 파일명 문자열을 evaluator에서 임의 parsing하지 않는다.

## 권장 runtime 정책

### 1. work hard anchor를 chapter soft anchor로 바꾼다

`WorkTypographyProfileV2`의 work anchor는 새 작품/새 화의 초기 prior로만 쓴다. 실제 선택은 `FontMatchingChapterState`가 담당한다.

```text
work prior -> chapter body consensus -> block-local visual evidence
```

chapter state는 body role별로 다음을 가진다.

- current anchor font / acceptable set
- confidence와 evidence count
- source-style centroid 또는 최근 고확신 body embedding
- 최근 선택과 audit reason

첫 block 하나로 anchor를 확정하지 않는다. 고확신 block 두 개가 합의하거나, 매우 높은 confidence + work prior가 합의할 때만 강한 chapter anchor로 승격한다.

### 2. anchor는 penalty이지 allowlist가 아니다

현재 `rejectEligibleOutsideSet(..., "outside_anchor_set")` hard reject를 body에 쓰지 않는다. glyph/orientation/layout만 hard gate로 남긴다.

body candidate score는 예를 들어 다음처럼 결합한다.

```text
local_visual_score - chapter_switch_penalty
```

switch penalty는 아래에서만 커진다.

- role이 ordinary body
- source style이 chapter anchor와 가깝다
- chapter anchor evidence/confidence가 충분하다

다음 경우에는 penalty를 약화하거나 0으로 만든다.

- role이 emphasis/shout/whisper/aside/SFX
- source style distance가 threshold를 넘는다
- local candidate가 anchor보다 calibrated margin 이상 좋다
- human/user block lock이 있다

override는 미리 profile에 저장되어 있어야만 하는 값이 아니라, 현재 block visual evidence로 먼저 결정할 수 있어야 한다. 결정 후 block audit에 `local_override` 근거를 남기고, 반복 관찰 또는 사용자 수락이 있을 때만 persistent profile로 승격한다.

### 3. coordinator를 chapter run scope로 올린다

`createAutomaticFontPageCoordinatorV2()`를 `buildTranslatedPageResult()` 안에서 매번 만들지 않는다. chapter translation run state에 `AutomaticFontChapterCoordinator`를 두고 page success 때만 transactional commit한다.

- retry 중간 결과는 chapter state에 반영하지 않음
- canonical page order로 commit
- chapter가 바뀌면 body/palette state reset
- work prior와 user locks만 다음 chapter로 전달

accent palette도 chapter 전체 hard cap이 아니라 role/visual-cluster별 soft reuse로 둔다. 서로 다른 SFX style cluster는 같은 role이어도 다른 font를 허용한다.

### 4. 실제 model evidence를 page batch로 연결한다

`resolveAutomaticFontDecisionV2()` 안에서 동기적으로 ONNX를 돌리기보다 page build 전에 모든 crop을 batch inference한다.

권장 경로:

1. page crop/three-view 준비
2. visual ranker batch inference
3. candidate logits, calibrated confidence, none probability, role/style/treatment, embedding을 block ID에 binding
4. chapter coordinator가 local evidence와 soft prior를 결합
5. glyph/layout hard gate 뒤 적용/제안/abstain

LLM/Gemma는 페이지 문맥 역할과 container 관계를 보조할 수 있지만 font ID truth를 직접 고르지 않는다. visual ranker가 family fit을 담당하고, LLM role confidence가 낮으면 visual role head와 함께 abstain/adjudication 방향으로 간다.

## split/leakage 판정

현재 좋은 계약은 유지한다.

- work-disjoint split 유지
- normalized glyph/root/variant component cross-split 0 유지
- test pixels는 optimizer/calibration에서 열지 않음
- QA overlay와 synthetic/generated는 core val/test에서 0
- 작품명/장르/ID를 model feature로 넣지 않음

chapter consistency를 추가해도 누출은 생기지 않는다. 한 작품의 모든 화가 이미 한 split에 있기 때문이다. 다만 다음 hard check를 추가해야 한다.

- chapter pair 양끝 split 동일
- source page/crop SHA cross-split 0을 trainer에서도 재검증
- frozen val/test sample inventory 변경 금지
- sampler/weight tuning은 val까지만 사용
- test chapter metric은 최종 한 번만 개봉
- `work_id`, `chapter_id`, `page_id`는 grouping key일 뿐 encoder 입력이 아님

장르 일반화는 현재 provisional model처럼 genre feature를 넣지 않는 방향이 맞다. genre는 최종 runtime에서 최대 0.1 이하의 약한 prior로만 쓰고, local visual evidence나 chapter-confirmed override를 뒤집지 못하게 한다.

## 파일별 최소 변경 목록

| 파일                                                                       | 필수 변경                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `docs/font-matching-v2-review-rubric.md`                                   | local fit과 chapter consistency 분리, P0/P1 전수 secondary 명시, work hard anchor 문구 제거               |
| `scripts/build_font_matching_catalog_rescue_inputs.py`                     | `priority_rank <= 1` mandatory secondary, 누락 hard invariant                                             |
| `scripts/font_matching_catalog_delta_ledger.py`                            | P0/P1 semantic correction 및 consistency action schema/gate 추가                                          |
| `scripts/build_font_matching_review_cards.py`                              | semantic/font-fit 2단계 카드, sealed role별 probe 사용                                                    |
| `scripts/build_font_matching_work_references.py`                           | same-chapter 우선 reference, fallback scope 기록                                                          |
| `scripts/build_font_matching_master.py`                                    | canonical `page_index` 보존                                                                               |
| `scripts/export_font_matching_training_examples.py`                        | sample v2 + quality/variant/consistency + sealed chapter pair artifact                                    |
| `scripts/train_font_matching_siglip_baseline.py`                           | chapter fields 보존, priority sampler/weight, consistency/override loss, variant-first checkpoint         |
| `scripts/evaluate_font_matching_v2.py`                                     | chapter/page 보존, variant macro와 chapter policy metric/gate                                             |
| `scripts/build_font_matching_work_profiles.py`                             | training sample binding을 받아 chapter evidence를 구분하고 work anchor는 초기 prior로만 생성              |
| `src/shared/fontMatchingProfileTypes.ts` / `fontMatchingProfileSchemas.ts` | work prior와 ephemeral/persisted chapter state를 분리한 V3 contract                                       |
| `src/main/pipeline/automaticFontMatchingV2.ts`                             | 실제 model evidence adapter 사용, `calibratedConfidence: 0` bootstrap 제거                                |
| `src/main/pipeline/fontMatchingDecisionV2Profile.ts`                       | body hard allowlist 제거, soft switch penalty와 local override gate                                       |
| `src/main/pipeline/automaticFontMatchingV2PageCoordinator.ts`              | chapter-scope transactional coordinator로 승격                                                            |
| 관련 Python/TS tests                                                       | priority coverage, pair leakage, chapter reset/commit, real override, false switch, frozen test 보호 회귀 |

## 실행 순서와 go/no-go

1. 현재 failed calibration의 disagreement 원인을 rubric에 반영한다.
2. 새 표본 fresh calibration에서 전체 gate와 P1-only gate를 모두 통과한다.
3. production queue를 다시 생성해 P0/P1 secondary 누락 0을 검증한다.
4. P0/P1 semantic correction + 새 7종 font-fit review를 먼저 완료한다.
5. P2 ordinary는 same chapter/style dedup 후 필요한 anchor/control만 유지한다.
6. 22종 training export v2와 chapter pair artifact를 봉인한다.
7. variant-priority trainer를 val에서 선택하고 frozen test를 한 번 평가한다.
8. chapter soft-prior runtime을 연결한 뒤 unseen work/chapter blind QA를 한다.

최종 release는 적어도 다음을 동시에 만족해야 한다.

- label calibration: role F1 >= 0.85, tier pairwise >= 0.80, acceptable Jaccard >= 0.70
- P1 variant macro Acceptable@1이 기존보다 유의하게 개선
- ordinary Acceptable@1 퇴행 <= 3%p
- 불필요 body 전환이 block-local ranker보다 50% 이상 감소
- confirmed local override recall >= 90%
- P0/P1 secondary 누락 0, unresolved disagreement 0
- glyph/layout hard failure 0
- QA overlay/synthetic/generated test 유입 0

이 설계의 핵심은 “일반 말풍선을 무조건 같은 폰트로 만든다”가 아니다. **같은 화에서 실제로 같은 원문 목소리는 안정적으로 유지하고, 원문이 의도적으로 달라진 순간에는 그 일관성 prior를 확실히 풀어 주는 것**이다. 변칙군의 local fit을 1차 목표로 두고 ordinary는 품질 높은 anchor/control만 남기는 것이 사용자의 최신 우선순위와 가장 잘 맞는다.
