# Koharu 일반 텍스트·효과음 영역 분리 v11 인계

## 결론

최종 OCR 사각형은 Koharu의 `text`, `bubble`, `onomatopoeia` 검출만으로 만든다. PaddleOCR과 Hayai OCR의 기하는 사용하지 않는다. `panel` 검출은 효과음 조각을 합칠 때 서로 다른 패널을 넘지 못하게 하는 경계로만 사용하며, 일반 텍스트 사각형 생성에는 사용하지 않는다.

일반 텍스트와 효과음은 서로 다른 규칙과 ID 공간으로 처리한다.

- 일반 텍스트: `D001...`로 출력한다. 글자 보호 마스크를 통과하는 절단은 허용하지 않으며, 안전한 분리선이 없으면 글자 중간을 자르는 대신 해당 후보를 병합한다.
- 효과음: `FX001...`로 출력한다. Koharu가 글자별로 잘게 낸 조각은 같은 패널 안에서만 묶고, 일반 텍스트로 판단된 영역은 효과음보다 우선한다.

한글이 들어간 페이지는 예전 번역본일 수 있으므로 OCR 문자열 정확도나 Hayai confidence 임계값 조정에 사용하지 않는다. 다만 박스의 과병합·과분할·글자 절단 여부 같은 기하 검증에는 포함한다.

평가 detector는 `mayocream/koharu-layout-rfdetr-seg-2xl-1152@aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2`이며 weight SHA-256은 `9bf6d2cbd7793c956d8c857bb1672a396eb7f100eb0682f86830d05e31168efb`이다.

## 처리 순서

### 일반 텍스트

1. 각 Koharu `text` 마스크를 포함률, 중심점, 사각형 포함률로 가장 적절한 `bubble`에 한 번만 배정한다.
2. 배정된 `text` 마스크를 seed로 `bubble` 안에서 marker-controlled watershed를 수행한다.
3. 맞닿은 basin의 neck, interface, 명암 차이와 text mask 관계를 측정한다.
4. 같은 글자를 중복 검출한 경우처럼 text mask가 0.75 이상 겹치는 관계만 기본 병합한다. 아주 작은 nested duplicate만 별도 예외로 둔다.
5. 별도 대사를 나눌 때는 보호 대상 글자 픽셀을 만들고 모든 half-pixel 후보 seam을 검사한다. 보호 픽셀 손실이 정확히 0인 seam만 허용한다.
6. 한 말풍선 안에 안전한 seam이 없으면 글자 중간을 자르지 않고 해당 후보를 병합한다.
7. 어느 `bubble`에도 배정되지 않은 `text`는 독백·캡션·배경 내레이션용 일반 텍스트로 보존한다.
8. 페이지 단위에서 일반 텍스트끼리 겹칠 때도 같은 zero-ink seam 조건으로만 정리한다.

### 효과음

1. `onomatopoeia` proposal은 일반 텍스트와 별도의 목록에서 시작한다.
2. 같은 glyph가 `text`와 효과음 양쪽 class로 나온 경우 일반 텍스트를 우선한다.
3. score 0.50 미만의 넓은 효과음 proposal이 일반 텍스트 검출 2개 이상을 감싸면 layout class 오류로 보고 버린다.
4. 더 작고 높은 score의 proposal을 감싼 낮은 score의 broad duplicate는 제거한다.
5. 각 효과음 조각을 Koharu `panel`에 배정하고, panel ID가 정확히 같은 조각끼리만 묶는다. 어느 패널에도 배정되지 않은 조각은 다른 미배정 조각과만 비교한다.
6. 같은 패널 안에서 축이 맞는 반복 glyph는 최대 96px 거리, 거리 scale 1.60, 축 겹침 0.50 조건으로 묶는다. 일반 텍스트 병합 규칙을 재사용하지 않는다.
7. 그룹이 끝난 뒤 페이지 면적 18% 이상, mask density 18% 이하, score 0.50 미만인 단일 sparse graphic proposal은 효과음이 아닌 속도선·기하 도형으로 제거한다.
8. 효과음끼리의 겹침 정리는 일반 텍스트와 독립적으로 수행한다. 서로 다른 panel ID를 가진 효과음이 하나의 출력으로 합쳐지는 것은 검증 단계에서 실패 처리한다.

## 180장 v11 결과

| 측정값                                         |      결과 |
| ---------------------------------------------- | --------: |
| 페이지                                         |       180 |
| text가 배정된 bubble                           |       972 |
| 여러 text를 가진 bubble                        |       193 |
| watershed 후보 인스턴스                        |     1,184 |
| 최종 말풍선 대사 영역                          |     1,162 |
| 인접 관계 병합 / 분리                          |  23 / 196 |
| 말풍선 내부 겹침 정리                          |        29 |
| 글자 손실 없는 사각형 병합                     |         2 |
| 말풍선 밖 일반 텍스트                          |       176 |
| 최종 효과음 그룹                               |       338 |
| 제외한 효과음 proposal                         |        86 |
| 페이지 일반 텍스트 / 효과음 겹침 정리          |    12 / 6 |
| 빈 사각형 / 중복 ID / 최종 같은 namespace 교차 | 0 / 0 / 0 |
| 일반 텍스트 seam 보호 픽셀 손실                |         0 |

고정 회귀 페이지는 `P001`, `P002`, `P003`, `P019`, `P044`, `P045`, `P052`, `P055`, `P072`, `P086`, `P097`, `P104`, `P106`, `P110`, `P122`, `P135`, `P142`, `P166`, `P168`, `P173`, `P174`, `P175`다.

특히 다음 실패를 명시적으로 잠갔다.

- P044·P072: 서로 다른 패널의 효과음이 하나의 큰 박스로 이어지지 않는다.
- P104 K017·P142 K018: 페이지를 크게 덮는 sparse graphic을 효과음으로 남기지 않는다.
- P122·P173: 일반 텍스트 분리선이 글자 픽셀을 자르지 않는다.
- P166 K030·P174 K019: 여러 일반 텍스트 영역을 감싼 broad effect proposal을 제외한다.
- P168 K036: 일반 텍스트가 효과음 출력으로 중복되지 않는다.

## Hayai v2 감사 결과

`JustANormalTinkerer/hayai-ocr-v2@3608bb2075b9b39cb9f63e57251bca665de248cd`를 최종 효과음 crop 338개에만 실행했다. 이 결과는 효과음 사각형 생성이나 최종 자동 삭제에 사용하지 않았다.

RTX 4090 기준 순수 inference는 3.077초, 초당 109.838 crop, peak CUDA memory 약 1.01GiB였다. 빈 문자열은 0개였지만 confidence 단독 필터는 안전하지 않았다.

- 실제 효과음도 confidence 약 0.28까지 내려갔다.
- P104/P142의 그림 오검출은 오히려 `バン`, `パシッ`처럼 읽히며 약 0.94/0.73의 높은 confidence가 나왔다.
- crop을 줄이는 실험에서는 실제 glyph 일부가 잘린 뒤 남은 획을 반복 글자로 환각하는 경우가 확인됐다.

따라서 Hayai는 향후 보조 신호로는 쓸 수 있지만, confidence 임계값 하나로 효과음을 버리거나 box를 trim하는 정책은 채택하지 않는다. 한글 번역 페이지의 문자열 결과는 이 판단에서 제외했다.

## 산출물

- 구현: `scripts/evaluate_koharu_bubble_instances.py`
- 효과음 Hayai 감사: `scripts/score_effect_regions_with_hayai.py`
- 최종 180장 JSON·summary·독립 inventory: `artifacts/koharu-bubble-split-research/batch-180-v11-panel-safe-effects`
- 일반 텍스트 A/B/C 전체 페이지 180장과 gallery: `artifacts/koharu-bubble-split-research/batch-180-v11-dialogue-composites`
- 효과음 A/B/C 전체 페이지 180장과 gallery: `artifacts/koharu-bubble-split-research/batch-180-v11-effect-composites`
- Hayai 338 crop 결과: `artifacts/koharu-bubble-split-research/hayai-effect-all-v11.json`
- 문헌 메타데이터 inventory: `artifacts/koharu-bubble-split-research/literature`

두 gallery 모두 패널 crop이나 선별본이 아니라 원본 페이지 전체를 표시한다.

- A: 원문 전체 페이지
- B: Koharu 원본 검출
- C: 최종 일반 텍스트 또는 최종 효과음

## 재현과 검증

워크트리 루트에서 전용 venv Python으로 실행한다.

```powershell
$python = '.tmp\koharu-layout-eval-venv\Scripts\python.exe'
$input = 'artifacts\koharu-only-layout-evaluation-180-2026-08-31\results'
$result = 'artifacts\koharu-bubble-split-research\batch-180-v11-panel-safe-effects'

& $python scripts/evaluate_koharu_bubble_instances.py batch `
  --results-dir $input `
  --output-dir $result `
  --force

& $python scripts/evaluate_koharu_bubble_instances.py render-candidates `
  --input-dir $result `
  --output-dir artifacts/koharu-bubble-split-research/batch-180-v11-dialogue-composites `
  --mode dialogue

& $python scripts/evaluate_koharu_bubble_instances.py render-candidates `
  --input-dir $result `
  --output-dir artifacts/koharu-bubble-split-research/batch-180-v11-effect-composites `
  --mode effects

& $python scripts/evaluate_koharu_bubble_instances.py verify-regressions `
  --input-dir $result `
  --expected-page-count 180
```

`verify-regressions`는 모든 최종 bbox의 유효 면적과 페이지 경계, namespace별 ID의 유일성과 연속성, 같은 namespace의 상호 비중첩, 일반 텍스트 seam의 `protectedPixelLoss=0`, 효과음의 panel 경계 준수, `summary.json` 재집계 일치와 위 회귀 페이지를 검사한다.

## 남은 한계

- detector가 `text`와 `onomatopoeia` 어느 class로도 찾지 못한 glyph는 이 후처리만으로 복원할 수 없다.
- 효과음의 그림 오검출을 OCR confidence 하나로 완전히 제거할 수 없다. detector score, panel, text 우선순위, mask 밀도 같은 독립 증거가 더 필요하다.
- 현재 임계값은 이번 180장과 사용자 지적 사례에 맞춘 연구용 값이다. 앱 통합 전에는 별도 수동 gold set에서 과분리·과병합 precision/recall을 측정해야 한다.
- CPU ONNX/OpenVINO 변환과 속도·동등성 평가는 보류했다. 현재 결과는 원본 PyTorch detector 출력 기준이다.

문헌 조사는 26개 검색식의 Crossref 결과 312건을 수집하고 DOI 기준 282개 고유 메타데이터 레코드로 정리했다. 이는 282편을 모두 정독했다는 의미가 아니다. 구현에는 comic text/balloon segmentation, marker-controlled watershed, bottleneck/clump splitting, boundary-aware instance segmentation, graph partition 계열을 우선 참고했다.
