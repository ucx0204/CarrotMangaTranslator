# 원문 시각 크기 기반 폰트 자동 맞춤 연구

## 결론

구현 가능하다. 다만 래스터 만화 이미지에서 원 제작자가 입력한 `24pt`나
`32px` 같은 **명목 font-size**를 정확히 복원하는 문제로 정의하면 답이 없다.
같은 font-size라도 폰트마다 em 박스 안에서 실제 글자 몸통(`字面`, ICF)이 차지하는
비율이 다르기 때문이다.

제품 목표는 다음처럼 정의해야 한다.

1. 원문 일본어의 실제 보이는 글자 몸통 크기 `sourceFacePx`를 페이지 픽셀로 잰다.
2. 폰트 자동 맞춤 v2가 고른 한국어 폰트로 실제 번역문을 렌더링한다.
3. 렌더된 한국어 글자 몸통이 `sourceFacePx`가 되는 `targetFontSizePx`를 역산한다.
4. 번역문이 블록을 넘을 때만 기존 자동 맞춤이 그 값을 상한으로 삼아 축소한다.

즉, **폰트 종류·굵기는 현재 v2**, **시각 크기는 별도 결정론적 보정기**가 맡는
구조가 추천안이다. v2 모델이나 봉인된 학습·평가 데이터는 바꿀 필요가 없다.

## 왜 명목 크기를 그대로 옮기면 안 되는가

- OpenType의 em square는 글자 윤곽 자체가 아니라 크기와 정렬을 위한 가상 박스다.
  글자 윤곽은 em 밖으로도 나갈 수 있다.
- OpenType은 CJK용으로 ideographic character face(ICF, 평균 字面)를 별도로
  정의한다. 같은 em이라도 ICF 비율과 중심은 폰트마다 다를 수 있다.
- CSS Fonts 5도 같은 font-size의 폰트가 서로 다른 크기로 보이는 문제 때문에
  `font-size-adjust: ic-width | ic-height`와 `size-adjust`를 정의한다.
- 따라서 일본어 폰트의 명목 32px를 한국어 폰트 32px로 복사하는 것은 시각 크기
  보존이 아니다.

## 현재 앱과의 관계

- production v2는 폰트 family와 weight를 선택하며 원문 픽셀 크기를 복원하지 않는다.
- v2 입력은 224px letterbox crop이어서 원 페이지의 절대 축척을 잃는다. 현재 모델
  출력에 크기 head를 억지로 붙이면 같은 글자가 페이지 해상도에 따라 달라진다.
- 현재 자동 맞춤은 블록 안에 들어가는 가장 큰 크기를 찾는 box-fit이다. 원문보다
  번역이 짧으면 원문보다 지나치게 커질 수 있다.
- production OCR 단계에는 방향과 원 페이지 좌표의 line polygon이 이미 있다. 크기
  추정은 합쳐진 블록 bbox가 아니라 이 line polygon에서 수행해야 한다.

## 직접 스모크 결과

### 합성 정답 데이터

일본어 4개 폰트, 가로·세로, 20/32/48/72px, 평문·외곽선·JPEG 노이즈·회전·반전
외곽선을 조합했다. 한국어 대상은 우선 대표 4개 폰트, 이어 앱 내장 21개 폰트
전체를 검사했다.

| 방법                                    | 중앙 절대 오차 | P90 절대 오차 |
| --------------------------------------- | -------------: | ------------: |
| 실제 core mask + 대상 렌더러 보정(상한) |          0.00% |         1.00% |
| 방향 보정 core mask + 대상 렌더러 보정  |          2.34% |         6.67% |
| 축 정렬 core mask + 대상 렌더러 보정    |          7.02% |        41.55% |
| 원문 명목 px를 한국어에 그대로 적용     |          8.32% |        25.40% |
| 검출 box 두께를 명목 px로 적용          |         16.67% |        59.44% |
| 검출 box 두께를 대상 렌더러에 맞춤      |         28.54% |        84.41% |

`same nominal px`의 폰트별 중앙 오차는 `start-over` 29.38%,
`kirang-haerang` 27.30%, `nanum-brush-script` 24.65%까지 벌어졌다. 반대로 실제
대상 폰트 렌더링을 보정하면 모든 내장 폰트의 중앙 오차가 약 2.13~2.93%로
수렴했다. 이 결과는 원문 명목 크기가 아니라 **source face → target face**를
맞춰야 한다는 것을 직접 보여 준다.

### 실제 본문 페이지

표지는 제외하고 세로 대사와 나레이션이 있는 본문 3페이지의 ordinary 블록
20개를 사용했다. QA 산출물에는 raw line polygon이 남아 있지 않아 합쳐진 block
crop과 OCR 후보 수를 사용했으므로 production보다 불리한 조건이다.

- 저비용 core 추정: 20개 중 16개 통과, 4개 confidence abstain
- 배경 나뭇결을 글자로 오인한 사례는 component-count gate가 올바르게 포기
- 저비용 추정 자체는 단일 CPU 스레드에서 블록당 중앙 1.118ms, P95 1.824ms
- CTD 마스크는 본문 3페이지에서 페이지당 중앙 0.465초(한 논리 CPU)
- CTD를 최종 글자 몸통으로 직접 쓰면 gated core보다 중앙 11.5% 두껍게 추정
- CTD를 의미론적 gate로만 쓰고 그 안에서 고해상도 core를 다시 재면 20개 중
  기존 실패 2개를 추가 복구했고, 기존 통과 16개를 새로 탈락시키지 않음
- 깨끗한 대사의 gated core/Otsu 비율 중앙값은 1.0으로, 불필요한 크기 변경이 없음

따라서 무거운 text segmentation은 매 블록의 크기값을 직접 내는 모델이 아니라,
값싼 방식이 실패한 페이지에서 배경을 제거하는 **조건부 보조 마스크**로 쓰는 것이
맞다.

### 20작품 A/B/C production-renderer 스모크

표지를 제외하고 번역·인페인트가 완료된 서로 다른 작품의 본문 페이지만 사용했다.
제목 유사도가 높은 같은 시리즈는 한 작품으로 묶었고, 33개 적격 작품에서 개발군
10작품과 완전히 격리한 홀드아웃 10작품을 먼저 봉인했다. 봉인된 cohort manifest의
SHA-256은
`41f7cb1af8901ba73a92288ba8b2d21d2420487ab86283a80fa5b5b0a50ded19`이다.

각 페이지는 같은 production export renderer와 같은 인페인트 이미지를 사용해 다음
세 열로 렌더링했다.

- A: 원본 일본어 페이지
- B: 현재 box-fit 폰트 자동 맞춤
- C: 원문 core 크기로 계산한 상한 안에서만 기존 box-fit을 수행하는 하이브리드

개발군에서만 12개 설정을 비교했다. 5px 양자화는 비슷한 원문 크기 사이에 눈에 띄는
계단을 만들어 폐기했고, `r08-s102-ml35-q1`을 고정한 뒤 홀드아웃에는 계수를 다시
맞추지 않았다. 이 설정은 측정 face에 1.02배를 적용하고 작은 회귀 보정을 35%만 섞으며
최종 상한을 1px 단위로 저장한다.

작은 보정 모델은 일본어 합성 4개 폰트만 학습하고 서로 다른 2개 폰트로 검증했다.
원문 이미지를 직접 외우는 모델이 아니라 core/pitch/line/component 통계 9개를 받는
64-tree, depth-6 회귀기이며 단일 CPU 스레드만 사용한다.

| 합성 평가           | 보정 전 중앙/P90 | 보정 후 중앙/P90 |
| ------------------- | ---------------: | ---------------: |
| 학습 내 교차 검증   |  2.235% / 6.667% |  1.185% / 3.399% |
| 폰트 완전 분리 검증 | 3.571% / 12.500% |  1.544% / 6.418% |

본문 적용률은 개발군 150개 ordinary 후보 중 127개(84.7%), 홀드아웃 123개 중
113개(91.9%)였다. 나머지는 복잡 배경, 회전, 글자 수 부족, pitch 불일치 등의 이유로
상한을 기록하지 않아 현재 B 동작을 그대로 유지했다. 홀드아웃의 보정 face 중앙값은
28.1px, 최종 상한 중앙값은 30px였다.

원본 확대 crop과 B/C production 출력의 블록별 시트를 직접 비맹검으로 확인했다.
페이지 전체 판정은 개발군 10/10과 홀드아웃 8/10에서 C가 원문 글자 몸통 크기에 더
가까웠다. 홀드아웃 나머지 한 페이지는 B/C가 대부분 같았고, 한 페이지는 기존의 긴
번역문 wrapping/변형 문제가 섞여 판단이 혼합됐다. 페이지 전체가 B보다 나빠진 사례는
없었다. 특히 B가 짧은 번역문을 넓은 말풍선 끝까지 키우는 문제가 C에서 일관되게
줄었다.

다만 다음은 별도 guard 또는 후속 레이아웃 개선 대상으로 남는다.

- 일부 잘린 말풍선과 2~3글자 블록은 C가 원문보다 조금 작게 보일 수 있음
- 매우 굵은 원문은 weight 차이가 크기 차이처럼 보일 수 있음
- 번역문이 원문보다 훨씬 길 때 생기는 줄바꿈·잘림은 크기 추정기 문제가 아님
- 현재 연구 fixture와 이번 1차 production 적용은 merged block crop으로 측정함.
  향후 OCR line polygon이 파이프라인 계약에 안정적으로 보존되면 이를 우선 입력으로
  바꾸는 것이 다음 정밀도 개선 지점임

따라서 ordinary 본문용 하이브리드 상한은 제품 실험을 진행할 근거가 충분하지만,
효과음·곡선·원근·회전·수동 크기 블록에는 자동 적용하지 않는 것이 안전하다. 수동
크기는 항상 우선하고, C 상한은 번역이 길 때 더 작게 줄어드는 것은 허용하되 원문보다
크게 확대되는 것만 막아야 한다.

### Koharu Layout 마스크 비교 결과

별도의 새 본문 20페이지에서 Koharu Layout RF-DETR Seg 2XL의 `text`와
`onomatopoeia` 마스크도 같은 production renderer로 비교했다. 이 마스크는 텍스트의
존재 영역을 찾는 데에는 유용하지만 글자 획 자체가 아니라 열 전체나 문장 영역을
채우는 사례가 있었다. 그 결과 여러 열로 된 평범한 세로 대사에서 실제 글자 몸통보다
큰 값을 내어 한국어가 과도하게 커질 수 있었다.

따라서 **원문 글자 크기 측정에는 Koharu 마스크를 사용하지 않는다.** 기존에 앱이
말풍선·레이아웃 분석에 사용하는 Koharu 기능은 그대로 두고, 크기 자동 맞춤은 위의
저비용 core 측정과 confidence abstain만 사용한다. segmentation 실패를 보완하기 위해
무거운 모델을 추가 실행하지 않으며, 확신이 없으면 기존 box-fit으로 돌아간다.

## 추천 순위

### 1위 — OCR line geometry + 글자 core + 실제 한국어 렌더러 보정

가장 먼저 구현할 방식이다.

1. 각 OCR line polygon을 원 방향으로 rectification한다.
2. 흑자/백자 양 극성의 마스크 후보를 만든다.
3. connected component, 방향별 projection, OCR 글자 수와 pitch 일치도를 사용해
   배경·말풍선 선·외곽선을 거른다.
4. 후리가나처럼 작은 군집과 큰 본문 글자 군집을 분리하고, 면적 가중 최빈 구간의
   line cross-thickness를 `sourceFacePx`로 쓴다.
5. v2가 고른 한국어 폰트를 실제 production canvas로 렌더링하면서 보이는 글자
   몸통이 `sourceFacePx`가 되는 font-size를 이분 탐색한다.

장점은 별도 AI 다운로드가 없고, 결정론적이며, 디버깅 가능하고, 현재 OCR 좌표와
렌더러를 그대로 활용한다는 점이다. 합성 스모크도 가장 강했다.

### 2위 — 1위의 저신뢰 사례에만 text segmentation gate

다음 조건 중 하나일 때만 페이지 단위 마스크를 요청한다.

- 배경 component 수가 OCR 글자 수에 비해 과도함
- 흑자/백자 후보가 서로 크게 불일치함
- line box와 core/pitch가 불일치함
- 자유 배치·복잡 배경·반전 글자임

이번 CTD는 약 94.7MB이며 현재 production 소비 코드에 연결된 자산이 아니라 연구용
로컬 모델이다. 그대로 제품에 넣기 전에 기존 검출 런타임 재사용 가능성 또는 더 작은
segmentation 모델을 별도로 비교해야 한다. 어떤 모델을 쓰든 **마스크 자체 두께를
font-size로 사용하지 않고**, 마스크 안에서 고해상도 core를 다시 재야 한다.

### 3위 — 작은 보정 모델

1·2위의 confidence와 잔차만 보정하는 작은 회귀/분류 모델이다. 입력은 line polygon,
core thickness histogram, stroke width, component 분포, 방향, 해상도, OCR 글자 수 등으로
제한한다. 합성 데이터로 충분히 pretrain하고, 실제 본문 pairwise QA만 calibration에
쓴다. 원문 전체 이미지를 VLM에 넣는 것보다 훨씬 작고 예측 근거가 분명하다.

이 단계는 결정론적 방법의 실제 본문 실패율을 측정한 뒤에만 정당화된다.

### 4위 — differentiable de-rendering / inverse rendering

폰트·크기·위치·외곽선·색·배경까지 공동 최적화할 수 있어 연구적으로는 가장
완전하다. 하지만 만화의 세로쓰기, 후리가나, 여러 글자 크기, 말풍선 배경을 포함한
학습 자료와 반복 렌더링이 필요하다. 일반 대사 크기 하나를 맞추기에는 지나치게
무겁다. 효과음 복원 같은 별도 고급 기능에서 재평가할 수 있다.

### 5위 — typography 전용 소형 VLM

일반 VLM의 prompt에 `fontSize`를 요청하는 방식은 추천하지 않는다. 최근 FontBench도
VLM이 글을 읽는 능력과 typography를 보는 능력이 다르며, 해상도 변화에 font-size
인식이 쉽게 붕괴함을 보였다. 합성 typographic supervision으로 개선은 가능하지만,
절대 페이지 좌표를 이미 가진 현재 앱에서는 1위보다 비싸고 불투명하다.

### 6위 — raw bbox/글자 수

BallonsTranslator 계열이 사용하는 line polygon cross-thickness는 좋은 fallback이지만
검출 padding, 외곽선, 후리가나, 복잡 배경을 글자 몸통으로 오인한다. 합성 스모크에서도
P90 오차가 59%를 넘었다. confidence가 없을 때 지금 box-fit보다 더 나쁜 결과를 조용히
만들 수 있으므로 최후 fallback으로만 둔다.

## 권장 production 알고리즘

### 소스 측정

```text
for each OCR line polygon:
  rectify source crop
  build dark/light core candidates
  optionally intersect with semantic text gate
  split line bands and reject ruby-sized cluster
  measure oriented character-face cross thickness
sourceFacePx = robust area-weighted mode/median of accepted main-text lines
confidence = geometry + mask + OCR-pitch agreement
```

외곽선은 `sourceFacePx`에 넣지 않는다. 글자 몸통과 효과 envelope를 분리해야 굵은
흰 테두리가 font-size를 키우지 않는다.

### 대상 폰트 역산

```text
targetFontSizePx = argmin_s |
  renderedFacePx(selectedKoreanFont, translatedGlyphSample, s)
  - sourceFacePx
|
```

production에서는 Pillow가 아니라 현재 Canvas/OffscreenCanvas 렌더러와
`TextMetrics.actualBoundingBox*` 또는 실제 alpha mask를 쓴다. 폰트 ID·굵기·쓰기 방향·
size bucket별 결과를 cache하면 비용은 작다. 내부 정밀도는 0.5~1px로 유지하고 UI에서만
필요하면 정수로 보인다. 5px/10px 단위로 내부 값을 양자화할 이유는 없다.

### 기존 자동 맞춤과 결합

```text
preferred = source-matched targetFontSizePx
fitted = current box-fit maximum
final = min(preferred, fitted)
```

번역문이 길 때는 블록을 넘지 않도록 축소하지만, 번역문이 짧다는 이유로 원문보다 크게
확대하지 않는다. 사용자가 글자 크기를 수동 변경하면 해당 블록의 원문 크기 자동 반영을
끄고, 명시적으로 다시 켰을 때만 재계산한다.

## 저장·UI 제안

새 필드는 모두 선택값으로 둔다.

```ts
sourceFontFacePx?: number;
sourceFontSizeConfidence?: number;
sourceFontSizeMethod?: "raster-core-v1";
```

사용 위치는 기본 서식이 아니라 `번역 실행 > 블록 · 줄 나눔`의
`글자 크기 자동 맞춤`이다. 새 블록을 만들 때만 원문 크기를 측정하며, 이 옵션을 끄면
기본 서식의 수동 글자 크기를 그대로 사용한다. 낮은 confidence에서는 현재 box-fit으로
돌아가 사용자를 놀라게 하지 않는다. 기본 서식의 기존 자동 맞춤 스위치는 제거하되,
명시적인 스타일 프리셋이 저장한 기존 `autoFitText` 값은 호환성을 위해 유지한다.

## 초기 제외 범위

- 한 블록 안의 글자별 서로 다른 원문 크기
- 곡선·원근·심한 왜곡 효과음
- 말풍선 밖 자유 배치 SFX와 장식 문자
- 후리가나 자체를 한국어에 별도 재현
- 원 제작자의 point/DPI 값을 복원한다고 주장하는 기능

이들은 confidence fallback으로 기존 동작을 유지한 뒤 별도 단계로 다룬다.

## 검증 기준

평가의 중심은 표지가 아니라 실제 본문이다.

1. 세로·가로 ordinary 대사, 나레이션, 반전 대사, 복잡 배경을 작품·페이지 단위로
   분리한 holdout을 만든다.
2. 합성 정답에서는 face-size 절대 오차 중앙/P90을 측정한다.
3. 실제 본문에서는 원문과 한국어 출력의 나란한 pairwise 평가를 하고 `현재 box-fit`,
   `bbox 두께`, `제안 방식`을 blind 비교한다.
4. 표지·광고·효과음은 별도 stress set으로 보고 headline 지표에 섞지 않는다.
5. confidence가 낮을수록 조용히 기존 방식으로 돌아가야 하며, 잘못된 큰 변경보다
   abstain을 선호한다.
6. 실제 production Canvas, 일반·세로·곡선·출력 렌더러의 일치와 저장 재실행을 확인한다.

초기 병합 기준으로 합성 P90 10% 이하, ordinary 본문 자동 적용률 80% 이상,
blind pairwise에서 현재 box-fit 대비 명확한 선호 증가를 권장한다. 실제 본문에는 원 제작
font-size 정답이 없으므로 합성 오차만으로 출시하지 않는다.

## 자료 조사 범위와 주요 1차 자료

검색 인덱스에서 중복 제거한 1,046개 연구·표준·코드 레코드를 제목/초록 수준으로
스크리닝했고, 직접 관련된 표준·논문·공식 코드 30여 개를 본문/구현 수준으로 확인했다.
이는 인터넷의 모든 게시물을 읽었다는 뜻이 아니라, 넓게 찾은 뒤 1차 자료로 좁힌
조사다.

- [CSS Fonts Module Level 5](https://www.w3.org/TR/css-fonts-5/)
- [OpenType Baseline Tags / Ideographic Character Face](https://learn.microsoft.com/en-us/typography/opentype/otspec190/baselinetags)
- [OpenType TrueType Fundamentals / em square](https://learn.microsoft.com/en-us/typography/opentype/otspec170/ttch01)
- [HTML Canvas TextMetrics](https://html.spec.whatwg.org/multipage/canvas.html)
- [Detection of Furigana Text in Images](https://arxiv.org/abs/2207.03960)
- [Unconstrained Text Detection in Manga](https://arxiv.org/abs/2009.04042)
- [De-Rendering Stylized Texts](https://openaccess.thecvf.com/content/ICCV2021/papers/Shimoda_De-Rendering_Stylized_Texts_ICCV_2021_paper.pdf)
- [Reading != Seeing: Typography Gap in VLMs](https://arxiv.org/abs/2603.08497)
- [FontCLIP official implementation](https://github.com/yukistavailable/FontCLIP)
- [Manga109 annotation format](https://manga109.github.io/manga109-project-website/en/annotations.html)
- [BallonsTranslator source-size geometry](https://raw.githubusercontent.com/dmMaze/BallonsTranslator/dev/ballontranslator/utils/textblock.py)
- [manga-image-translator text block](https://raw.githubusercontent.com/zyddnys/manga-image-translator/main/manga_translator/utils/textblock.py)
- [manga-image-translator renderer](https://raw.githubusercontent.com/zyddnys/manga-image-translator/main/manga_translator/rendering/__init__.py)

## 연구 산출물

- `scripts/research_source_font_size_smoke.py`: 합성 ground-truth 비교
- `scripts/research_source_font_size_real_smoke.py`: 실제 본문 저비용 estimator QA
- `scripts/research_source_font_size_ctd_smoke.py`: 한 CPU로 제한한 조건부 segmentation
  gate QA
- `scripts/research_source_font_size_cohorts.py`: 표지·유사 시리즈를 제외한 10+10 작품군
  봉인
- `scripts/research_source_font_size_hybrid.py`: 결정론적 측정 + 작은 잔차 보정기와 설정
  비교
- `scripts/research_source_font_size_render.cjs`: 실제 production export renderer A/B/C
  출력
- `scripts/research_source_font_size_panels.py`: 페이지·블록별 육안 비교 시트 생성
- `.tmp/source-font-size-smoke-all-fonts-r1/`: 내장 21개 폰트 합성 결과
- `.tmp/source-font-size-real-r1/`: 실제 본문 contact sheet
- `.tmp/source-font-size-ctd-content3-gated-r1/`: 실제 본문 CTD-gated contact sheet와 CSV
- `.tmp/source-font-size-hybrid/development/`: 개발군 10작품 × 12설정 렌더와 시트
- `.tmp/source-font-size-hybrid/holdout/`: 고정 설정으로 한 홀드아웃 10작품 최종 렌더와 시트
