# MangaFont 빠른 실명 폰트 검수 배치 v1

이 단계는 28,096개 크롭에 이미 생성된 두 번의 모델 예측을 사람이 빠르게
고르고, 이후 두 번 더 재검토하기 위한 작업 묶음이다. 블라인드 실험이 아니다.
원본 `raw/context/glyph` 세 화면, 실제 폰트 이름과 역할별 한글 렌더, pass 1과
student pass 2의 순위·확률을 한 화면에 같이 보여준다.

## 기본 우선순위와 배치

- 첫 배치: 가능한 경우 변칙 역할/카테고리 5,000건
- 이후: 기존 큐 순서대로 모델 간 불일치, 낮은 마진, 화내 일반 폰트 이탈,
  일반 합의 순서
- 기본 배치 크기: 5,000건
- 배치별 작품 상한: 800건
- 배치별 화 상한: 160건
- 기본 후보: 상위 5개 실명 폰트
- 기본 렌더링: 첫 배치만 접촉 시트로 생성한다. 나머지 배치도 JSON 검수
  항목과 3회 템플릿은 즉시 생성된다.

작품/화 상한은 특정 작품의 많은 컷이 첫 배치를 독점하지 못하게 한다. 실제
전체 큐의 가장 큰 작품은 4,815건, 가장 큰 화는 1,063건이므로 기본 상한은
여러 배치에 고르게 분산하면서도 5,000건 첫 배치를 채울 수 있게 잡았다.

## 생성 명령

```powershell
python scripts\build_manga_font_fast_review_batches.py build `
  --master-manifest datasets\font-matching-master-v2\manifest.jsonl `
  --pass1 artifacts\font-matching-fast-label-full28k-v1\pseudo-labels-pass1.jsonl `
  --pass2 artifacts\font-matching-student-pass2-full28k-v1\pseudo-labels-pass2.jsonl `
  --queue artifacts\font-matching-multistage-review-queue-v1.jsonl `
  --catalog-registry datasets\font-matching-catalog-registry-v2.json `
  --render-bank-manifest datasets\fontclip-font-render-bank-v2\manifest.json `
  --output-dir artifacts\manga-font-fast-named-review-full28k-v1
```

다음 배치까지 이미지를 만들 때는 같은 명령에
`--render-batch-count 2 --replace-owned-output`을 붙인다. 이 값은 처음부터 몇
번째 배치까지 접촉 시트를 물질화할지 뜻한다. JSON 계획은 항상 전수 생성된다.

전체 검증:

```powershell
python scripts\build_manga_font_fast_review_batches.py validate `
  --output-dir artifacts\manga-font-fast-named-review-full28k-v1
```

## v7 active21 전량 재라벨 연결

v7 `review-predictions.jsonl`은 별도 큐 변환 파일 없이 같은 도구의
`build-v7` 명령으로 후보 5개 비교 시트를 다시 만들 수 있다.

```powershell
python scripts\build_manga_font_fast_review_batches.py build-v7 `
  --v7-review artifacts\manga-font-student-v7-mass21-pass-v1\review-predictions.jsonl `
  --output-dir artifacts\manga-font-v7-active21-fast-review-v1
```

이 경로의 후보 어휘는 Gugi가 빠진 active21로 고정된다. 기본 한 시트는 36행이며,
재검토 순서는 세 시점 top1 불일치, 높은 엔트로피, 작은 top1 마진, 같은 화의
다수 폰트에서 벗어난 행을 함께 점수화해 정한다. 작품/화 상한은 기존 방식과
같이 적용한다.

기존 감독 자료에서 active21 유효 골드 675개 ID를 다시 검증해
`human-gold-separated.jsonl`로 분리하며, 이 ID들은 재검토 배치에 들어가지
않는다. Gemma, 역할, 장르, 화, 폰트 계열 prior는 후보 logit에 모두 0으로
고정된다. 카테고리는 효과음/강조/대사에 맞는 한글 비교 문구를 고르는 데만
쓰며 후보 순위는 바꾸지 않는다.

## 세 번의 빠른 검토

각 `batches/batch-NNN` 폴더에는 다음 템플릿이 있다.

1. `review-pass-1-fast_pick.template.jsonl`: 화면을 보고 가장 어울리는 폰트를
   빠르게 고른다.
2. `review-pass-2-prediction_disagreement_recheck.template.jsonl`: 두 모델이
   갈린 행과 낮은 마진을 우선 재확인한다.
3. `review-pass-3-chapter_and_variant_consistency_recheck.template.jsonl`: 같은
   화의 일반 말풍선 일관성과, 실제로 달라야 하는 강조/효과/손글씨 예외를 함께
   확인한다.

원본 템플릿은 무결성 검증 대상이므로 복사본에 답을 기록한다. 세 단계 모두
`pseudo_not_gold`, `training_eligible=false`, `promotion_allowed=false`이다.
특히 test split은 이후에도 훈련 승격이 금지된다. 사람이 세 번 확인한 답도 이
도구만으로는 골드가 되지 않으며 별도 최종화/봉인 단계가 필요하다.

## 속도 중심 사용법

처음부터 후보를 가리거나 22개 전체를 매번 블라인드 비교하지 않는다. 1차에서
상위 5개 중 빠르게 고르고, 맞는 후보가 없으면 `none_acceptable`을 표시한다.
2차와 3차에서 불일치·변칙·화 일관성 신호를 이용해 수정한다. 이렇게 하면 모든
행을 처음부터 엄격한 블라인드 절차로 처리하는 것보다 훨씬 빨리 넓은 라벨을
얻으면서, 어려운 변칙 폰트에는 재검토 시간을 더 쓸 수 있다.
