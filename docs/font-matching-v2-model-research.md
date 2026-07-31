# Font Matching V2 모델 선택 기록

작성 기준일: 2026-08-01

## 결론

제품 모델을 원본 FontCLIP 하나로 다시 미세조정하지 않는다. 다음 4계층으로 분리한다.

1. **Frozen 비교군:** 공개 FontCLIP을 손대지 않고 15개 후보 retrieval baseline으로 측정한다.
2. **고품질 teacher encoder:** SigLIP 2 B/16 224 image tower를 `glyph_224`, `raw_224`, `context_224`와 실제 한글 render prototype에 맞춰 pairwise/listwise 학습한다.
3. **의미 teacher:** Gemma 4는 페이지 문맥에서 role·감정·강도·장르/톤 확률을 구조화해 제안하지만 font ID 정답을 만들지 않는다.
4. **제품 student:** teacher embedding과 인간 tier를 함께 증류한 소형 ONNX encoder/ranker만 앱 hot path에 넣는다.

## 원본 FontCLIP을 baseline으로만 두는 이유

[FontCLIP 원 논문](https://arxiv.org/abs/2403.06453)은 Roman alphabet font-attribute 데이터로 미세조정한 뒤 CJK로 일반화한다. 논문 자체도 CJK→Roman보다 Roman→CJK가 더 잘 맞았다고 보고한다. 이 앱의 핵심인 일본 만화 crop, 말풍선 옆글, 휘갈김, 효과음 역할, 후처리 분리, 작품 일관성은 원 학습 목적에 없다.

따라서 FontCLIP은 반드시 측정할 가치가 있는 비교군이지만, 그 점수를 제품 정답이나 pseudo-label로 사용하면 기존 약점을 다시 학습하게 된다. 재현 실험은 [공식 코드](https://github.com/yukistavailable/FontCLIP)의 현재 `main` HEAD `3d4c6af01f668800d8e4f9f4f753d29c74dad252`를 별도 환경에 고정한다. 이 저장소는 주 코드의 MIT와 함께 VPT/optimizer 일부에 비상업 CC 라이선스도 포함하므로, baseline 결과만 비교하고 코드·checkpoint를 제품에 포함하지 않는다. 배포 사용은 별도 라이선스 감사 없이는 금지한다.

## SigLIP 2 teacher

Google Research의 [SigLIP 2 공식 설명](https://google-research.github.io/big_vision/big_vision/configs/proj/image_text/README_siglip2.html)은 다국어 이해, localization/dense feature 개선, 여러 크기와 해상도 checkpoint를 제공한다. 첫 teacher는 86M 규모의 B/16 224로 고정한다.

- 현재 모든 정규화 view가 224×224라 전처리 계약이 단순하다.
- 4090에서 3-view batch와 15개 후보 prototype을 충분히 학습할 수 있다.
- image tower끼리 source glyph와 실제 한글 render를 직접 정렬할 수 있다.
- text tower는 장르명이나 작품명을 넣는 shortcut 통로로 사용하지 않는다.
- 마지막 block 일부와 projection부터 풀고, pilot/GroupKFold가 이득을 증명할 때만 더 많이 unfreeze한다.

NaFlex는 원본 종횡비 보존 ablation으로만 비교한다. 첫 모델은 frozen test를 건드리지 않고 B/16 224로 재현성을 우선한다.

## Gemma 4 teacher

[Gemma 4 공식 개요](https://ai.google.dev/gemma/docs/core)는 image 입력과 다양한 로컬 크기를 제공한다. 공식 메모리 표상 RTX 4090에서는 E4B와 양자화 12B 추론이 가능하지만, 앱 runtime에는 넣지 않는다.

사용 범위:

- blind 인간 판정이 끝난 pilot 일부에서만 role/style 설명 품질을 비교한다.
- primary reviewer에게 제안을 미리 보여주지 않는다.
- 낮은 확신, reviewer 불일치, `unknown_needs_review`, `none_acceptable` 후보의 사후 보조 설명에 사용한다.
- 출력은 고정 JSON schema와 근거 문장으로 제한하고, font 이름과 font ID 선택은 금지한다.
- E4B와 12B를 같은 200개 adjudicated 표본에서 비교해 role macro-F1·JSON 유효률·처리시간으로 하나만 고른다.

특히 12B는 [공식 개발자 설명](https://developers.googleblog.com/gemma-4-12b-the-developer-guide/)상 별도 vision encoder 대신 입력 projection을 쓰는 통합 생성 모델이다. 이를 retrieval embedding으로 억지 재사용하지 않고 문맥 판정 teacher로만 쓴다.

## 학습 단계

### A. 입력과 prototype

- source branch: `glyph_224`, `raw_224`, `context_224`를 독립 인코딩하고 view dropout을 적용한다.
- font branch: 15 family의 서로 다른 한글 문자열·weight·가로/세로 render를 인코딩한다.
- family positive는 여러 probe를 같은 positive bag으로 묶고 문자열 내용 shortcut을 막는다.
- outline, shadow, inverse, color, distortion은 별도 treatment head로 분리한다.

### B. loss

- 인간 tier의 `preferred > acceptable > marginal > unacceptable` pairwise/listwise loss
- preferred/acceptable multi-positive supervised contrastive loss
- role cross-entropy와 10개 style attribute regression
- `none_acceptable` binary head와 confidence calibration
- 작품/역할 균형 sampler, 같은 작품·다른 role 및 같은 장르·다른 style hard negative

### C. 작품 optimizer

block-local 점수 뒤에 `WorkTypographyProfileV2`를 적용한다.

- ordinary dialogue anchor 유지 penalty
- narration/thought anchor
- 역할별 SFX/강조 2–4 family palette
- intentional override margin
- 글리프 coverage와 실제 번역문 layout hard gate
- 장르 기여 상한 10%, 학습 중 genre dropout 50%; validation에서 제거 가능

### D. 증류와 ONNX

teacher를 그대로 배포하지 않는다. student 후보는 MobileViT/ConvNeXt-tiny급 또는 실측상 더 작은 encoder로 제한하고 다음을 함께 증류한다.

- teacher normalized embedding
- 인간 tier logits
- role/style/treatment heads
- none/confidence head

INT8/FP16 ONNX를 모두 내보내고 최소 지원 PC에서 정확도·p95·메모리를 비교한다. 정확도 gate를 통과하지 못한 양자화 모델은 배포하지 않는다.

## 반드시 비교할 실험

1. 현재 제목/정규식 방식
2. 역할별·작품별 majority
3. frozen FontCLIP
4. frozen SigLIP 2 feature + 선형 ranker
5. SigLIP 2 pairwise/listwise fine-tune
6. 5 + multi-view/role/style/treatment/none heads
7. 6 + 작품 profile optimizer
8. 7 + 약한 genre prior
9. 7의 distilled ONNX student

8이 7보다 작품 macro 성능을 안정적으로 올리지 못하거나 genre 제거/교환 gate를 깨면 장르 prior는 제품에서 제거한다. 9가 runtime gate를 못 맞추면 더 작은 student로 다시 증류하고, 품질을 낮춰 자동 적용하지 않는다.
