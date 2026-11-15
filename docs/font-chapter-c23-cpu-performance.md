# C23 CPU 실행 최적화

2026-09-09. C23의 OCR 입력, F32 가중치, 배치 크기 8, 최대 생성 96토큰,
256 patch, 글자 검증·복구·군집·폰트 선택 알고리즘을 보존한다. 모델 자산과
공개 release/cache version은 바꾸지 않는다. 앱 어댑터의 소스 binding만 갱신한다.

## 실행 변경

- CPU 폰트 분석은 화 하나에 한정된 Hayai 프로세스 풀을 사용한다. 독립된 페이지와
  글자 atlas를 작업 대기열에서 분배하며, 각 페이지 내부의 crop 순서와 minibatch는
  그대로다. 줄 검증, 글자 검증, C23 복구에서 같은 모델 인스턴스를 재사용한다.
- 모든 OCR 결과가 나온 후 기존 알고리즘을 기존 순서대로 실행한다. 풀은 후속 폰트
  모델 추론 전에 닫는다. GPU OCR은 기존 실행 경로를 유지한다.
- Python 자식은 Hayai 전용 의존 경로를 사용한다. 폰트 shape 분석의 별도 dependency
  directory를 OCR 모델에 섞지 않는다. 자식 실패는 형제 프로세스를 종료하고 전파한다.
  앱 취소는 기존 worker process-tree 종료 계약을 사용한다.
- Windows Hayai 자동 CPU 배치는 CPU 수, 여유 RAM, 작업량에 따라 최대 8워커를 사용한다.
  최소 2개 logical CPU와 전체의 25%를 계산상 예약하며, 기존 여유 RAM 기준인 20%
  (최소 2 GiB)을 제외한 뒤 워커당 3 GiB를 예산으로 잡는다. 기본 워커당 2스레드는
  보존한다. 따라서 7950X에서는 큰 작업에 최대 8워커 × 2스레드를 사용한다.
- 짧은 일반 OCR 작업은 추가 모델 import 비용을 피하도록 워커 4개까지 먼저 사용하고,
  16페이지를 넘으면 4페이지당 워커 하나를 추가한다. CPU/RAM 상한이 더 낮으면 그
  상한을 따른다. 모델을 재사용하는 고밀도 폰트 atlas는 이 최소 작업량 조건을 낮춘다.
- Windows CPU OCR은 Below Normal 우선순위를 사용해 foreground 작업을 우선한다.
  이는 CPU 사용률을 강제 제한하는 quota가 아니다. 기존 명시적 worker/thread override와
  macOS/Paddle worker 정책은 보존한다.

## 실제 입력 확인

사용자가 제공한 로그의 15페이지/77영역, Ryzen 9 7950X, CPU Hayai 런타임을 사용했다.
설치된 런타임/cache를 재사용하고 library·원본·이전 결과를 보존했다.
재실행 출력은 새 `.tmp/cpu-ocr-optimization/`에 썼다.

| 폰트 분석 worker                |      시간 |
| ------------------------------- | --------: |
| 기존 사용자 로그                | 459.785초 |
| CPU pool 재실행                 | 196.137초 |
| 실제 production launcher 재실행 | 198.049초 |

약 57.3% 단축, 2.34배 처리 속도다. 모델/자산 다운로드와 후속 페이지 서식 적용은
이 worker 시간에 포함하지 않는다. 재실행은 설치된 동일 모델 cache를 offline으로
사용했으므로 동일 조건의 반복 벤치마크나 모든 화에 대한 속도 보장은 아니다.
마지막 production launcher 실행은 앱의 환경 생성, 자동 워커 수 결정과 JSON worker
수명을 그대로 사용했다. 런타임 준비까지 포함하면 212.427초였고, 8개 자식의
Below Normal 우선순위를 실제 프로세스에서 확인했다. 이 실행도 아래 전체 결과가 같다.

- 원문 OCR 결과 25개 JSON: 전체 payload 동일.
- 줄/글자 등 중간 PNG 1,544개: 파일 bytes 동일.
- 최종 선택 77개: 순서, 폰트, 굵기, italic, group, 유형, 상태 모두 동일.
- 상위 receipt SHA는 실행 시간/경로가 포함된 선행 진단 파일을 바인딩하므로 달라진다.
  receipt 해시까지 동일하다고 주장하지 않는다. 모델·입력·선택의 권위는 변경하지 않았다.
- 복구도 기존과 같은 15개 strict glyph, 1개 영역을 추가했다.

일반 OCR은 동일 15페이지의 고정된 77개 원문 영역을 실제 production batch gateway에
넣어 비교했다. 최초 사용자 실행의 detector 출력 전체를 재사용한 것은 아니다.
4워커×2스레드 55.424초, 4×4 53.332초, 8×2 56.947초였고 모든 OCR payload가 같았다.
작은 작업에 8개 모델을 무조건 띄우거나 스레드 변경만으로 속도가 개선된다고
결론내리지 않고, 작은 작업의 시작 비용을 제한하는 작업량 조건을 추가했다.
같은 15페이지를 4회 처리하는 60페이지 처리량 비교에서는 4×2가 106.851초,
8×2가 101.367초였으며 60개 OCR payload가 모두 같았다. 이는 반복 입력의 처리량
비교이며 독립된 60페이지 품질 평가나 큰 폭의 일반 OCR 가속 근거로 쓰지 않는다.

## 검증과 재현

Python transport 테스트는 실제 자식 프로세스로 동시 실행, 모델 재사용, 입력/출력
결합, 빈 작업, 실패 시 형제 종료를 검사한다. 기존 C23 복구의 글자 보존 테스트도 실행한다.
TypeScript 테스트는 CPU/RAM/작업량별 워커 수, priority, 기존 worker 취소와 실패 전파,
manifest binding 및 chapter 선택의 실제 적용 경계를 검사한다.

- `npm run check`: 26개 gate 통과. 6,279개 테스트 통과, 기존 pending 10개.
  typecheck, lint, coverage, build, page artwork parity, image protocol 포함.
- Python pool transport 3개 및 기존 C23 evidence 3개 테스트 통과.
- 기존 작업 폴더의 untracked `cache/`가 formatter 소유권 검사에 걸려, 사용자 cache를
  보존한 채 동일 변경 파일을 복사한 격리 worktree에서 전체 검사를 실행했다.
- 근거: `.tmp/cpu-ocr-optimization/production-font-receipt.json`,
  `production-parity.json`, `normal-isolated-comparison.json`,
  `normal-volume-comparison.json`, `check-isolated.log`.

`fontChapterC18Manifest.json`의 새 어댑터 해시는 현재 앱 manifest의 권위다.
원격 모델 archive에 보존된 과거 `ownership.json`의 runtimeSources를 새 앱 코드에
강제로 적용하지 않도록 production smoke에도 downloader가 반환한 manifest를 전달한다.
원격 모델 bytes 검증은 그대로 유지한다.

롤백은 이 실행 어댑터/정책 변경과 manifest binding을 함께 되돌린다. 원격 release,
모델, 사용자 library, 원본, 기존 출력은 변경하지 않는다.

## 2026-10-07 기본 앱 경로 재검증

실험 워크트리의 후보를 기본 저장소의 `createFontChapterC18Port`에 통합했다.
보관함 스냅샷과 원본 이미지를 입력으로 정상 AppPaths, managed installer,
실제 JSON worker, Hayai runtime, C23 resolver를 실행했다. 번역/인페인팅 전체를
다시 실행한 시험은 아니며, 기존 library·원본·출력물에는 쓰지 않았다.

### 선택적 글자 검증 가속

> 2026-11-16: 아래 기존 upstream revision의 원격 접근이 불가능해져 동일 바이트를
> 새 자산 전용 release로 복구했다. 현재 다운로드 URL·캐시 버전·원격 검증과 분석
> 전환 안내는 [#179 복구 기록](font-glyph-download-recovery-20261116.md)을 따른다.

줄 OCR은 Hayai를 유지한다. 정렬이 끝난 한 글자 atlas에서만
PP-OCRv6 manga v0.2의 결과가 예상 문자와 NFKC 기준으로 정확히 같고,
confidence >= 0.995, 잉크 bbox의 폭/높이가 0.8~1.3인 경우 빠른 결과를 쓴다.
빈 그림, 좁은 글자, 다문자 조각, 불일치, 저신뢰도는 기존 Hayai로 처리한다.
OCR payload는 기존 `dialogue_hint`로 만들고 원래 region 순서를 복구한다.
모델 설치/추론 실패도 Hayai로 돌아가며 취소는 정상 전파한다.

- upstream: <https://huggingface.co/Kellenok/PP-OCRv6_manga> (Apache-2.0)
- revision: `ba1d479e8a61a20e8318c9758c73fbbbd290b98d`
- managed directory: `models/font-glyph-ppocr-v02-r1`
- `manga_rec_v0.2.onnx`: 21,167,540 bytes, SHA-256 `de12c84c63e62c80339e882e675983d886670dcb6f0147e1ed041afd6fa81888`
- `ppocrv6_dict.txt`: 74,947 bytes, SHA-256 `b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d`
- 설치 계약: 위 두 개별 파일을 기존 `ensureRemoteFile`로 받고 byte/hash를 확인한다.
  worker에서도 다시 검증한다. GitHub release/기존 자산 덮어쓰기는 없다.
- 실행: 기존 검증된 font native dependencies (ORT 1.21.0, OpenCV 4.11.0,
  NumPy 1.26.4)의 CPU ORT 한 스레드. Hayai 자식 의존 경로는 그대로다.
- rollback: `fontChapterC18.ts`에서 `glyphVerificationAssets` 전달을 빼면
  기존 Hayai 전체 검증 경로로 돌아간다. model cache나 library 삭제는 필요 없다.

CPU 정상 앱 worker의 3개 만화 각 10페이지 비교:

| 작품 식별자 | 기존 worker | 가속 worker |  단축 |
| ----------- | ----------: | ----------: | ----: |
| f4ff3df3    |   191.831초 |   139.914초 | 27.1% |
| 3998fffc    |   233.711초 |   173.433초 | 25.8% |
| 901f740a    |   175.488초 |   120.844초 | 31.1% |

최종 188개 resolver style 결과가 모두 같다. 첫 CPU 기준 실행의 런타임
신규 설치 시간과 가속 모델 다운로드는 위 worker 시간에 넣지 않았다.
로컬 각 1회 실행이므로 반복 측정의 신뢰구간/모든 기기 속도 보장은 아니다.
GPU 기본 설정의 결과는 후속 기록에서 별도로 구분한다.

### 자동 글자 크기와 작은 대사 회귀

기존 저장 페이지의 legacy auto-fit에도 검증된 문단 배치를 적용한다.
말풍선 슬롯의 fit 여부는 글자 크기에 대해 단조적이지 않으므로, 자동 생성
말풍선에서는 위에서부터 탐색해 실제로 가능한 큰 크기를 놓치지 않는다.
90페이지 보관함 비교에서 좁고 긴 풍선의 대사가 기존 11px에서 26px로
복구됐다. 수동 크기와 수동 줄바꿈/세로 방향은 유지한다.

단어를 온전히 쓰려고 글자를 과하게 줄이지 않도록 추가 문단 보정의 축소를
제한했다(단어 분절은 최대 8%, 문장부호만의 줄은 최대 15%, 짧은 고립 행은
최대 4%). 더 작게 해야만 실제로 들어가는 긴 대사의 물리적 맞춤과는 별개다.
더 작게 만들면서 문장부호만의 행을 새로 만드는 후보는 채택하지 않는다.

`dialogueFontSizeMatching.ts`는 같은 페이지의 신뢰 가능한 일반 대사에
대해 실제 한글 face height와 같은 굵기의 가까운 source-size peer를 비교한다.
4개 미만, 수동 크기, 세로/곡선, 강조 크기는 제외한다. 중앙값 조정은
2px/15% 이내이며 새 overflow/단어 경계 손상/고립 행은 거부한다.
타깃 크기는 렌더링에서만 계산하고 library의 원문 계측이나 수동 intent를
다시 쓰지 않는다. 편집기, PNG exporter, 크기 표시와 +/-가 같은 계산을 쓴다.
자동 세로 전환은 독립 사례가 충분하지 않아 승격하지 않았다.

검증 자료는 기본 저장소 `.tmp/font-production-20261007/`에 보존한다.
90페이지 측정 스크립트는 UTF-8 문서와 로드 완료된 실제 앱 폰트로 측정한다.
이전 중간 측정의 인코딩이 빠진 probe 수치와 최종 수치를 섞지 않는다.
넓은/좁은 실제 `PageArtwork` 캡처는 `C:/tmp/font-production-*-20261007-ready.png`.
새 Python 검증과 실제 child-process 혼합 결과 순서 테스트, 작은 말풍선
회귀와 manual intent 보존 테스트가 추가됐다. 수동 시각 검증은 human gold
정답률로 해석하지 않으며 기존 v11/evaluation 및 1,347/training 권위는 그대로다.

### GPU 기본 설정 결과와 승격 범위

저장된 실제 설정은 Hayai / CUDA cu126 / GPU였고, GPU는 RTX 4090 24 GiB다.
GPU에 PP 글자 verifier를 붙인 후보는 worker 80.078→74.461,
96.759→108.356, 68.905→70.078초로 일관되게 우세하지 않아 제외했다.
PP verifier는 CPU 실행에만 사용한다.

GPU는 기존 Hayai F32 모델의 batch를 8→32로 늘렸다. NVIDIA CUDA이며
시작 시 전체 VRAM >=16 GiB, 여유 >=8 GiB일 때만 적용한다. 저용량 GPU,
ROCm과 CPU는 8을 유지한다. 실행 중 메모리 부족은 기존 Hayai의 재귀 batch
분할을 사용한다. 모델/processor revision, 토큰 한도, patch 한도는 그대로다.
`hayai-pool.py::resolve_batch_size`를 8로 고정하면 이 변경만 rollback할 수 있다.

3개 화에서 글자 atlas 384개와 줄 81개, 총 465개 결과를 batch 8/16/32/8
순서로 비교했다. 16과 32의 모든 OCR item payload가 8과 같았다. 재측정된
마지막 batch 8 대비 batch 32의 인식 시간은 글자에서 30.0~51.0%, 줄에서
44.6~51.0% 짧았다. 모델 로딩을 제외한 구간 측정이다.

| 작품     | 기존 GPU worker | batch 32 worker | 준비 포함 기존→후보 |
| -------- | --------------: | --------------: | ------------------: |
| f4ff3df3 |        80.078초 |        62.292초 |     96.918→75.097초 |
| 3998fffc |        96.759초 |        75.033초 |    111.065→86.383초 |
| 901f740a |        68.905초 |        61.942초 |     83.255→73.675초 |

GPU 역시 최종 188개 선택/서식 payload가 모두 같았다. 전체 시간은 각 1회
로컬 실행이며 일부 다른 검증 프로세스도 실행 중이었다. 위 미세 구간의
반복 결과와 구분하며 전체 시간의 정확한 개선율을 보편적 보장으로 쓰지 않는다.

최종 9작품 90페이지/682영역에서 크기 145개(확대 84, 축소 61)가 바뀌고,
새 overflow는 0개였다. 한 글자/문장부호의 고립 행은 126→103, 어절 중간
분절은 149→175였다. 큰 글자를 우선한 결과 일부 한국어 어절 분절이 늘어난
것이며, 모든 줄바꿈 지표가 개선됐다고 주장하지 않는다. 사용자가 지정한
수동 크기와 자동 세로 전환의 기존 설정은 바꾸지 않는다. 예제 그림과 실제
wide/narrow 화면을 함께 검토한다. library chapter 9개와 원본 90개의 SHA-256
99개가 초기 selection과 모두 같음을 별도 `source-preservation.json`에 기록했다.
