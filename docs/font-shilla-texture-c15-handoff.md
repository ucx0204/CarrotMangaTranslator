# 강한 명조·붓 느낌 강조: C15 제품 인계

2026-09-06. R33/proxy v2와 C10 고딕 강조 보정을 유지하고, 검증된 강한 명조 강조에 신라문화체 Medium 500을 선택하는 작은 CPU 경로를 추가했다. S18 전체 유형/군집 모델은 승격하지 않는다. 화 전체 군집, 손글씨 자동 대응, 사용자가 지적한 모든 굵기 불일치가 해결됐다는 의미가 아니다.

## 적용 계약

- 기존 verified cross-script proxy 증거가 있는 영역만 분석한다.
- 원문 연결 성분 주위의 잉크 질감을 최대 8개 96×96 패치로 읽는다. 최소 2개가 필요하다. 원문 문자열, 작품 ID, 사용자 반례 ID는 모델 입력이 아니다.
- 정확한 모델의 decorative_serif 확률 ≥ 0.8, 차순위와 차이 ≥ 0.35, heavy 굵기 승자일 때만 허용한다. 기준은 새 확인 화 열람 전에 봉인했다.
- 기존 proxy 선택이 리디바탕·나눔명조·나눔고딕·고운밤일 때만 교체한다. C10 도현체 선택이 우선이고 기존 경찰감성체·손글씨 등 표현체는 보존한다.
- 선택 풀에 신라문화체가 있고 번역문 coverage가 충족될 때 Medium 500, synthetic bold/italic 없이 적용한다. 일반/가는 명조에는 새 경로를 적용하지 않는다.
- 기존 사용자 수동 잠금·작품 프로필 우선순위, 글자 크기 추정과 외곽선 설정은 유지한다. 모델 실패를 성공으로 숨기지 않고 기존 runtime 오류 경계를 따른다.
- 신라문화체에 없는 `「」『』` 네 기호만 설치된 나눔명조로 렌더 보완한다. primary cmap는 계속 엄격하게 검사하며 다른 누락 문자까지 허용하지 않는다. 자동 선택에는 실제 fallback 후보의 설치·coverage도 필요하고, renderer는 별도 실제 face 로드가 끝날 때까지 기다린다.

## 모델과 학습 권위

`src/main/pipeline/fontTextureModel.json`에 ONNX 1,061,428 bytes를 base64로 포함한다.
SHA-256: `08ab996b60964e1fa4ffb05b942808a212a3856f23d2bb5f65c3d32abb5574ad`.
`fontMatchingTextureRuntime.ts`가 schema·bytes·SHA·class/weight 순서를 검사한다. 공용 native ONNX gateway의 CPU provider, intra 2/inter 1 threads로 실행한다. 외부 자산/태그/cache version이나 앱 버전은 바꾸지 않는다.

11종 유형과 4종 굵기 head는 S18 descriptor 모델의 기존 affine head를 정확하게 결합했다. 새 확인 화로 재훈련하지 않았다.

- descriptor ONNX SHA: `833474cf6b1eeb1b7d59950ed2575d1a212b64dc1b7dff7559c656981ca43bb4`
- heads SHA: `f1a393624929a3c49942e57e5feb8d4a0b73907ac045cd75b94362b8f61c690c`
- training inventory SHA: `1eba3e07f824f5d6e16208fa08a66614d45403628ea0ccadfbe6066b8a30eeed`
- producer: 연구 워크트리 `scripts/font-palette-lab/train-source-cohort-texture.py`
- derived artifact producer: 연구 워크트리 `artifacts/font-palette-lab/shilla-automatic-c15/prepare-confirmation.py`

학습은 S17 AI weak label 1,481개(960 train / 279 training-page calibration / 242 development validation)를 사용했다. human gold가 아니며, v11 수동 감사와 1,347 direct visual label을 섞지 않았다. S18의 일반 고딕·둥근 글씨·손글씨와 전체 군집은 오분류 때문에 보류했다. 연구 결과는 연구 워크트리 `docs/font-source-cohort-texture-s18-results.md`에 남아 있다.

## 확인과 시각 판정

증거 루트: `../망가번역기-font-palette-lab-20260905/artifacts/font-palette-lab/shilla-automatic-c15/`.
프로토콜 SHA: `d4e06d067724d886d186c6759b65abdaae2cce2be1a9435bf7dcdd510f3ec5e5`.

봉인한 미사용 S09/S10 두 화 26페이지를 HayaiOCR로 처리했다. 155 영역 중 인쇄된 가짜 영문 문자열 1개를 제외하고 154개를 Codex가 직접 한국어로 번역했다. 원문 14개 시트를 직접 보고, 실제 앱 후보 loader → worker → coordinator → decision/style → production reflow/export로 B/C를 만들었다. 동일 번역·기존 erasure·말풍선 geometry를 사용했다.

S10 P013의 두 강조 영역은 고운밤에서 신라문화체로 바뀌었다. 같은 연결 말풍선의 『희망』 문장도 기호 보완 후 같은 서체를 유지한다. 전체 원본 크기 PNG를 확인했으며 강조의 붓 느낌과 무게가 원문에 더 가깝고 말풍선 안에서 읽힌다. 일반 대사 대조군 S09 P002 / S10 P005도 원본 크기로 확인했다. 나머지 25페이지는 B/C PNG가 동일하다. 이 결과는 두 화의 제한된 확인이며 포괄적인 회수율이나 human 평가 수치가 아니다.

`native-parity/receipt.json`: 같은 실제 앱 decode RGBA에서 독립 Python PIL/OpenCV/frozen ONNX와 native TS/ORT를 비교했다. 154영역, 1,089패치의 pixel 불일치 0, logit 최대 차이 0. CPU median 준비 3.25ms / inference 3.91ms, inference p95 4.88ms. 서로 다른 JPEG decoder의 동등성을 주장하지 않는다. 합성 gray/inverted/color fixture parity와 취소·빈 입력도 테스트했다.

## 비교 harness 오류 교정

초기 연구 runner는 실제 앱에서 수정된 24개 render 후보 대신 raw legacy R33 후보 21개를 읽어 신라문화체·꾸불림체·금면성실체를 누락했다. 기존 `baseline/`, `latest/`는 legacy-pool 진단으로 보존하며 실제 이전 앱 출력이라고 부르지 않는다.

교정한 `baseline-app/`과 `latest-app/`는 `createDefaultWholePagePipelineDependencies`의 후보 loader와 inference port를 모두 사용한다. MAIN `13e18ed81ca4c424c6f0b18771b55644f2183ea5`의 runtime/settings/source snapshot, 번역과 erasure를 유지했다. 최종 20작품 비교의 B도 이 경로로 194페이지 전부 다시 만들었다. 긴 이미지 작품은 사용자 요청으로 W21로 교체했다. final 평가 페이지는 학습·문턱 선정에 쓰지 않는다.

## 제품 검증과 후속

관련 focused tests에는 실제 ONNX/픽셀 parity, gate·pool·비정상 evidence, 수동/프로필 잠금, 기존 표현체 보존, 기호 fallback 로드와 누락 검사가 포함된다. actual PageArtwork의 넓은/좁은 화면 QA 및 MAIN 전체 check/build 결과는 최종 비교 결과 문서에 기록한다.

롤백은 이 C15 제품 커밋을 revert하고 앱을 다시 빌드한다. C10/R33 외부 runtime과 설치 폰트는 그대로이므로 사용자 데이터나 외부 자산을 삭제할 필요가 없다. 재시작 전 이미 열린 앱은 이전 코드를 계속 실행할 수 있다. 기존 출력물은 자동으로 재작성하지 않는다.
