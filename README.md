<p align="center">
  <img src="docs/images/00-carrot-logo.png" alt="당근망가번역기 로고" width="180">
</p>

# 당근망가번역기

<p align="center">
  만화 가져오기부터 OCR, AI 번역, 편집, 원문 지우기, PNG 출력까지 한 번에 처리하는 Windows 데스크톱 앱
</p>

<p align="center">
  <strong>한국어</strong> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a>
</p>

당근망가번역기는 이미지에서 대사와 효과음을 찾고, AI로 번역 블록을 만든 뒤, 사람이 문장과 배치를 다듬어 완성 PNG로 내보낼 수 있는 만화 작업 도구입니다. 기본 번역은 일본어 → 한국어이며, 다른 원문·번역 언어도 선택할 수 있습니다.

- 최신 Windows 설치 파일: [GitHub Releases](https://github.com/ucx0204/CarrotMangaTranslator/releases)
- 현재 버전 안내: [v1.2.1 패치노트](docs/release-notes/v1.2.1.md)
- 코드 구조와 기여 규칙: [docs/architecture.md](docs/architecture.md)

## 한눈에 보기

- 한 장의 이미지, 이미지 폴더, ZIP/CBZ를 작품과 화 단위로 보관합니다.
- Paddle OCR과 `Gemma 4` 로컬 모델, `OpenAI Codex`, OpenAI 호환 `API`를 조합해 번역합니다.
- 앱 화면은 한국어, 일본어, 영어, 중국어 간체, 중국어 번체를 지원합니다.
- 만화 원문·번역 언어는 48개 프리셋과 직접 입력한 BCP 47 언어 코드를 지원합니다.
- 번역 블록의 문장, 위치, 방향, 폰트, 색, 외곽선과 간격을 직접 편집합니다.
- 용어집, 캐릭터 말투, 번역 규칙과 스토리 기억을 AI 번역에 반영합니다.
- AOT, LaMa, Flux로 원문을 지우고 붓 도구로 보정한 뒤 PNG로 출력합니다.
- TXT와 CSV/TSV로 외부 검수하고, `*.mgtshare`로 편집 가능한 작품 데이터를 공유합니다.

## 설치 전 확인

- 지원 운영체제: Windows 10/11 x64
- 필수 여유 공간: 앱 본체 외에도 선택한 Gemma, OCR, 인페인팅 모델에 따라 수 GB 이상 필요할 수 있습니다.
- 인터넷: 설치와 첫 모델 다운로드, Codex/API 사용에 필요합니다. 로컬 모델은 준비가 끝난 뒤 오프라인 작업이 가능합니다.
- GPU가 없어도 일부 CPU 경로를 쓸 수 있지만 OCR, 로컬 번역, Flux 인페인팅은 크게 느릴 수 있습니다.

설치 파일은 비교적 작게 유지됩니다. 큰 모델과 런타임은 해당 기능을 처음 실행할 때 지정한 데이터 폴더로 내려받고, 다음부터 캐시를 재사용합니다.

## 빠른 시작

1. [Releases](https://github.com/ucx0204/CarrotMangaTranslator/releases)에서 `CarrotMangaTranslator-Setup-v1.2.1.exe` 같은 최신 설치 파일을 받아 설치합니다.
2. `설정 → 일반`에서 앱 화면 언어를 확인합니다. 지원되는 Windows 언어는 처음 실행할 때 자동 선택되며, 그 밖의 환경은 한국어를 사용합니다.
3. `설정 → 번역 엔진`에서 원문 언어, 번역 언어와 엔진을 고릅니다.
   - 내 PC에서 처리하려면 `Gemma 4`
   - Codex CLI 로그인 정보를 쓰려면 `OpenAI Codex`
   - 이미지 입력이 되는 외부 서버를 쓰려면 `API`
4. `설정 → 하드웨어 · OCR`에서 OCR 품질과 장치를 고른 뒤, `설치 / 확인`에서 `OCR/모델 확인`을 실행합니다. 처음이라면 필요한 파일을 자동으로 준비합니다.
5. 메인 화면의 `번역`에서 이미지, 폴더 또는 ZIP/CBZ를 고르고 작품과 화 이름을 정합니다.
6. 화 카드의 `번역`을 눌러 페이지 범위를 고릅니다. 처음에는 `미번역만 + 자동 생성`이 무난하고, 문맥 일관성을 더 원하면 `2차 번역`을 켭니다.
7. 생성된 블록을 검수합니다. 필요하면 인페인팅에서 원문을 지우고 보정한 뒤 현재 페이지 또는 전체 화를 PNG로 출력합니다.

> 앱 화면 언어와 만화 번역 언어는 서로 독립적입니다. 화면을 영어로 바꿔도 일본어 → 한국어 번역 설정은 그대로 유지됩니다.

## 화면 미리보기

| 작업 화면과 원본                                                                                            | 번역 범위와 2차 번역                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| <img src="docs/images/example-workspace.png" alt="작품과 페이지를 연 메인 작업 화면" width="100%">          | <img src="docs/images/example-translation-options.png" alt="페이지 범위와 번역 옵션 선택 화면" width="100%"> |
| **번역 진행과 생성된 블록**                                                                                 | **인페인팅 자동 단계**                                                                                       |
| <img src="docs/images/example-translation-progress.png" alt="AI 번역 진행과 생성된 번역 블록" width="100%"> | <img src="docs/images/example-inpainting.png" alt="원문 지우기를 위한 인페인팅 자동 단계" width="100%">      |

## 기능 안내

### 가져오기와 보관함

- 지원 이미지: PNG, JPG, JPEG, WEBP
- 지원 압축파일: ZIP, CBZ
- `이미지 열기`는 한 장, `폴더 열기`와 `압축파일 열기`는 여러 장을 자연 정렬해 한 화로 가져옵니다.
- `작품 일괄 번역`은 폴더 안의 하위 폴더와 ZIP/CBZ를 여러 화 후보로 보여주고, 선택한 화만 한 번에 추가합니다.
- 작품과 화 검색·정렬, 이름 변경·삭제, 화와 페이지의 드래그 순서 변경, 개별 페이지 삭제를 지원합니다.
- WEBP는 보관함에 넣을 때 PNG로 정규화합니다. 단일 입력 파일은 256MB, 디코딩한 이미지는 120MP를 넘지 않아야 합니다.

### 번역 범위와 파이프라인

- 작품 안의 화와 페이지를 썸네일로 직접 선택하거나 `전체 선택`, `미번역만`, `전체 해제`를 사용합니다.
- `2차 번역`은 1차 결과 뒤에 용어, 캐릭터, 문맥을 다시 분석하고 선택 범위를 재번역합니다. 품질은 좋아질 수 있지만 시간과 API 사용량이 늘어납니다.
- 자동 분석 범위는 `비어있는 화만`, `처음부터 다시`, `현재 화만` 중에서 고릅니다.
- `자동 생성`은 OCR과 AI 결과로 블록을 새로 만듭니다.
- `기존 블록 유지`는 사람이 손본 영역과 서식을 보존하고 각 영역의 OCR·번역문만 다시 채웁니다. 블록이 없는 페이지는 자동 생성으로 처리됩니다.
- 페이지 재번역, 작업 취소, 페이지 일부를 드래그해 다시 분석하는 `영역 번역`을 지원합니다.
- Paddle OCR 결과와 페이지 이미지를 함께 사용합니다. OCR 캐시는 원문 언어별로 분리되며, 일본어 페이지에 일본어 근거가 거의 없으면 불필요한 AI 호출을 줄입니다.

### 용어, 캐릭터와 작품 기억

- `AI 자동 분석`으로 용어집, 캐릭터, 번역 규칙과 스토리 메모리를 만들 수 있습니다.
- 용어집에는 원문, 번역, 분류, 별칭과 메모를 저장하고 항목별 사용 여부를 정합니다.
- 캐릭터에는 원문·번역 이름, 존댓말/반말 같은 말투와 직접 작성한 말투 지침을 저장합니다.
- 번역 규칙에는 호칭, 효과음, 문체와 작품별 주의사항을 적습니다.
- 스토리 메모리는 이전 페이지의 사건과 맥락을 이후 번역과 2차 번역에서 참고합니다.
- 화면 하단의 토큰 예산은 기억이 차지하는 컨텍스트와 번역 응답 여유를 보여줍니다.

### 블록 편집과 서식

- 선택 도구로 블록을 이동·크기 조절하고, 블록 도구로 새 영역을 드래그해 추가하며, 손바닥 도구로 확대 화면을 이동합니다.
- `Ctrl+클릭`으로 여러 블록을 선택할 수 있습니다.
- 번역문과 OCR 원문, 가로/세로쓰기, 정렬, 기울기, 투명도, 자동 맞춤, 글자 크기, 줄 간격, 자간, 장평, 굵게, 기울임, 글자색, 외곽선과 두께를 편집합니다.
- 번역문 안에서 `**굵게**`, `*기울임*`, `***굵게+기울임***` 마크업을 부분적으로 적용할 수 있습니다.
- 새 블록 기본 서식을 설정하고, 선택 블록의 필요한 속성만 여러 블록·현재 페이지·현재 화에 일괄 적용합니다.
- 편집기는 오른쪽 패널, 앱 안의 이동 가능한 플로팅 패널, 별도 Windows 창 중에서 사용할 수 있습니다.
- 현재 화의 편집은 최대 100단계 실행 취소·다시 실행을 지원합니다.
- 확대·축소·원래 크기, 원본 미리보기, 블록·배경 표시 전환을 지원합니다.
- `Ctrl+K` 명령 팔레트와 `?` 단축키 도움말을 제공하며, 설정에서 각 단축키를 바꿀 수 있습니다.

### 폰트

앱에는 기존 한국어 폰트와 함께 영어·일본어·중국어 간체·중국어 번체용 무료 폰트를 각 6개씩 포함합니다. 폰트 목록은 `기본`을 맨 위에 두고, 현재 앱 언어의 폰트 그룹을 먼저 보여줍니다. 나머지는 한국어 → 영어 → 일본어 → 간체 → 번체 순서를 유지하며 현재 언어 그룹만 앞으로 이동합니다. 사용자가 등록한 폰트는 마지막에 표시됩니다.

| 그룹        | 포함 폰트                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------- |
| 영어        | Comic Neue, Kalam, Bangers, Luckiest Guy, Permanent Marker, Freckle Face                       |
| 일본어      | Yusei Magic, Mochiy Pop One, Hachi Maru Pop, Dela Gothic One, Reggae One, DotGothic16          |
| 중국어 간체 | ZCOOL KuaiLe, ZCOOL QingKe HuangYou, ZCOOL XiaoWei, Ma Shan Zheng, Long Cang, Liu Jian Mao Cao |
| 중국어 번체 | Huninn, Iansui, LXGW WenKai TC, LXGW Marker Gothic, ChenYuluoyan, Cubic 11                     |

`+ TTF/OTF 폰트 등록`으로 다른 폰트를 추가하거나 삭제할 수도 있습니다. 사용자 폰트는 데이터 폴더의 `fonts/`에 복사되며 화면 미리보기와 PNG 출력에 함께 사용됩니다. 번들 폰트의 출처와 라이선스는 [third_party/fonts](third_party/fonts/README.md)에 있습니다.

### 텍스트 모아보기와 외부 검수

- 현재 페이지 또는 전체 화에서 `번역문+OCR`, `번역문만`, `OCR만`을 모아 봅니다.
- 검색 결과를 순서대로 이동하고, 텍스트를 복사하거나 TXT로 저장합니다.
- `번역문만` TXT를 다시 불러오면 블록 위치와 OCR 원문은 유지하고 줄 순서에 맞는 번역문만 갱신합니다.
- CSV/TSV 검수표는 `block_id`, OCR 원문, 번역문, 검수 상태와 메모를 내보냅니다.
- 검수표 가져오기는 같은 `block_id`의 번역문·상태·메모만 적용하고, 누락·중복·OCR 불일치를 경고합니다.
- 페이지 안 텍스트는 원문 언어의 읽기 방향에 맞춰 정렬합니다.

### 인페인팅과 PNG 출력

- `AOT 최소`: 가장 가볍고 실행 가능성을 우선하는 경로
- `LaMa 절약`: 가벼운 만화 특화 원문 제거 경로
- `Flux 풀로드`: 복잡한 배경 품질을 우선하는 경로
- 번역 블록별 인페인팅 제외, 테두리 확장, 현재 페이지 또는 남은 페이지 자동 처리를 지원합니다.
- 마스크 붓으로 다시 지울 영역을 지정하고, 색 붓·색 뽑기·복원 붓으로 작은 자국을 직접 보정합니다.
- 보정 작업도 실행 취소·다시 실행할 수 있습니다.
- 현재 페이지 또는 전체 화를 PNG로 출력하며, 블록 위치·방향·폰트·색·외곽선·기울기를 반영합니다.

### 공유하기와 가져오기

`*.mgtshare`는 완성 PNG가 아니라 앱에서 다시 편집할 수 있는 작품 패키지입니다. 선택한 작품·화의 원본 이미지, 번역 블록, 좌표, 서식과 인페인팅 결과를 포함할 수 있지만 설정, 로그인 정보, 모델, 로그는 포함하지 않습니다.

가져올 때 새 작품을 만들거나 기존 작품에 화를 추가·교체할 수 있고, 적용 전 병합 화면에서 화 순서를 드래그해 정리할 수 있습니다. 저작권이 있는 원본 이미지를 공유할 때는 배포 권한을 반드시 확인하세요.

## 언어와 설정

### 앱 언어와 번역 언어

| 구분           | 역할                          | 지원 범위                                             |
| -------------- | ----------------------------- | ----------------------------------------------------- |
| 앱 언어        | 버튼, 메뉴, 상태와 오류 문구  | 한국어, 日本語, English, 简体中文, 繁體中文           |
| 원문·번역 언어 | OCR과 AI가 읽고 번역할 언어쌍 | 48개 프리셋, `eo`, `pt-BR` 같은 BCP 47 코드 직접 입력 |

설정 창은 여섯 탭으로 나뉩니다.

- `일반`: 앱 화면 언어
- `번역 엔진`: 언어쌍, Gemma/Codex/API, 모델, 최대 출력 토큰, 컨텍스트 길이와 API 고급 요청 값
- `하드웨어 · OCR`: OCR 품질·장치, Gemma GPU 런타임, 인페인팅 모델·백엔드
- `텍스트 서식`: 새 블록의 기본 방향, 정렬, 폰트, 크기, 간격, 색과 외곽선
- `단축키`: 보기, 번역, 편집, 인페인팅과 전역 명령의 키 조합
- `설치 / 확인`: OCR·모델 준비 확인, 앱 버전, 업데이트 페이지와 로그 폴더

### 번역 엔진 비교

| 엔진         | 장점                                                                           | 준비할 것                                                     |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Gemma 4      | 페이지와 모델이 PC 안에서 처리되고, 준비 후 오프라인 사용 가능                 | GGUF 모델, PC에 맞는 CUDA/ROCm/Vulkan 런타임, 충분한 RAM/VRAM |
| OpenAI Codex | Codex CLI 로그인 정보를 사용하고 API 키를 앱에 저장하지 않음                   | Codex CLI 설치와 로그인, 인터넷 연결                          |
| API          | OpenAI 호환 비전 모델, 로컬 서버, NVIDIA NIM, Gemini 호환 엔드포인트 등을 연결 | Base URL, 이미지 입력 모델 이름, 필요하면 API 키              |

Gemma 프리셋은 대략 다음 순서로 시도할 수 있습니다.

- VRAM 8GB급: `12B 최소`
- VRAM 16GB급: `26B 절약`
- VRAM 24GB 이상: `31B 풀로드`
- 특수 구성: `커스텀`

OCR 품질은 `최소`, `절약`, `풀로드`입니다. CPU에서는 `절약`부터 시작하는 편이 안정적이고, `풀로드` PaddleOCR-VL은 지원되는 GPU와 함께 쓰는 것을 권장합니다.

<details>
<summary><strong>OpenAI Codex 엔진 준비</strong></summary>

Codex 엔진은 Windows에 저장된 Codex CLI 로그인 정보를 `openai-oauth` 로컬 엔드포인트를 통해 사용합니다. 앱에 OpenAI API 키를 직접 입력하는 방식이 아닙니다.

PowerShell에서 공식 Windows 설치 명령을 실행합니다.

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

새 PowerShell을 열고 로그인합니다.

```powershell
codex login
```

`codex`를 실행해 정상적으로 열리는지 확인한 뒤 앱에서 `OpenAI Codex`를 선택하고 `OCR/모델 확인`을 실행합니다. 목록에 없는 모델은 `Custom`에 모델 ID를 입력할 수 있습니다. 포트 충돌이 나면 설정의 `openai-oauth 포트`를 바꿉니다.

공식 안내: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)

</details>

<details>
<summary><strong>OpenAI 호환 API, NVIDIA NIM과 Gemini</strong></summary>

API 엔진은 Base URL에 `/chat/completions`를 붙여 이미지와 OCR 힌트를 전송합니다. 선택한 모델이 이미지 입력을 지원해야 합니다.

- 일반 OpenAI 호환 서버: `https://server.example/v1`
- NVIDIA NIM: `https://integrate.api.nvidia.com/v1`
- Gemini OpenAI 호환 엔드포인트: `https://generativelanguage.googleapis.com/v1beta/openai`
- LM Studio 같은 로컬 서버는 인증이 없다면 API 키를 비울 수 있습니다.

모델 ID와 키는 각 제공자 화면에서 확인하세요. `Temperature`, `top_p`, `top_k`, `reasoning_effort`, 추가 request body JSON과 custom headers JSON도 설정할 수 있습니다. 서버가 모르는 값을 거부하면 고급 값을 먼저 비우고 확인합니다.

환경 변수로도 값을 덮어쓸 수 있습니다.

- OpenAI 공식 키: `OPENAI_API_KEY`
- 호환 서버: `MANGA_TRANSLATOR_API_BASE_URL`, `MANGA_TRANSLATOR_API_MODEL`, `MANGA_TRANSLATOR_API_KEY`

</details>

<details>
<summary><strong>NVIDIA와 AMD 경로</strong></summary>

| 작업       | NVIDIA                      | AMD                   | 예비 경로           |
| ---------- | --------------------------- | --------------------- | ------------------- |
| Gemma      | CUDA 12, RTX 50 전용 런타임 | ROCm 또는 Vulkan      | 더 작은 모델 프리셋 |
| Paddle OCR | NVIDIA CUDA                 | 지원 GPU에서 AMD ROCm | CPU 최소/절약       |
| Flux       | NVIDIA CUDA                 | ZLUDA + AMD HIP SDK   | CPU                 |

AMD Gemma는 GPU와 드라이버에 맞는 ROCm target을 자동으로 찾습니다. 자동 감지가 틀리면 고급 사용자는 예를 들어 다음처럼 지정할 수 있습니다.

```powershell
$env:MANGA_TRANSLATOR_AMD_ROCM_TARGET = "gfx110X"
```

AMD ZLUDA 인페인팅에는 [Windows용 AMD HIP SDK](https://www.amd.com/en/developer/resources/rocm-hub/hip-sdk.html)가 필요합니다. OCR GPU가 실패하면 남은 페이지를 CPU로 이어서 처리하며, Gemma는 계속 AMD GPU를 사용할 수 있습니다.

</details>

## 데이터 저장 위치

설치 중 지정한 데이터 폴더 아래에 사용자 작업과 큰 런타임을 분리해 저장합니다.

```text
data/
  settings.json
  library/
  logs/
  fonts/
  hf-cache/
  llama.cpp/
  ocr-runtime/
  models/
  tmp/
  panel-window-bounds.json
```

- `library/`는 작품, 화, 페이지와 블록 데이터입니다.
- `fonts/`는 직접 등록한 TTF/OTF입니다.
- `hf-cache/`, `llama.cpp/`, `ocr-runtime/`, `models/`는 내려받은 모델과 런타임입니다.
- `logs/`의 `app.log`는 오류를 제보할 때 사용합니다.
- 앱 제거 시 작품 데이터와 모델/OCR 캐시 삭제 여부를 별도로 선택할 수 있습니다.

중요한 작품은 데이터 폴더를 백업하거나 `*.mgtshare`로 내보내세요.

## 자주 묻는 질문

### 처음 실행과 번역이 너무 느립니다

첫 실행은 모델·Python·OCR·인페인팅 런타임 다운로드와 검증 시간이 포함됩니다. 준비가 끝난 뒤에도 느리면 더 작은 Gemma 프리셋, CPU `절약` OCR, AOT/LaMa 인페인팅부터 확인하세요. 여러 GPU 작업과 게임·브라우저가 VRAM을 함께 쓰지 않게 하는 것도 도움이 됩니다.

### Codex 연결이 안 됩니다

PowerShell에서 `codex`가 실행되고 로그인되어 있는지 확인합니다. 앱에서 Codex 엔진을 다시 선택해 `OCR/모델 확인`을 실행하고, 포트 충돌이 의심되면 `openai-oauth 포트`를 바꿉니다. OCR 준비 실패가 Codex 연결 문제처럼 보일 수 있으므로 결과 로그의 실패 단계를 확인하세요.

### API에서 401, 403, 404가 나옵니다

API 키, Base URL과 모델 ID를 확인합니다. Base URL에는 보통 `/v1`까지만 넣고, 이미지 입력을 지원하는 모델을 사용해야 합니다. 제공자가 지원하지 않는 고급 요청 값과 JSON을 비운 뒤 다시 시험하세요.

### AMD OCR GPU가 실패합니다

Windows ROCm은 지원 GPU와 드라이버 조합에 민감합니다. OCR 장치만 CPU로 바꿔도 Gemma 번역은 AMD GPU에서 계속 실행할 수 있습니다. 내장 GPU 동시 인식, VRAM 부족과 Windows TDR도 로그에서 확인하세요.

### AMD ZLUDA 인페인팅이 실패합니다

Windows용 AMD HIP SDK와 `HIP_PATH`를 확인하고 앱을 다시 실행합니다. 당장 작업을 이어가려면 Flux 백엔드를 CPU로 바꾸거나 AOT/LaMa 경로를 사용하세요.

### RTX 50번대에서 OCR이 실패합니다

최신 NVIDIA 드라이버와 앱의 RTX 50용 OCR 런타임을 확인합니다. GPU OCR이 계속 실패하면 OCR만 CPU `절약`으로 바꿔 번역을 계속할 수 있습니다.

### PNG의 폰트가 화면과 다릅니다

번들 폰트는 화면과 PNG에 같이 포함됩니다. 사용자 폰트 파일을 삭제했거나 작품을 다른 PC에서 열었다면 해당 폰트를 다시 등록하세요. 출력 전에 방향, 자동 맞춤, 굵기와 폰트 일괄 적용 상태도 확인합니다.

## 문제를 보고할 때

아래 정보를 [GitHub Issues](https://github.com/ucx0204/CarrotMangaTranslator/issues)에 함께 적어 주세요.

- 앱과 Windows 버전
- GPU 모델과 VRAM
- 번역 엔진, 모델·프리셋과 원문 → 번역 언어
- OCR 품질·장치, 인페인팅 모델·백엔드
- 번역 범위와 `자동 생성`/`기존 블록 유지` 여부
- 재현 가능한 페이지와 `로그 폴더 열기`의 `app.log`

로그에는 사용자 이름 같은 로컬 경로가 들어갈 수 있으므로 공개 전 민감한 부분을 가리세요.

## 개발

필요 환경은 Windows, Node.js LTS, npm과 Git입니다.

```powershell
npm install
npm run dev
```

개발 실행은 `.tmp/electron-dev`를 별도 userData/session 폴더로 사용합니다. 전체 검사는 다음 명령으로 실행합니다.

```powershell
npm run check
```

빌드와 Windows 설치 파일 생성:

```powershell
npm run build
npm run dist:win
```

프로세스 경계, SSOT, 오류 처리와 테스트 규칙은 [코드 경계와 품질 규칙](docs/architecture.md)을 참고하세요.

## 데모 이미지 출처

README의 네 화면에 보이는 만화는 [IDPF EPUB 3 Samples Project](https://github.com/idpf/epub3-samples)의 [`Haruko`](https://github.com/idpf/epub3-samples/tree/main/30/haruko-jpeg) 샘플을 바탕으로 합니다. 원본은 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)이며, 화면에는 당근망가번역기의 한국어 번역 블록과 작업 상태가 추가되었습니다. 이 데모 이미지에는 앱 소스코드와 별도로 CC BY-SA 3.0 조건이 적용됩니다.

## 라이선스

앱 소스코드는 [GPL-3.0-only](LICENSE)로 배포합니다. 앱과 함께 쓰거나 내려받는 폰트, ffmpeg, JavaScript/Python 패키지, OCR·AI 모델과 각 런타임은 별도 조건을 가질 수 있습니다. 재배포 전 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)와 [번들 폰트 고지](third_party/fonts/README.md)를 확인하세요.
