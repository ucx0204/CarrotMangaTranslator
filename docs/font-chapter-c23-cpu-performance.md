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
