# C23 공개 런타임 배포

## 배포 계약

- 자산 프리릴리스: `font-chapter-c23-20260909-r2`.
- [GitHub Release](https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/font-chapter-c23-20260909-r2)
- 앱의 권위: `src/main/pipeline/fontChapterReleaseManifest.json`의 플랫폼별 URL 구성, byte size, SHA-256과 Python inventory binding.
- Windows x64: `font-chapter-c23-win32-x64.zip`, 492,932,823 bytes,
  SHA-256 `302b6ab214ea4cadac864eaeb42cbb30c44ca30377434b2327fd0fa7fd9be360`.
- Apple Silicon: `font-chapter-c23-darwin-arm64.zip`, 495,965,035 bytes,
  SHA-256 `9ec3074edda5410f3311cb470c0ee819da16255840ca8966feb282c59fa64eba`.
- ZIP 루트에 모델·참조 글꼴·라이선스·`python-packages`·`python-inventory.json`·`ownership.json`이 있다. 추가 상위 폴더는 없다.
- 설치 위치는 데이터 루트 아래 `models/fc23-r2/win32-x64` 또는 `models/fc23-r2/darwin-arm64`다.
- 공통 학습 모델과 참조 글꼴은 승인된 C23/C18 팩과 byte-identical이다. 재훈련·모델 교체·분류 임계값 변경이 없다.
- `font-chapter-c18/v1`과 `font-chapter-c18/c23-v1` 원본 소유 팩은 읽기만 하며 덮어쓰지 않았다.

## 생산과 검증

`scripts/package-font-chapter-release.py`는 기존 소유 팩을 원래 ownership으로 먼저 검증한다.
앱 manifest와 학습 파일 inventory가 같은지 확인하고 현재 패키지에 포함할 알고리즘 해시를 검증한다.
최근 단일 글자 보정 수정에 따른 알고리즘 binding 차이는 새 ownership에 반영한다.
기존 팩의 ownership을 재봉인하지 않는다.

Python 의존성은 NumPy 1.26.4, OpenCV headless 4.11.0.86, SciPy 1.13.1,
fonttools 4.51.0, ONNX Runtime 1.21.0, coloredlogs 15.0.1,
flatbuffers 25.2.10, humanfriendly 10.0이다. macOS는 CPython 3.12 arm64/universal2 wheel을 사용한다.
Torch와 Pillow는 앱의 기존 Hayai 런타임을 사용한다. 테스트 자료·bytecode·명령줄 launcher·share 자료는 배포하지 않는다.
글꼴 라이선스는 참조 source manifest의 SHA와 대조해 함께 포함한다.

게시 자산 6개는 ZIP 두 개와 `release-manifest.json`, `archive-inventories.json`,
`producer-binding.json`, `mac-wheels.json`이다. 모든 자산을 새 빈 폴더에 다시 내려받아
서버 목록/크기와 게시 전 SHA-256을 대조했다. Windows 2,111파일, macOS 2,020파일의
ZIP 내부 inventory도 검증했다. 실제 앱의 압축 해제 구현으로 재다운로드한 ZIP을 풀고
내부 모델·의존성 전체를 다시 검증했다.

최초 `font-chapter-c23-20260909-r1`은 SciPy 테스트 자료의 높은 압축률 때문에 실제 앱의
압축 안전 검사에서 거부됐다. r1 자산은 덮어쓰지 않았으며 앱은 r2만 소비한다.
압축 안전 한도를 높이지 않았다.

## 앱 경로

`fontChapterC18.prepare`가 대상 원문을 준비한 뒤 `prepareFontChapterRuntime`을 호출한다.
첫 사용 시 기존 `ensureRemoteFile` gateway로 다운로드하고, 공유 FIFO gate로 동시 설치를 직렬화한다.
대기 중 취소는 실행 중인 다른 요청을 취소하지 않는다. 원본 ZIP과 내부 inventory를 검증하고
같은 볼륨의 임시 폴더에서 설치를 완성한 뒤 기존 rollback 가능한 디렉터리 게시 구현을 사용한다.
손상된 설치는 새로 검증한 팩으로 교체한다. 실패 시 기존 디렉터리를 먼저 삭제하지 않는다.
완료 후 chapter worker가 같은 assets 경로와 플랫폼 manifest를 받아 알고리즘·모델을 검증하고 실행한다.

`scripts/smoke-font-chapter-runtime.cjs`는 빌드된 실제 앱 모듈 또는 설치본의 ASAR 모듈을 받아
빈 데이터 루트에 원격 설치한다. `scripts/smoke-font-chapter-native.py`가 네이티브 import,
동결 전처리와 두 ONNX 모델을 실행한다. 동결 수치 기준은
`tests/fixtures/font-chapter-native-reference.json`이다. 비교 허용 오차는 rtol 1e-4, atol 1e-5이며
모델 선택이나 결과를 보정하지 않는다. Windows CPU 기준과 macOS arm64 출력의 수치 parity를 확인한다.
이 검사는 새 만화 품질 평가나 OCR·번역·지움 전체 평가로 계산하지 않는다.

## v2.6.0 설치 파일 검증

로컬 NSIS 설치 파일에서 실제 `app-64.zip`을 추출해 330개 배포 파일을 빌드 산출물과
SHA-256으로 비교했다. ASAR의 3,885개 항목은 배포 허용 목록을 통과했다.
추출한 실제 앱 실행 파일의 빈 데이터 루트 시작 검사를 통과했다.
기존 v2.5.1 사용자 설치를 보존하기 위해 로컬 설치·제거를 강행하지 않았으며,
전체 설치·업그레이드·제거 검사는 정식 Windows Release workflow의 격리된 runner가 담당한다.

설치 파일에서 추출한 실제 ASAR 모듈로 새 데이터 루트에 공개 r2 팩을 내려받고
네이티브 import·두 ONNX 모델의 수치 parity를 통과했다. 이어 실제 chapter port에서
승인된 confirmation-014의 9페이지·66개 글꼴 선택을 재실행해 승인된 C23 style 객체와
모두 일치함을 확인했다. 입력 OCR 위치와 번역문은 승인 fixture를 사용했으며,
이 검증은 새로운 OCR·번역·인페인팅 품질 평가가 아니다.

로컬 근거는 `.tmp/release260-installer-payload-receipt.json`,
`.tmp/release260-installer-font/font-runtime-smoke.json`,
`.tmp/release260-installer-font.log`이다. macOS arm64 공개 팩의 네이티브 검사는
`Check` workflow의 `Verify published font runtime on Apple Silicon` 단계가 실행한다.

## 롤백

문제가 있으면 앱을 v2.5.1로 되돌리거나 글꼴 자동 맞춤을 끈다. 공개 태그·자산을 같은 이름으로
교체하지 않는다. 사용자 글꼴, library, 원본, 출력 및 승인된 로컬 생산 팩은 보존한다.
