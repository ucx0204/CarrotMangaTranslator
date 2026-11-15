# 폰트 글자 검증 모델 다운로드 복구 (#179)

2026-11-16 KST. 기존 PP-OCRv6 manga v0.2 모델과 사전의 바이트를 보존하고
다운로드 배포처와 분석 전환 안내만 변경한다. 폰트 선택·검증 알고리즘은 변경하지 않는다.

## 원인과 범위

앱이 고정한 Hugging Face revision `ba1d479e8a61a20e8318c9758c73fbbbd290b98d`의
모델·사전 URL이 모두 HTTP 404였다. upstream tree API도 `Invalid rev id`를 반환했다.
production downloader에서는 약 264ms 후 404로 실패했다. 따라서 신고자의 20분 대기를
다운로드 지연으로 확정하지 않는다. 선택적 가속 모델 실패 후 Hayai 분석으로 넘어가면서
진행 이벤트를 보내지 않아 직전 다운로드 표시가 남는 경로는 코드에서 확인했다.

## 변경 불가능한 외부 자산

- [자산 전용 prerelease](https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/font-glyph-ppocr-v02-20261116-r1)
- 태그: `font-glyph-ppocr-v02-20261116-r1`
- 태그 기준 commit: `9a96e07f615818b1dce7261a81dac12baf9908bc`
- 원본: `models/font-glyph-ppocr-v02-r1/`의 해시 일치 파일. 원본 캐시는 보존한다.
- upstream: <https://huggingface.co/Kellenok/PP-OCRv6_manga>, Apache-2.0.
- 변경하지 않은 개별 파일 두 개와 binding manifest만 게시했다. 압축·분할하지 않는다.
- 기존 태그/asset을 덮어쓰지 않았으며 앱 버전 릴리스는 만들지 않았다.

| 파일                               |      bytes | SHA-256                                                            |
| ---------------------------------- | ---------: | ------------------------------------------------------------------ |
| manga_rec_v0.2.onnx                | 21,167,540 | `de12c84c63e62c80339e882e675983d886670dcb6f0147e1ed041afd6fa81888` |
| ppocrv6_dict.txt                   |     74,947 | `b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d` |
| font-glyph-ppocr-v02-manifest.json |        723 | `e9f0cd3bdfb36cd50ed257f3a476a01152d06c2b1946d98fef2228f0ea947708` |

게시 전 production `GlyphVerifier`가 두 파일을 검증하고 CPU ONNX 추론을 수행했다.
출력 shape `[1, 6, 18710]`의 마지막 축은 사전 18,710항목과 일치했다.
게시 후 새 빈 `.tmp/issue179-remote-verify`에 `gh release download`로 세 자산을
재다운로드하고, 서버 개수·이름·크기 및 다운로드된 파일 전체의 SHA-256을 사전 inventory와
대조했다. 모두 일치했다. 로컬 원본만 검사한 결과가 아니다.

소비 코드는 `src/main/pipeline/fontGlyphVerificationAssets.ts`다. 개별 GitHub URL과
기존 exact bytes/SHA를 사용하고 새 캐시는 `models/font-glyph-ppocr-v02-r2`다.
Python worker의 원래 바이트 검증도 그대로 유지한다. `scripts/verify-hf-assets.cjs`가
이 소비 코드에서 URL·크기·해시를 읽어 앞으로의 원격 자산 사전 검사에도 포함한다.

빈 `.tmp/issue179-production-cold-install`에서 빌드된 production consumer를 Electron으로
실행해 두 자산을 실제 원격 설치했다. 이전 캐시의 복사나 migration은 사용하지 않았다.
설치된 두 파일을 production `GlyphVerifier`가 다시 검증하고 CPU로 로드했다.
Python 3.12.7의 승인 native dependency 경로에서 합성 정사각형 입력을 `recognize`에
통과시켜 기존 원본 모델과 결과/신뢰도가 정확히 같은 것도 확인했다. 이는 다운로드→검증→
로드→추론의 작은 smoke이며 만화 전체 분석 품질 재평가를 의미하지 않는다.
Python 3.14.8에서도 production loader와 ONNX 직접 추론을 별도로 통과했다.

## 분석 상태 전환

`fontChapterC18.ts`는 실제 worker 요청 직전에 `font_matching_running` 이벤트를 보낸다.
정상 CPU/GPU 경로는 "폰트 분석 중", CPU 가속 모델 준비 실패 시에는
"기본 방식으로 폰트 분석 중"과 지연 가능성 안내를 표시한다. 취소 시에는 분석 이벤트와
worker 요청을 보내지 않는다. 진행률은 추정하지 않고 indeterminate로 표시한다.

기존 workflow 카운터의 권위와 작업 센터 reducer를 유지한다. 새 이벤트가 이전
다운로드 bytes·total bytes·파일명 detail을 교체한다. 공통 진행 문구와 5개 언어 카탈로그를
함께 갱신하여 작업 센터 밖의 일반 작업 표시에도 같은 상태를 사용한다.

`fontChapterProgress.test.ts`는 실제 원본 입력 준비, 임시 작업 디렉터리 수명,
workflow 이벤트와 렌더러 reducer를 연결한다. 네트워크 설치 및 Python process adapter만
격리하며 성공·실패·GPU·취소를 검증한다. 해당 파일의 외부 adapter 세 경계만
`check-test-mock-boundaries.cjs`에 이유를 기록했다. 전역 mock 허용은 늘리지 않는다.

실제 `StatusPopover`와 공통 스타일을 사용하는 임시 QA 엔트리로 정상/기본 방식 전환을
1440×900 및 420×900에서 캡처하고 직접 검사했다. 다운로드 용량·파일명 잔류,
외부 스크롤, 잘림, 겹침이 없었다. 임시 엔트리는 제거하고 캡처는 보존했다.

- `C:/tmp/issue179-font-progress-wide.png`
- `C:/tmp/issue179-font-progress-narrow.png`

## 검증

- 관련 11개 테스트 파일, 80개 테스트 통과: 정상 다운로드, 실패 시 Hayai 전환,
  GPU의 선택적 다운로드 생략, 취소 전파, 기존 폰트 적용/수명/언어 조건, 공통 작업
  진행률, 5개 언어 카탈로그와 동적 번역 키.
- `npm run verify:hf-assets`: 새 glyph 자산을 포함한 48개 원격 자산 통과.
- `npm run build`: production 빌드 통과.
- `npm run check -- --phase=build`: 타입 검사·lint·format·아키텍처·mock 경계·빌드·
  production 화면/출력 pixel parity·이미지 protocol 등 25개 gate 통과.
- v3.8.10 릴리스 준비에서 `npm run check` 전체 27개 gate도 통과했다.
  1,491개 테스트 파일 통과/2개 제외, 11,704개 테스트 통과/10개 제외이며 기존 coverage
  보호 기준·production 빌드·pixel parity·이미지 protocol smoke를 모두 통과했다.
- 원격 게시 전/후 inventory: `.tmp/issue179-upload-inventory.json`,
  `.tmp/issue179-release-verified.json`.
- 빈 캐시 설치/추론 결과: `.tmp/issue179-cold-install-report.json`,
  `.tmp/issue179-native-smoke.json`.

검증 후 staging·재다운로드·빈 캐시 설치의 임시 자산 복사본만 제거했다.
원본 `models/font-glyph-ppocr-v02-r1`, published release와 위 JSON 검증 기록은 보존했다.

## 롤백

가속 경로를 중지해야 하면 `fontChapterC18.ts`의 CPU glyph asset 준비/전달만 비활성화해
기존 Hayai 분석을 사용한다. 새 분석 전환 이벤트는 유지한다. 404인 upstream URL로
되돌리거나 cache/library/원본을 삭제하지 않는다. 게시된 자산과 원본은 보존하고,
추후 자산 변경은 새 태그·새 cache version과 동일한 원격 재검증 절차로 진행한다.
