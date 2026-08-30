# 글자 크기 자동 맞춤 v3 인계서

최종 갱신: 2026-08-31 KST
적용 브랜치: `master`
연구 기준 커밋: `4c0000ee`
임시 워크트리 커밋: `a3ba1493`

## 결론

12px를 16px로 올리는 전역 최솟값은 넣지 않았다. 실제 만화에는 9~14px 상당의
후리가나, 속삭임, 구석 광고 문구가 존재하므로 그런 하한은 정답인 작은 글씨를 망친다.

이번 문제의 주원인은 폰트 크기 모델이 아니라 그 앞의 OCR geometry lock이었다. 모델이
여러 세로줄을 감싸는 올바른 영역을 내도, 코드가 대표 OCR 한 줄의 작은 사각형으로 다시
줄인 뒤 그 안에 전체 원문 글자 수를 넣어 측정했다. 그 결과 정상 본문이 8~12px로
붕괴했다. v3는 원문 OCR 줄을 안전하게 복원하고 각 줄을 독립 측정한 robust median을
사용한다. 증거가 불충분하거나 줄별 값이 크게 충돌하면 기존 합쳐진 영역 측정으로
되돌아간다.

새 신경망이나 새 배포 자산은 추가하지 않았다. 실제 실패 원인이 코드 소유 geometry
evidence 손실이었고, 같은 OCR/같은 raster에서 이를 바로잡는 편이 더 작고 감사 가능한
수정이었다.

## 제품 로직

1. 일반 모델 출력에 대표 OCR id만 있어도 모델 bbox 안의 아직 사용되지 않은 OCR
   조각을 검사한다. 정규화한 원문과 정확히 대응하고, 원문 글자의 72% 이상을 서로 다른
   위치에서 덮고, 합친 범위가 모델 bbox와 물리적으로 타당할 때만 여러 줄을 복원한다.
2. OCR 줄 bbox와 OCR 원문은 `source-font-line-geometry-v1`이라는 코드 소유 증거로
   붙인다. 모델이 같은 필드를 위조해도 먼저 제거한다.
3. source text에 대응하지 않는 줄, 중복 후보, direction voter가 아닌 후보를 제외한다.
   여러 줄 중 횡축 크기가 최대 본문 줄의 58%보다 작은 줄도 빼서 후리가나가 본문 크기를
   끌어내리지 못하게 한다. OCR 한 글자 치환은 제한적인 근사 일치로 허용한다.
4. 각 OCR 줄에서 기존 `raster-core-v1`을 독립 실행한다. 두 줄 이상이면 중앙값을 쓰고,
   median absolute relative dispersion이 0.35를 넘으면 포기한다. 한 줄이면 합쳐진 모델
   문자열 길이가 아니라 그 OCR 줄의 실제 글자 수를 쓴다.
5. 줄 증거가 없거나 거부되면 기존 merged bbox 경로를 그대로 쓴다. 회전 SFX, 너무 긴
   원문, texture가 심한 영역 등 기존 abstention도 유지한다.
6. 줄 geometry는 크기 측정 뒤 폰트 계열 AI worker에 보내지 않는다. 따라서 inference
   contract나 모델 자산은 변하지 않는다.

주요 구현:

- `src/main/pipeline/overlayOcrGeometryLocks.ts`
- `src/main/pipeline/overlayOcrSourceLineGeometry.ts`
- `src/main/pipeline/sourceFontSizeEstimator.ts`
- `src/main/pipeline/automaticFontMatchingV2PageStage.ts`
- `src/main/pipeline/types.ts`

## 기존 보관함 감사

메인 보관함의 표지성 앞쪽 페이지를 제외하고 저장된 요청/결과와 실제 원본을 replay했다.

- 감사 블록: 7,419
- 줄 geometry가 복원된 블록: 7,140
- 두 줄 이상인 블록: 4,950
- 대표 한 줄로 잘못 축소되었다가 모델 영역으로 복구된 블록: 12
- 기존 source face가 14px 이하인 블록: 106
- replay 오류: 0

7,140개 줄-증거 블록 중 기존/신규 추정이 모두 나온 6,558개를 비교했다.

- ±10% 이내: 5,619 / 6,558 (85.68%)
- ±20% 이내: 6,065 / 6,558 (92.48%)
- 1.5배 이상 커진 블록: 21
- 0.67배 이하로 작아진 블록: 119
- 0.5배 이하로 작아진 블록: 14

작아진 수가 더 많은 것은 merged multi-line bbox의 높이/너비를 한 글자 크기로 오인하던
기존 과대 추정이 줄별 중앙값으로 교정되기 때문이다. 변화량 상·하위와 14px 이하 106개를
원본 crop contact sheet로 전부 직접 확인했다. 낮은 값의 대부분은 실제 후리가나,
속삭임, 작은 측면 문구였고 전역 하한을 정당화하지 않았다. 표지는 판정에서 제외했다.

대표 회귀 사례:

| 원문                             |     기존 |       v3 | 원인/판정                                               |
| -------------------------------- | -------: | -------: | ------------------------------------------------------- |
| `皆 お兄様みたいに…`             |  8.272px | 16.647px | 38×42 대표 조각이 109×150의 4줄 범위로 복구됨           |
| `じつはね クッキーを…`           |  7.825px | 15.716px | 서로 다른 review group의 4줄을 41×90에서 122×225로 복구 |
| `経験値 3815`                    | 10.911px | 20.373px | 한 줄 OCR의 실제 글자 수 사용                           |
| `二人分の人生の記憶があり…`      | 11.548px | 18.688px | 두 줄 독립 측정                                         |
| `落ち着いて 少し整理してみよう…` | 37.206px | 16.634px | merged 세로 범위 과대 추정을 줄 중앙값으로 교정         |
| 작은 `ごめんなさい…`             |  9.377px |  9.377px | 진짜 작은 글씨는 그대로 보존                            |

## 다른 작품 스모크

`C:\Users\sam40\AppData\Local\Tachidesk\downloads\mangas`에서 provider 5개,
작품 9개를 골랐다. 작품마다 중간 화에서 앞 3쪽·뒤 2쪽을 버리고 27/53/76% 위치의
본문 3쪽을 선택했다. 총 27쪽을 contact sheet로 확인했으며 표지나 타이틀 페이지만인
샘플은 없었다.

같은 27쪽에 production PP-OCRv6을 두 번 새로 실행했다.

- semantic group 299, 양쪽 estimator 성공 258
- multi-line group 152, 줄 증거 group 272
- 중앙값: 24.868px → 24.770px
- 12px 이하: 19 → 19
- 14px 이하: 23 → 23
- 1.3배 이상 증가: 5, 0.75배 이하 감소: 4
- 두 실행의 추정값/geometry 결과는 동일했고 차이는 임시 경로와 실행 로그뿐이었다.

14px 이하 23개를 모두 확인했다. 전부 후리가나 또는 작게 인쇄된 측면 홍보 문구였다.
가장 크게 커진 일반 본문은 원문과 더 가까워졌고, 가장 크게 작아진 블록은 merged 영역의
과대 추정이 교정된 경우였다.

이어 작품마다 한 쪽씩 총 9쪽을 실제 Gemma 번역 page pipeline으로 실행했다.

- 9작품/9쪽 모두 완료
- 번역 블록 83, 크기 추정 79, 줄 증거 80
- 12px 이하 0, 14px 이하 1
- 유일한 13.738px 블록은 작은 잡지 측면 홍보 문구
- 25% 이상 감소 7, 30% 이상 증가 0

이 수동 판정은 evaluation-only다. human gold, 학습 label, calibration label이 아니다.

## 실제 인페인팅 렌더 QA

저장된 실제 인페인팅 이미지를 production `createPageExportRenderSession`으로 다시
렌더했다. 4쪽 5블록에서 baseline과 v3 candidate 사이에는 선택한 source-face evidence와
복구된 OCR bbox 외의 차이가 없다.

- 8.272 → 16.647px 본문: 기존의 지나치게 작은 한글이 원문 본문 높이에 가까워짐
- 7.825 → 15.716px 본문: 크기는 회복됨. 이 페이지에 이미 남아 있던 인페인팅 잔상은
  별도 문제이며 이번 크기 로직이 만든 회귀가 아님
- 11.548 → 18.688px 생각글: 원문과 가까운 크기로 회복됨
- 37.206 → 16.634px 생각글: 같은 페이지에서 과대 글자가 함께 줄어듦
- `경험치 3815`: source estimate는 교정됐지만 현재 render fit의 병목이 아니어서 화면을
  불필요하게 바꾸지 않음

로컬 QA 산출물:

- `.tmp/source-font-size-v3/render-cases-panels-v1/overview-ocr-line-geometry-v3.png`
- `.tmp/source-font-size-v3/render-cases-panels-v1/page-*-blocks-ocr-line-geometry-v3.png`

## 인터넷 조사와 채택 판단

2026-08-30~31에 검색어 조합을 바꾼 104회의 웹 검색을 수행했고, 구현 판단에는 공식
문서와 원 논문만 사용했다. 조사 축은 OCR polygon/line grouping, curved text geometry,
일본어 활자 face metric, ruby 배치, adaptive threshold, 만화 OCR/data, typography VLM
한계였다.

채택한 근거:

- PaddleOCR가 polygon/box를 구조화된 OCR 결과로 제공하므로, 합쳐진 문장 bbox 하나보다
  검출 줄 geometry를 보존하는 편이 원 데이터 계약에 맞다.
  <https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/OCR.en.md>
- CRAFT/TextSnake와 후속 text-grouping 연구는 글자/줄/instance geometry를 별도 evidence로
  유지하는 방향을 지지한다.
  <https://arxiv.org/abs/1904.01941>,
  <https://openaccess.thecvf.com/content_ECCV_2018/html/Shangbang_Long_TextSnake_A_Flexible_ECCV_2018_paper.html>,
  <https://openaccess.thecvf.com/content/CVPR2024/html/Bi_Text_Grouping_Adapter_Adapting_Pre-trained_Text_Detector_for_Layout_Analysis_CVPR_2024_paper.html>
- OpenType의 ideographic character face와 CSS `ic` metric은 일본어 em box 전체가 아니라
  실제 CJK 문자 face를 크기 기준으로 삼는 현재 raster-core 설계와 맞는다.
  <https://learn.microsoft.com/en-us/typography/opentype/spec/baselinetags>,
  <https://www.w3.org/TR/css-fonts-5/>
- JLREQ와 furigana 연구는 ruby를 본문 글자와 다른 작은 annotation으로 다뤄야 함을
  뒷받침한다.
  <https://www.w3.org/TR/jlreq/?lang=en>,
  <https://arxiv.org/abs/2207.03960>

검토 후 버린 방법:

- `min 16px` 같은 전역 하한: 실제 작은 본문/후리가나를 훼손하므로 폐기
- merged bbox의 짧은 축 또는 면적만 사용: 여러 줄, 행간, 말풍선 여백 때문에 과대/과소
  양쪽 오류가 생겨 폐기
- Sauvola/Niblack를 단독 정답으로 사용: 배경 분리 후보로는 유효하지만 geometry 붕괴를
  해결하지 못해 기존 raster-core의 보조 실험으로만 남김
  (<https://scikit-image.org/docs/stable/auto_examples/segmentation/plot_niblack_sauvola.html>)
- 새 VLM에게 px를 직접 회귀시키기: 현재 오류는 deterministic geometry 손실이고,
  typography 이해 자체가 최신 VLM에서도 약하다는 보고가 있어 이번 제품 경로에서는
  비용과 비결정성이 더 큼
  (<https://arxiv.org/abs/2603.08497>)
- Manga109/manga-ocr를 즉시 재학습 데이터로 사용: 유용한 후속 연구 자원이지만 이번
  보관함의 size gold가 아니므로 제품 label로 승격하지 않음
  (<https://github.com/manga109/manga109api>,
  <https://github.com/kha-white/manga-ocr>)

## 재현

```powershell
npm run compile:electron

node scripts/research_source_font_size_v3_geometry_audit.cjs `
  --library library `
  --output .tmp/source-font-size-v3/geometry-audit-v5.json `
  --exclude-leading-pages 2

.\node_modules\.bin\electron.cmd scripts/research_source_font_size_v3_production_smoke.cjs `
  --audit .tmp/source-font-size-v3/geometry-audit-v5.json `
  --output .tmp/source-font-size-v3/geometry-production-smoke-all-lines-v5.json `
  --scope line --limit 0

python scripts/research_source_font_size_v3_tachidesk_samples.py `
  --root C:\Users\sam40\AppData\Local\Tachidesk\downloads\mangas `
  --output .tmp/source-font-size-v3/tachidesk

.\node_modules\.bin\electron.cmd scripts/research_source_font_size_v3_tachidesk_smoke.cjs `
  --manifest .tmp/source-font-size-v3/tachidesk/tachidesk-body-samples.json `
  --output .tmp/source-font-size-v3/tachidesk/ocr-smoke.json

node scripts/research_source_font_size_v3_render_cases.cjs
```

전체 Gemma smoke는 기존 OCR 결과와 로컬 서버가 필요하므로
`scripts/research_source_font_size_v3_tachidesk_full_smoke.cjs --help`의 인자를 사용한다.

## 코드 검증

- 메인 통합 Vitest coverage: 590 files passed; 4,617 tests passed, 2 skipped
- V8 전체 coverage: lines 81.29%, statements 80.02%, functions 82.72%,
  branches 72.75%
- 관련 geometry/estimator/coverage-gate 집중 테스트: 69 passed
- TypeScript renderer/electron typecheck, ESLint, Electron compile,
  script-entrypoint gate 통과
- 새 파일과 수정 파일은 production cleanup exact coverage floor에 등록. 메인 통합
  artifact SHA-256은
  `65e5ea2b7fba04ef0f9bdb29a59387ecca599ef2db6fe90831f720a2630bfe2b`이며,
  573 existing / 227 introduced / 9 deleted 파일을 검증
- 통합 `npm run check`: 349.33초에 전체 통과. production build, 긴 경로
  image-protocol smoke, renderer/preload bundle guard 포함
- page-artwork parity 두 케이스 모두 `mismatchedPixels=0`, `maxChannelDelta=0`
- 렌더러 UI 변경은 없으므로 `qa:ui` 대상이 아님

## 남은 경계

- 기존 보관함에 이미 저장된 블록을 자동 migration하지 않는다. 새 분석 또는 해당 페이지
  재분석부터 새 증거가 적용된다.
- OCR이 줄을 놓치거나 원문과 대응하지 못하면 기존 merged 측정으로 되돌아가므로 모든
  페이지를 강제로 바꾸지 않는다.
- 한 semantic block 안에 의도적으로 서로 다른 본문 크기가 섞이면 중앙값은 주된 크기를
  선택한다. 개별 span 크기 렌더가 필요하면 별도 text-span contract가 필요하다.
- 회전이 큰 SFX는 기존처럼 source-size estimator 대상이 아니다.
- 표지는 사용자 요구에 따라 연구·판정 대상에서 제외했다.
