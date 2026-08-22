# MangaFont GlyphVoice 연구·구현 계획

작성일: 2026-08-21 KST

## 1. 문제를 다시 정의한다

현재 R33 계열은 이미 압축된 원문 특징을 평균한 뒤 작은 보정 헤드와 페이지 prior를
붙인다. 이 구조는 평범한 대사에서 `ridi-batang`, `nanum-barun-gothic`,
`nanum-myeongjo`가 오가는 현상을 근본적으로 해결하지 못했다. 동시에 일반 대사를 한
폰트로 강제하면 붓글씨, 속삭임, 외침처럼 작가가 의도한 변화까지 지운다.

새 목표는 단순한 21-way 분류가 아니다.

1. 서로 다른 문자 체계에서도 획 굵기, 세리프, 곡률, 폭, 끝처리와 손글씨 리듬을 비교한다.
2. 같은 화에서 반복되는 일반 대사의 시각적 목소리를 학습한다.
3. 실제로 다른 시각적 목소리는 공통값에 끌려가지 않고 예외로 분리한다.
4. 사람 gold 없이도 정확한 자동 학습쌍을 만들고, AI 라벨의 불완전성을 숨기지 않는다.
5. 실제 앱에서 4~8 CPU 코어로 보통 12문장 페이지를 약 3초 이내에 처리한다.

제안 모델의 작업명은 **MangaFont GlyphVoice**다. 기존 R33/R45의 residual이나 후보 ID
보정기를 초기값으로 사용하지 않는 독립 모델이다.

## 2. 연구에서 채택한 핵심

### 2.1 글자 내용과 폰트 스타일을 분리한다

- [Few-Shot Font Style Transfer Between Different Languages](https://openaccess.thecvf.com/content/WACV2021/html/Li_Few-Shot_Font_Style_Transfer_Between_Different_Languages_WACV_2021_paper.html)는 다른 언어 사이의 전이에 전역·국소 다중 레벨 특징이 필요함을 보였다.
- [XMP-Font](https://openaccess.thecvf.com/content/CVPR2022/html/Liu_XMP-Font_Self-Supervised_Cross-Modality_Pre-Training_for_Few-Shot_Font_Generation_CVPR_2022_paper.html)는 획·부품·문자 전체 규모를 함께 보존하는 자기지도 표현을 사용한다.
- [DARLING](https://openaccess.thecvf.com/content/CVPR2024/html/Zhang_Choose_What_You_Need_Disentangled_Representation_Learning_for_Scene_Text_CVPR_2024_paper.html)은 같은 스타일·다른 내용의 쌍으로 내용과 스타일을 분리한다.
- [A Deep Factorization of Style and Structure in Fonts](https://aclanthology.org/D19-1225/)는 문자별 내용과 폰트별 스타일을 별도 잠재변수로 모델링한다.
- [Font Representation Learning via Paired-glyph Matching](https://arxiv.org/abs/2211.10967)은 같은 폰트의 서로 다른 글리프를 끌어당기는 대조 학습이 보지 못한 폰트에도 일반화됨을 보였다.

이를 우리 문제에 맞춰, 같은 폰트 파일에서 렌더한 일본어와 한국어는 정확한
cross-script 양성쌍으로 사용한다. 일본어 전용·한국어 전용 폰트는 임의로 서로 짝짓지
않고 각 언어 안에서 font-instance 대조 학습에 사용한다. 양쪽 공간은 정확한 교량쌍으로만
정렬한다.

### 2.2 한 벡터로 평균하지 않고 획 집합끼리 비교한다

- [Few-Shot Font Generation by Learning Fine-Grained Local Styles](https://openaccess.thecvf.com/content/CVPR2022/html/Tang_Few-Shot_Font_Generation_by_Learning_Fine-Grained_Local_Styles_CVPR_2022_paper.html)는 국소 획 스타일과 공간 대응을 cross-attention으로 찾는다.
- [Matching Feature Sets for Few-Shot Image Classification](https://arxiv.org/abs/2204.00949)는 이미지당 단일 벡터 대신 특징 집합을 유지하고 set-to-set 거리로 비교할 때 fine-grained 전이가 개선됨을 보였다.
- [Relation Network](https://arxiv.org/abs/1711.06025)는 고정 코사인 거리가 아니라 query와 후보의 비선형 관계 자체를 학습한다.
- [Feature Map Reconstruction Networks](https://arxiv.org/abs/2012.01506)는 query의 국소 특징을 후보 특징으로 얼마나 잘 재구성하는지가 효율적인 fine-grained 판별 신호임을 보였다.
- [VQ-Font](https://openaccess.thecvf.com/content/ICCV2023/html/Pan_Few_Shot_Font_Generation_Via_Transferring_Similarity_Guided_Global_Style_ICCV_2023_paper.html)는 미리 정의한 언어별 획 사전 대신 학습된 국소 코드와 전역 특징을 함께 쓴다.

GlyphVoice는 원문을 벡터 하나로 평균하지 않는다. 원문 세 view에서 다중 스케일 획 토큰을
만들고, 후보 폰트마다 미리 계산한 한국어 획 토큰과 양방향 attention/soft transport를
수행한다. 후보 점수는 전역 스타일 거리와 정렬된 국소 획 관계를 함께 사용한다.

### 2.3 불완전한 AI 라벨을 완전한 정답처럼 쓰지 않는다

- [PRODEN](https://proceedings.mlr.press/v119/lv20a.html)은 후보 라벨 집합 안에서 정답
  posterior를 점진적으로 갱신한다.
- [FREDIS](https://proceedings.mlr.press/v202/qiao23b.html)는 후보 집합 자체가 불완전할
  때 refinement와 disambiguation을 분리한다.
- [Learning with Partial-Label and Unlabeled Data](https://proceedings.mlr.press/v235/liu24ar.html)는 partial label과 unlabeled 신호를 같은 학습 체계에서 다룬다.
- [On Learning Contrastive Representations for Learning With Noisy Labels](https://openaccess.thecvf.com/content/CVPR2022/html/Yi_On_Learning_Contrastive_Representations_for_Learning_With_Noisy_Labels_CVPR_2022_paper.html)는 noisy label이 표현 자체를 지배하지 않도록 대조 정규화를 분리한다.

현재 1,347개 direct AI 라벨은 21개 중 7개 후보만 검토됐다. 따라서 preferred는 양성,
acceptable은 가능한 양성, marginal은 불확실, unacceptable은 음성으로 쓰고, 나머지
14개 미검토 후보에는 라벨 손실을 주지 않는다. 모델이 스스로 높은 확률을 줬다는 이유로
미검토 후보를 즉시 정답으로 승격하지 않는다.

### 2.4 페이지 일관성은 hard intersection이 아니라 학습된 목소리 혼합이다

페이지의 각 행을 하나의 독립 샘플로만 보지 않고 작은 set으로 본다. ordinary dialogue
행에서 1~2개의 잠재 `voice slot`을 학습하고, 각 행은 다음 셋 중 하나에 연속 확률로
배정된다.

- 페이지의 주된 일반 대사 목소리
- 두 번째 반복 목소리(예: 화자·내레이션 차이)
- 의도적 예외/변칙 목소리

최종 점수는 local matcher와 voice slot posterior를 learned gate로 합친다. 한 행이 공통
후보를 지지하지 않는다고 페이지 합의를 전부 취소하지도 않고, 반대로 다수결이 강한
원문 스타일 변화를 덮지도 않는다. 학습용 synthetic page episode에는 한 폰트로 된 일반
대사, 두 개의 반복 목소리, 1~3개의 의도적 예외를 모두 포함한다.

## 3. 데이터 구성

### 3.1 정확한 자동 정답: cross-script bridge corpus

1. OFL 또는 훈련 허용 라이선스인 폰트만 별도 inventory에 수집한다.
2. 일본어와 한국어 cmap을 모두 가진 face에서 두 언어 문장을 렌더한다.
3. cmap entry만 믿지 않는다. 각 글리프의 outline이 `.notdef`와 다른지 확인하고 실제
   렌더가 non-empty인지 검사한 뒤, **검증된 글리프끼리만** 양성쌍을 만든다.
4. 같은 face의 검증된 일본어/한국어는 양성, 다른 face는 음성이다.
5. 일본어 글리프가 여러 한국어 폰트에 복제된 fallback인지 렌더/outline hash로 검사하고
   중복 bridge는 제거한다.
6. weight, width, slant 같은 variable axis는 실제 axis 값으로만 확장한다. 같은 이미지를
   단순 복제해 표본 수를 부풀리지 않는다.

2026-08-22에 이 계약으로 새 OFL source pack과 bridge corpus를 실제 생성했다.

- source pack v2: 149 faces / 132 families
- Google Fonts: 93 representative faces, 그중 variable 12개는 원본을 보존하고
  `wght=400` 정적 인스턴스로 materialize
- Noto CJK KR: Sans/Serif 14개 고정 weight faces
- bridge corpus v3: 1,119 sentence samples, 136 same-face JP/KR pairs, 1,255 assets
- face category: cross-script 19, Japanese-only 60, Korean-only 44, insufficient 26
- cross-script family split: train 3 / validation 1 / test 1, family-disjoint

1:1 이미지를 직접 열어 보면서 Google Noto Sans KR variable의 내부 default가 사실상 얇은
축으로 렌더되던 버그를 발견했다. `wght=400` 정적 인스턴스로 다시 만든 뒤 JP/KO 양쪽이
정상 Regular 굵기로 바뀌었다. 따라서 source pack validator는 variable 원본의 `fvar`,
materialization 좌표, 원본/결과 SHA와 static 결과의 `fvar` 부재를 모두 검증한다. 이 검사는
시각 검수가 데이터 생성 계약 자체를 고친 사례이며, 이전 source pack v1/corpus v2는 새
모델 학습에 사용하지 않는다.

2026-08-21 초기 cmap 조사에서는 40개 bridge face 중 일본어 렌더가 고유한 face가
36개였지만, 개별 실제 렌더 검사에서 JUA의 일본어가 `.notdef` 사각형으로 드러났다.
따라서 이 숫자는 최종 학습 수가 아니며 글리프 단위 실렌더 검사 후 다시 계산한다.
Google Fonts 공개 metadata에는 일본어 68가족, 한국어 38가족이 있다. 일본어 전용 폰트는
cross-script 정답으로 위조하지 않고 monolingual representation 학습에만 쓴다.

### 3.2 실제 만화 도메인 적응

- 원문 raw crop, 주변 context, 글자만 남긴 glyph view를 사용한다.
- Koharu text segmentation은 글자 view를 정제하는 입력으로 사용할 수 있으나, 폰트를
  규칙으로 선택하는 경로에는 사용하지 않는다.
- 저해상도, JPEG/PNG 압축, 흰 외곽선, 검은 외곽선, 세로쓰기, 회전과 말풍선 배경을
  synthetic bridge render에도 적용한다.
- 기존 28,094 crop은 label-free domain contrast와 실제 background 적응에 사용한다.
- 1,347 direct label은 partial-label fine-tuning에만 사용한다.

## 4. 모델 구조

### 4.1 StrokeBridge encoder

- MobileOne식 re-parameterizable convolution을 기반으로 한다.
- 학습 중에는 다중 branch를 사용해 표현력을 확보하고, ONNX export 시 단일 convolution
  경로로 접는다.
- raw/context/glyph view는 가중치를 공유한다.
- 마지막 global pooling만 쓰지 않고 저·중·고해상도에서 총 12~16개의 style token을
  추출한다.
- style token에는 script/content adversary가 문자 종류를 예측하지 못하게 하고, 별도
  content token은 알려진 synthetic 문자열을 예측한다. 두 subspace의 cross-covariance도
  억제한다.

### 4.2 Cross-Script Stroke Transport matcher

- 후보 폰트별 한국어 probe glyph의 style token을 미리 계산한다.
- 원문 token과 후보 token 사이 cost matrix를 만든다.
- 작은 bidirectional cross-attention과 dustbin을 포함한 soft transport로 대응되지 않는
  획을 버릴 수 있게 한다.
- global weight/width/serif 표현과 local transport residual을 relation MLP에서 결합한다.
- 후보 ID one-hot은 사용하지 않는다. 새 후보도 prototype만으로 평가할 수 있어야 한다.

### 4.3 VoiceSet

- 페이지/화의 ordinary block embedding을 set encoder에 넣는다.
- 최대 두 개의 반복 voice slot과 하나의 exception slot을 학습한다.
- 각 행의 gate는 local confidence, slot distance, source-style surprise를 입력으로 받는다.
- semantic role은 보조 신호일 뿐 local visual evidence를 대체하지 않는다.
- 사용자 기본 서식 폰트는 자동 선택의 후보 근거가 아니다.

## 5. 손실과 학습 순서

1. **Cross-script pretraining**
   - same-face JP/KR supervised contrastive
   - font-instance discrimination within each script
   - content adversarial/cross-covariance loss
   - token transport reconstruction loss
2. **Real manga adaptation**
   - view-consistency contrastive on label-free real crops
   - partial-label mass loss on reviewed candidates only
   - EMA teacher는 같은 모델의 안정화 용도로만 사용하며 별도 5-model 합의는 쓰지 않는다.
3. **VoiceSet training**
   - synthetic one-voice/two-voice/exception episodes
   - 실제 page groups의 반복성은 soft auxiliary로만 사용
4. **Joint low-LR finish**
   - encoder 하단은 고정하고 token/matcher/VoiceSet만 함께 조정

## 6. 시각 검수 계약

폰트 정답을 큰 contact sheet나 전체 페이지 한 장으로 판단하지 않는다.

- 파일 하나에는 원문 한 문장과 후보 하나만 1:1로 둔다.
- 원문 글자 crop은 크게, 주변 말풍선 context는 작은 보조 영역으로 둔다.
- 후보는 같은 번역문, 같은 크기, 같은 외곽선 조건으로 렌더한다.
- 각 후보 파일을 개별적으로 열어 획 굵기, 세리프, 모서리, 곡률, 폭, 손글씨 리듬을 본다.
- 학습 데이터 표본 감사와 최종 모델 판정을 같은 형식으로 수행한다.
- 전체 페이지는 2차적으로 화 일관성과 의도적 예외 보존만 확인한다.

첫 실제 모델은 이전에 쓰지 않은 텍스트가 많은 4페이지에서 R33과 비교한다. 각 변경
문장은 R33 후보와 GlyphVoice 후보를 각각 독립 1:1 파일로 연다. 시각적으로 명확하지
않으면 8페이지로 늘리되, 명백히 나쁘면 즉시 원인별로 폐기한다.

## 7. CPU 예산

2026-08-21 현재 R33 encoder ONNX를 실제 CPUExecutionProvider로 측정한 결과(세션 초기화
제외, random input, 세 view/문장)는 다음과 같다.

| 문장 수 | 4 threads median | 8 threads median |
| ------: | ---------------: | ---------------: |
|       1 |          0.349 s |          0.260 s |
|       4 |          2.277 s |          1.108 s |
|      12 |          5.419 s |          3.592 s |
|      20 |          9.224 s |          6.400 s |

GlyphVoice 목표는 보통 12문장 페이지에서 4 threads 약 3초 이하, 8 threads 2초대 이하다.
StrokeBridge는 후보 prototype을 미리 계산하고, 페이지의 모든 crop을 한 batch로 처리한다.
최종 후보만 INT8 양자화 전후 이미지 A/B와 score parity를 확인한다. FLOP 추정만으로 CPU
승격을 주장하지 않고 ORT-Web WASM과 native ORT를 모두 실측한다.

## 8. 중단·전환 기준

- synthetic bridge retrieval이 좋아도 실제 1:1 이미지가 나쁘면 실패다.
- 실제 4페이지에서 R33보다 명확히 나은 문장이 없으면 페이지 prior를 먼저 키우지 않는다.
- local matcher가 원문 스타일을 못 읽으면 데이터/encoder 문제로 분류한다.
- local은 맞는데 같은 화에서 왕복하면 VoiceSet 문제로 분류한다.
- 한 폰트로 뭉개면서 지표만 오르면 즉시 실패다.
- 동일 모델에 작은 residual을 반복 추가하지 않는다. 실패 원인이 데이터, 표현, 구조 중
  어디인지 1:1 이미지와 attention correspondence로 확인한 뒤 해당 축만 바꾼다.
