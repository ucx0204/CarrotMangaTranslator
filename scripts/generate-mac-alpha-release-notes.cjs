#!/usr/bin/env node
// @ts-check

const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const root = join(__dirname, "..");

function main() {
  const tag = String(process.env.MGT_MAC_ALPHA_TAG || "").trim();
  const signingMode =
    process.env.MGT_MAC_SIGNING_MODE === "developer-id"
      ? "developer-id"
      : "adhoc";
  if (!tag) {
    throw new Error("MGT_MAC_ALPHA_TAG is required");
  }
  const outputPath =
    process.env.MGT_MAC_RELEASE_NOTES_PATH ||
    join(root, ".tmp", "mac-alpha-release-notes.md");
  const issueUrl =
    "https://github.com/ucx0204/CarrotMangaTranslator/issues/new?template=mac_alpha.yml&title=%5BmacOS%20Alpha%5D%20";
  const unsigned = signingMode === "adhoc";
  const hostedGuiSmokeWaived = existsSync(
    join(root, "dist", "mac-alpha-hosted-app-smoke-waiver.json"),
  );
  const title = unsigned
    ? `Unsigned Apple Silicon Alpha ${tag}`
    : `Apple Silicon Alpha ${tag}`;
  const installation = unsigned
    ? [
        "1. DMG를 열고 앱을 `/Applications`로 옮깁니다.",
        "2. 처음 실행이 차단되면 시스템 설정 → 개인정보 보호 및 보안에서 해당 앱의 **확인 없이 열기**를 선택합니다.",
        "3. 출처를 신뢰할 수 있는 이 GitHub Release의 SHA256과 다운로드 파일을 먼저 대조하세요.",
      ]
    : [
        "1. DMG를 열고 앱을 `/Applications`로 옮깁니다.",
        "2. Developer ID 서명·Apple 공증·stapling 검증을 통과한 빌드입니다.",
      ];

  const notes = `# ${title}

> 실기 검증이 진행 중인 **Apple Silicon 전용 Alpha**입니다. 중요한 원본은 별도로 보관하고, 문제는 아래 Mac Alpha Issue 양식으로 알려주세요.

별도 실기 테스터를 확보하지 못한 상태에서 공개 검증을 시작합니다. Apple Silicon Mac이 있다면 직접 설치해 번역과 인페인팅을 사용해 보시고, 성공 여부와 오류 로그를 알려주시면 다음 Alpha를 고치는 데 큰 도움이 됩니다. 오류가 나면 앱의 문제 신고 기능이 만든 익명화 로그를 Issue에 첨부해 주세요.

## 지원 범위

- Apple Silicon M1 이상, macOS 14 이상 (Intel Mac 제외)
- 로컬 Gemma 4 12B·26B·31B Metal
- Flux Klein·LaMa Manga·AOT Metal 인페인팅
- Paddle OCR CPU, Codex/API 번역, 편집·가져오기·저장·내보내기
- 앱 데이터: \`~/Library/Application Support/manga-gemma-translator\`

## 메모리 등급과 현재 검증 상태

- 16GB 이상: 12B, AOT, LaMa, Flux — **실기 결과 접수 전 미검증**
- 24GB 이상: 26B — **실기 결과 접수 전 미검증**
- 32GB 이상: 31B + DFlash CPU-ring — **실기 결과 접수 전 미검증**

모델 가중치는 첫 사용 때 체크섬 검증 후 내려받습니다. 대략 12B 7.6GB, 26B 13.1GB, 31B 15.8GB 외에 OCR·인페인팅 모델 공간이 필요하며 네트워크에 따라 오래 걸릴 수 있습니다.

## 설치

${installation.join("\n")}

## 테스터 체크리스트

- 모델 다운로드, 중단 후 재시도, 캐시 재사용
- 번역 시작·취소·재실행과 앱 재시작 후 저장 상태
- AOT·LaMa·Flux 인페인팅 및 수동 보정
- 이미지/폴더/CBZ 가져오기와 PNG/TXT/CSV 내보내기
- 31B 사용 시 로그에 DFlash CPU-ring 경로가 명시되는지 확인

자세한 항목은 함께 첨부된 \`MAC_ALPHA_TEST_CHECKLIST.md\`를 사용해 주세요.

## 알려진 제한

- GitHub의 7GB M1 빌드 러너는 대형 모델 품질·장시간 메모리 시험을 대신하지 못합니다.
${hostedGuiSmokeWaived ? "- GitHub 호스티드 macOS 15 러너에서 패키지 GUI 앱의 LaunchServices prepare 스모크가 Electron native EXC_BREAKPOINT/SIGTRAP(CrBrowserMain)으로 종료되어 이 수명주기는 CI에서 미검증입니다. arm64·서명·번들 런타임·OCR·Metal 검증은 통과했으며, 실제 Mac에서 앱 실행·가져오기·저장·재실행·내보내기 확인을 요청합니다." : "- 패키지 GUI 앱의 LaunchServices 가져오기·저장·재실행·내보내기 수명주기 스모크를 통과했습니다."}
- 인증서가 없는 빌드는 ad-hoc 서명이므로 Gatekeeper에서 수동 승인이 필요합니다.
- Intel Mac과 macOS 13 이하는 지원하지 않습니다.

## 문제 제보

[Mac Alpha Issue 열기](${issueUrl}) — 앱의 문제 신고 기능을 쓰면 칩, 통합 메모리, macOS, Metal 장치, 선택 모델과 익명화된 로그가 자동으로 채워집니다.

문제없이 동작한 경우에도 사용한 Mac 모델, 통합 메모리, Gemma·인페인팅 조합과 체크리스트 결과를 남겨주시면 해당 메모리 등급을 검증 완료로 바꾸는 데 활용하겠습니다.
`;

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, notes, "utf8");
  console.log(outputPath);
}

main();
