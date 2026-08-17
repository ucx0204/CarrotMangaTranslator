# Privacy policy

Last updated: 2026-08-17

This notice describes how CarrotMangaTranslator (distributed in Korean as
`당근망가번역기`) stores data and uses network services. The project does not
operate an application backend, user-account service, advertising service, or
project-controlled analytics service.

> This program will not transfer any information to other networked systems
> unless specifically requested by the user or the person installing or
> operating it.

## Information stored on the device

The application stores the following information in the data folder selected
during installation:

- imported manga images, titles, chapters, OCR text, translations, text-block
  layouts, inpainting results, glossaries, character notes, translation rules,
  and story memory;
- application settings, custom API endpoints, model identifiers, API keys,
  access tokens, custom request headers, and the local path of a selected
  Vertex service-account JSON file;
- application logs that may contain local file paths, system information, error
  details, or project-related text;
- downloaded models, OCR and inpainting runtimes, caches, custom fonts, and
  window preferences.

API keys, access tokens, and credential-bearing custom headers entered in the
application are kept in the app's OS-encrypted local settings vault. A selected
Vertex service-account JSON file is not copied into the data folder; the app
stores its local path and reads the credential from that file when Vertex is
used. Protect both the data folder and the original JSON key file, do not place
them in a publicly shared location, and never send them or raw logs to others.

Codex CLI credentials are managed by Codex CLI and are not copied into the
application's settings file.

## Network activity

Network activity occurs only after the user selects or initiates a feature that
needs it.

| User action                                               | Information and destination                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use OpenAI Codex or a user-configured external AI API     | The selected service may receive page images or cropped regions, OCR text, prompts, translation instructions, glossaries, character notes, translation rules, story or previous-page context, model parameters, and authentication data needed for the request.                                      |
| Discover models or test an API connection                 | The configured provider receives a model-list or test request and any authentication data configured for that provider.                                                                                                                                                                              |
| Use a local AI, OCR, or inpainting engine                 | Page content is processed on the device. Initial setup may still download the selected model, runtime, or software package.                                                                                                                                                                          |
| Download models and runtimes                              | Download hosts such as GitHub, Hugging Face, Python, PyTorch, NVIDIA, AMD, PaddlePaddle, or their content-delivery providers receive ordinary HTTP request data such as the device's IP address and requested file. Project images and translation text are not included in these download requests. |
| Check for an application update                           | The current application does not perform a background update check. When the user presses the update button, it opens the project's GitHub Releases page in the default browser. The browser and GitHub then process the request under their own settings and policies.                              |
| Report a problem                                          | The application does not automatically upload crash reports. It prepares a redacted preview and opens a pre-filled GitHub issue in the default browser. Information is sent to GitHub and becomes public only if the user reviews and submits the issue.                                             |
| Open a provider, download, documentation, or support link | The link opens in the default browser. The destination site receives normal browser request information and may use its own cookies or account session.                                                                                                                                              |

The application does not automatically upload usage telemetry, project files,
logs, or error reports to the project maintainers.

## External services

Data sent to an external service is handled under that service's terms,
retention rules, and privacy policy. Depending on the service and account type,
the provider may retain requests or use them for abuse monitoring, evaluation,
or model improvement. Review the selected provider's current policy before
sending confidential, personal, or copyrighted material.

Common service policies include:

- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)
- [Google Privacy Policy](https://policies.google.com/privacy)
- [NVIDIA Privacy Policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/)
- [OpenRouter Privacy Policy](https://openrouter.ai/privacy)
- [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
- [Hugging Face Privacy Policy](https://huggingface.co/privacy)

For a custom OpenAI-compatible endpoint or local server, the operator of that
endpoint controls its data practices. A server using `localhost` or
`127.0.0.1` normally remains on the device, but a custom Base URL may send data
to any system chosen by the user. Use an HTTPS endpoint when sending
credentials or private content; an unencrypted HTTP endpoint may expose that
information in transit.

## Exports and sharing

The application creates PNG, TXT, CSV/TSV, and editable `*.mgtshare` files only
when the user requests an export. A share package may contain selected original
images, translations, text-block data, and inpainting results. It does not
include application settings, login information, API keys, models, or logs.
The user controls where exported files are saved and whether they are shared.

## Retention and deletion

Local data remains in the selected data folder until the user deletes it. The
uninstaller asks separately whether project data and downloaded models or
runtimes should also be removed. API keys and access tokens can be removed by
clearing them in Settings or deleting the local settings vault. A Vertex
service-account key must also be removed or revoked in Google Cloud when it is
no longer needed. External providers retain or delete data according to their
own policies and the user's account settings.

## Logs and support

The application keeps local logs for troubleshooting. Raw logs may contain
paths or project-related information and are not automatically sanitized.
Shared diagnostic previews attempt to mask API keys, authorization headers,
home-directory paths, and project text, but automatic redaction cannot be
guaranteed to find everything. Review and manually redact diagnostic material
before publishing it.

For privacy questions or corrections to this notice, open a
[GitHub issue](https://github.com/ucx0204/CarrotMangaTranslator/issues) without
including confidential information.

---

# 개인정보 처리 안내

최종 수정일: 2026-08-17

이 문서는 CarrotMangaTranslator(당근망가번역기)가 데이터를 저장하고 네트워크
서비스를 사용하는 방식을 설명합니다. 프로젝트는 앱용 백엔드 서버, 사용자 계정
서비스, 광고 서비스 또는 프로젝트가 제어하는 분석 서비스를 운영하지 않습니다.

> 이 프로그램은 사용자 또는 설치·운영하는 사람이 명시적으로 요청하지 않는 한
> 다른 네트워크 시스템으로 정보를 전송하지 않습니다.

## 기기에 저장되는 정보

앱은 설치 중 선택한 데이터 폴더에 다음 정보를 저장합니다.

- 가져온 만화 이미지, 작품과 화, OCR 원문, 번역문, 텍스트 블록 배치,
  인페인팅 결과, 용어집, 캐릭터 메모, 번역 규칙과 스토리 기억
- 앱 설정, 사용자 지정 API 주소, 모델 ID, API 키, 액세스 토큰, 사용자 지정 요청
  헤더와 선택한 Vertex 서비스 계정 JSON 파일의 로컬 경로
- 로컬 파일 경로, 시스템 정보, 오류 상세 또는 작품 관련 텍스트가 들어갈 수 있는
  앱 로그
- 내려받은 모델, OCR·인페인팅 런타임, 캐시, 사용자 폰트와 창 위치 설정

앱에 입력한 API 키, 액세스 토큰과 인증용 사용자 지정 헤더는 운영체제로 암호화한
로컬 설정 금고에 보관됩니다. 선택한 Vertex 서비스 계정 JSON은 데이터 폴더로
복사하지 않고 로컬 경로만 저장하며, Vertex를 사용할 때 원본 파일에서 인증 정보를
읽습니다. 데이터 폴더와 원본 JSON 키 파일을 모두 보호하고 공개 공유 폴더에 두지
말며, 다른 사람에게 보내거나 원본 로그에 첨부하지 마세요.

Codex CLI 로그인 정보는 Codex CLI가 관리하며 앱 설정 파일로 복사되지 않습니다.

## 네트워크 사용

네트워크 연결은 사용자가 해당 기능을 선택하거나 실행했을 때만 발생합니다.

| 사용자 동작                                        | 전송 정보와 대상                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex 또는 사용자가 설정한 외부 AI API 사용 | 선택한 서비스에 페이지 이미지나 자른 영역, OCR 텍스트, 프롬프트, 번역 지침, 용어집, 캐릭터 메모, 번역 규칙, 스토리·이전 페이지 문맥, 모델 요청 값과 인증 정보가 전송될 수 있습니다.                                 |
| 모델 목록 검색 또는 API 연결 시험                  | 설정한 제공자에 모델 목록·시험 요청과 해당 제공자용 인증 정보가 전송됩니다.                                                                                                                                         |
| 로컬 AI·OCR·인페인팅 엔진 사용                     | 페이지 내용은 기기에서 처리됩니다. 다만 최초 준비에는 선택한 모델, 런타임 또는 소프트웨어 패키지 다운로드가 필요할 수 있습니다.                                                                                     |
| 모델과 런타임 다운로드                             | GitHub, Hugging Face, Python, PyTorch, NVIDIA, AMD, PaddlePaddle 또는 해당 CDN에 기기의 IP 주소와 요청한 파일 같은 일반 HTTP 요청 정보가 전달됩니다. 작품 이미지와 번역 텍스트는 다운로드 요청에 포함되지 않습니다. |
| 앱 업데이트 확인                                   | 현재 앱은 백그라운드 업데이트 확인을 하지 않습니다. 사용자가 업데이트 버튼을 누르면 기본 브라우저에서 프로젝트의 GitHub Releases 페이지를 엽니다. 이후 요청은 브라우저와 GitHub의 설정·정책에 따라 처리됩니다.      |
| 문제 보고                                          | 앱은 오류 보고서를 자동 업로드하지 않습니다. 정제된 미리보기를 만들고 기본 브라우저에서 미리 채운 GitHub 이슈를 엽니다. 사용자가 내용을 검토하고 직접 제출할 때만 GitHub로 전송되어 공개됩니다.                     |
| 제공자·다운로드·문서·지원 링크 열기                | 기본 브라우저에서 링크를 엽니다. 대상 사이트는 일반 브라우저 요청 정보를 받고 자체 쿠키나 로그인 세션을 사용할 수 있습니다.                                                                                         |

앱은 사용 통계, 작품 파일, 로그 또는 오류 보고서를 프로젝트 유지관리자에게 자동으로
업로드하지 않습니다.

## 외부 서비스

외부 서비스로 보낸 데이터에는 해당 서비스의 약관, 보관 규칙과 개인정보 처리방침이
적용됩니다. 서비스와 계정 유형에 따라 제공자가 요청을 보관하거나 악용 방지, 평가,
모델 개선에 사용할 수 있습니다. 기밀·개인정보·저작권 자료를 보내기 전에 선택한
제공자의 최신 정책을 확인하세요.

주요 서비스 정책은 다음과 같습니다.

- [OpenAI 개인정보 처리방침](https://openai.com/policies/privacy-policy/)
- [Google 개인정보 처리방침](https://policies.google.com/privacy)
- [NVIDIA 개인정보 처리방침](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/)
- [OpenRouter 개인정보 처리방침](https://openrouter.ai/privacy)
- [GitHub 개인정보 처리방침](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
- [Hugging Face 개인정보 처리방침](https://huggingface.co/privacy)

사용자 지정 OpenAI 호환 주소나 로컬 서버는 해당 서버 운영자가 데이터 처리 방식을
결정합니다. `localhost` 또는 `127.0.0.1` 서버는 일반적으로 기기 안에서 처리되지만,
사용자가 지정한 다른 Base URL은 사용자가 선택한 어떤 시스템으로든 데이터를 보낼
수 있습니다. 인증 정보나 비공개 콘텐츠를 보낼 때는 HTTPS 주소를 사용하세요.
암호화되지 않은 HTTP 주소를 사용하면 전송 중 해당 정보가 노출될 수 있습니다.

## 내보내기와 공유

앱은 사용자가 요청할 때만 PNG, TXT, CSV/TSV와 편집 가능한 `*.mgtshare` 파일을
만듭니다. 공유 패키지에는 선택한 원본 이미지, 번역문, 텍스트 블록 데이터와
인페인팅 결과가 들어갈 수 있지만 앱 설정, 로그인 정보, API 키, 모델과 로그는
포함하지 않습니다. 저장 위치와 공유 여부는 사용자가 결정합니다.

## 보관과 삭제

로컬 데이터는 사용자가 삭제할 때까지 선택한 데이터 폴더에 남습니다. 제거
프로그램은 작품 데이터와 내려받은 모델·런타임도 함께 지울지 별도로 묻습니다.
API 키와 액세스 토큰은 설정에서 지우거나 로컬 설정 금고를 삭제해 제거할 수
있습니다. Vertex 서비스 계정 키가 더 이상 필요하지 않으면 Google Cloud에서도
삭제하거나 폐기해야 합니다. 외부 서비스의 보관과 삭제에는 해당 제공자의 정책과
사용자 계정 설정이 적용됩니다.

## 로그와 지원

앱은 문제 해결을 위해 로컬 로그를 보관합니다. 원본 로그에는 경로나 작품 관련
정보가 들어갈 수 있고 자동 정제되지 않습니다. 공유용 진단 미리보기는 API 키,
인증 헤더, 사용자 홈 경로와 작품 텍스트를 가리려고 시도하지만 모든 민감 정보를
찾는다고 보장할 수 없습니다. 진단 자료를 공개하기 전에 직접 검토하고 필요한 내용을
지우세요.

개인정보 관련 질문이나 이 문서의 수정 요청은 기밀 정보를 포함하지 않은 상태로
[GitHub 이슈](https://github.com/ucx0204/CarrotMangaTranslator/issues)에 남겨 주세요.
