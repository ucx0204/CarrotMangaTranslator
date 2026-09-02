# 글자 크기 AI · HayaiOCR 상세 조사 2026-09-02

## 조사 범위와 재현성

- 캠페인 001의 다섯 번째 실험이 끝난 직후, 다음 화를 고르기 전에 실행했다.
- 서로 다른 검색 질의 200개를 실제로 실행했다. 최초 진단 질의 4개와, 28개 주제 ×
  7개 관점으로 만든 196개 질의다.
- 49개 검색 batch에서 URL 언급 1,231건, 중복 제거 URL 930개를 얻었다.
- 검색 결과에는 2차 글·포럼도 섞였지만, 설계 판단은 논문·저자 공식 구현·공식 데이터셋만
  근거로 삼았다. 정확한 200개 질의는
  `artifacts/font-size-ai-lab/research-2026-09-02/query-manifest.json`에 고정한다.
- 28개 주제는 세로쓰기, 후리가나, 투영 프로파일, 연결요소, 만화 텍스트, 말풍선,
  패널/읽기 순서, 인스턴스 중복, robust bbox, 그래프 군집, 임의 형상 텍스트,
  PSENet/PAN/DBNet/CRAFT/TextSnake/Mask TextSpotter, 일본어 문서 layout, 글리프 크기,
  robust statistics, stroke width, OCR hierarchy, Manga109, repulsive border를 포함한다.
- 각 주제는 arXiv 1차 자료, CVF 1차 자료, loss/post-process, 저자 공식 구현,
  benchmark, 작은 글자 실패, 일본어 세로쓰기 적용 관점으로 검색했다.

## 1차 자료에서 얻은 핵심

1. [Detection of Furigana Text in Images](https://arxiv.org/abs/2207.03960)는
   morphology와 connected component 분석으로 후리가나를 별도 검출하고, Manga109에서
   OCR 성능을 5% 개선했다고 보고한다. 만화에서는 책보다 어렵다는 실패 조건도 명시한다.
2. [Unconstrained Text Detection in Manga](https://arxiv.org/abs/2010.03997)는 만화 텍스트를
   bbox가 아니라 character-level pixel metric으로 평가한다. 현재처럼 bbox 짧은 축을
   글자 크기로 바로 쓰는 접근보다 내부 글리프 증거가 권위여야 한다.
3. [Manga109-v2026](https://arxiv.org/abs/2605.21182)는 약 29,000개 대사 annotation을
   다시 고치면서 누락, 대사/효과음 중첩, 말풍선 과소 분할을 별도 오류 유형으로 분리했다.
   하나의 종합 IoU 숫자로 모든 geometry 오류를 덮으면 안 된다.
4. [PixelLink](https://arxiv.org/abs/1801.01315)는 같은 instance 안의 pixel link로 가까운
   텍스트를 묶는다. [PAN](https://arxiv.org/abs/1908.05900)은 학습된 similarity vector로
   text pixel을 instance seed에 모은다. 둘 다 bbox 포함관계보다 pixel affinity가 강한
   근거임을 뒷받침한다.
5. [PSENet](https://arxiv.org/abs/1806.02559)은 작은 kernel에서 완전한 text mask로
   단계적으로 확장해 인접 instance를 분리한다. 처음부터 큰 union을 만든 뒤 자르는 현재의
   실패 경로보다 core-first expansion이 안전하다.
6. [Repulsive Text Border](https://openaccess.thecvf.com/content_CVPRW_2020/papers/w34/Liu_An_Accurate_Segmentation-Based_Scene_Text_Detector_With_Context_Attention_and_CVPRW_2020_paper.pdf)는
   affinity만이 아니라 다른 instance 사이의 음의 border link도 필요하다는 근거다.
7. [Shape-Aware Embedding](https://openaccess.thecvf.com/content_CVPR_2019/html/Tian_Learning_Shape-Aware_Embedding_for_Scene_Text_Detection_CVPR_2019_paper.html)은
   같은 instance pixel을 가깝게, 다른 instance pixel을 멀게 하는 embedding과 작은 간격을
   함께 다룬다. Koharu 후처리에서는 bubble/panel ownership을 이 음의 증거로 쓸 수 있다.
8. [DBNet](https://arxiv.org/abs/1911.08947)은 고정 binarization threshold 대신 적응형
   threshold를 학습한다. 다만 현재 오류는 threshold 하나가 아니라 인스턴스/후리가나
   계층 문제이므로 즉시 모델 교체보다 보조 후보로 둔다.
9. [Deep CNN-based Speech Balloon Detection](https://arxiv.org/abs/1902.08137)과
   [Manga109](https://arxiv.org/abs/2005.04425)은 텍스트, 말풍선, 패널의 계층 관계를
   별도 객체로 유지할 근거다.
10. [Hierarchical Text Spotter](https://openaccess.thecvf.com/content/WACV2024/papers/Long_Hierarchical_Text_Spotter_for_Joint_Text_Spotting_and_Layout_Analysis_WACV_2024_paper.pdf)와
    [Hi-SAM](https://github.com/ymy-k/Hi-SAM)은 word/line/paragraph 수준을 한 hierarchy로
    보존한다. OCR region ID만 남기는 대신 내부 열/글리프 core를 진단 artifact로 남겨야 한다.

## 다음 미사용 화에 채택할 조합

### R1 · projection + component-affinity 이중 글자 크기 추정

- 현재 승리한 85% dominant projection core는 유지한다.
- 같은 crop에서 이진 connected component를 만들고, 방향축 간격·직교축 겹침·component
  높이/폭 scale 유사도를 edge로 하는 그래프를 만든다.
- 본문 scale의 최대 일관 군집과 작은 ruby/satellite 군집을 분리한다. ruby를 단순 삭제하지
  않고 `secondaryScale`로 기록한다.
- projection face와 graph face가 허용 범위에서 합의할 때 confidence를 올리고, 불일치하면
  어느 한쪽 값을 억지로 쓰지 않고 abstain한다.
- 목적은 적용률 숫자만 높이는 것이 아니라 P013 같은 ruby 섞임과 P006 같은 crop satellite를
  동시에 막는 것이다.

### R2 · 양·음 링크를 함께 쓰는 bbox instance graph

- 양의 link: 같은 bubble owner, 매우 높은 mask-pixel overlap, lossless core continuity.
- 음의 link: 다른 bubble/panel owner, 낮은 mask overlap, 두 core 사이의 빈/repulsive valley.
- 작은 core를 먼저 만든 뒤 mask를 확장한다. 다른 owner를 가로질러 transitive union하지 않는다.
- confidence만으로 삭제하지 않으며, broad sparse 거부도 mask density와 container support를
  동시에 만족할 때만 적용한다.

### R3 · 평가 항목 분리

- `missed`, `over-merged`, `over-split`, `dialogue/effect overlap`, `clipped tail`, `ruby mixed`,
  `font-size disagreement`, `intentional-small regression`을 별도 집계한다.
- 모든 변경 bbox를 개별 확대하고, 원래부터 정상인 bbox도 전체 page overlay로 덮는다.

## 보류·기각

- Koharu를 곧바로 DBNet/CRAFT/PSENet으로 교체: 새 모델 자산·학습 domain·릴리스 계약이
  필요하고 현재 실험에서 원인을 분리하지 못한다. component graph가 실패한 뒤 별도 가설로만
  검토한다.
- morphology로 작은 component를 전부 삭제: 실제 작은 대사와 구두점을 잃는다. 후리가나
  논문도 만화 실패가 더 크므로 별도 scale 증거 없이 적용하지 않는다.
- OCR confidence 기반 union/delete: 캠페인 001의 실제 반례와 맞지 않는다.
- page-wide median font size: 강조/속삭임 계층을 지우므로 계속 금지한다.
- VLM px 직접 회귀: 좌표·결정성·검증 비용에 비해 이번 geometry 병목과 맞지 않는다.

## 다음 화의 사전 합격 조건

- 이전에 한 번이라도 쓴 화가 아니어야 한다.
- HayaiOCR `full`, GPU CUDA/cu126, `hayai-regions` 고정.
- 첫 실험은 R1+R2의 연구 조합으로 시작하되, R1과 R2의 기여를 artifact에서 따로 계산한다.
- 작은 글자 sentinel을 새 화에서 새로 잠그고, 이 화에서 보인 수치로 계수를 다시 맞추지 않는다.
- 최대 다섯 실험 후에는 그 화를 다시 쓰지 않는다.
