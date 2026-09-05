# 기본 한글 폰트 교체와 자동 맞춤 후보 연결

2026-09-06. 사용자가 요청한 꾸불림체, 금면성실체, 신라문화체를 기본 폰트와 실제 자동 맞춤의 시각 비교 후보에 추가한다. Black And White Picture(쾅!), Kirang Haerang(삐질), Single Day(두근)는 기본 목록/번들/자동 후보에서 제외한다.

## 제품 경로와 데이터 권위

- R33 분류기의 봉인된 21개 출력 ID와 외부 runtime bytes는 변경하지 않는다. 제거된 세 출력은 설치 파일을 요구하지 않는 내부 reference-only 채널로 유지하며, 빈 coverage로 렌더 후보가 될 수 없다. 다른 채널의 파일 검증은 그대로다.
- 공개 자동 후보는 기존 목록에서 세 폰트를 빼고 새 세 폰트를 더한 목록이다. `korean-palette-20260906-v1` revision을 가진 추론만 이 목록 차이를 통과한다. 분류기 순서·모델·local evidence 검증은 유지한다.
- 기존 cross-script generator가 생성한 한국어 glyph를 **실제 새 폰트로 렌더한 참조 glyph**와 비교한다. 기존 유지 face의 bank bytes는 그대로 복사한다. 신라문화체는 실제 500/700 두 face를 비교한다. 과거 출력 채널의 이름만 새 폰트로 바꾸지 않는다.
- worker와 in-process fallback은 `completeFontPaletteInference`를 공유한다. 새 후보는 검증된 시각 proxy가 없으면 선택 불가다. 수동 서식 잠금, 번역 coverage, 사용자 외곽선은 기존 gateway가 적용한다.
- 기준 참조는 `src/main/pipeline/fontCatalogReferenceExtension.json`. 4 faces × 24 glyphs × 96 × 96, 884,736 bytes, SHA-256 `7726bdc2cf84069d268168feb953eed7bd53c921434fd1d9d533c58381cb849e`다. 외부 학습 데이터나 사용자 판정을 새 학습 정답으로 사용하지 않았다. 재훈련 대신 참조 bank를 확장했다.

재현: `python -X utf8 scripts/build_font_palette_reference_extension.py --check`. 기존 proxy trainer의 `_render_glyph`와 고정 glyph 순서를 그대로 사용한다. fontTools/Pillow/NumPy 및 기존 trainer 의존성이 필요하다. 출력 압축 바이트가 달라도 해제한 bank와 전체 metadata가 같아야 한다.

## 폰트 원본과 글자 지원

개별 원본 SHA-256은 `third_party/fonts/manifest.json`에 기록했다. 폰트 파일을 변형하지 않았다.

- 꾸불림체: [우아한형제들 라이선스](https://www.woowahan.com/fonts/license), OFL. `ko/kkubulim.ttf`, 2,893,776 bytes.
- 금면성실체: [상상토끼 원본 안내](https://sangsangfont.com/21/?idx=162), 허용된 배포 조건을 `third_party/fonts/geummyeon-seongsil`에 보관. `ko/geummyeon-seongsil.ttf`, 793,920 bytes.
- 신라문화체: [경주시 현재 안내](https://www.gyeongju.go.kr/open_content/ko/page.do?mnu_uid=3288), 공공누리 제1유형/출처표시. 현재 페이지의 2025-12-16 갱신 조건을 기준으로 한다. Medium 8,176,008 bytes, Bold 8,849,936 bytes.

꾸불림체/신라문화체는 cmap에 등록됐지만 실제 윤곽이 빈 한글이 많다. 새 참조 manifest의 nonempty-outline coverage와 CSS unicode-range를 일치시켜 자동 맞춤에서는 해당 글자를 가진 번역을 제외하고, 수동 사용 시에는 다음 대체 폰트로 넘어가도록 했다. 공백은 허용한다.

## 이미 설치된 세 폰트의 보존

`preserveDemotedFonts`는 **실제로 존재하는 이전 번들 파일만** 사용자 fonts 디렉터리로 byte 그대로 복사하고 안정 UUID로 일반 폰트 index에 등록한다. 다운로드하지 않는다. 기존 ID의 블록/선호 설정은 renderer와 custom-font resolver에서 UUID에 연결한다. 원본이 없으면 설치하지 않는다.

이 PC의 메인 소스를 갱신하기 전에 세 파일을 `fonts`에 보존했고 원본 SHA를 대조했다. receipt는 lab `.tmp/font-catalog-refresh/migration-receipt.json`이다. 저장된 페이지 JSON을 일괄 수정하지 않았다. 일반 폰트이므로 사용자가 삭제할 수 있다.

**배포 시 주의:** 앱 릴리스는 이번 작업 범위가 아니다. 이전 installer를 덮어써 `app.asar`를 없애기 전에 이전 번들 파일을 보존할 수 있는 업그레이드 단계가 필요하다. 기존 설치의 원본이 사라진 뒤 새 버전을 처음 실행하면 없는 파일을 복원하거나 다운로드하지 않는다.

## 검증과 한계

- 실제 FontManagerModal과 FontsContext로 1440×1000 및 600×950 캡처를 직접 확인했다. 새 세 폰트와 제거 가능한 일반 폰트 세 개, 내부 스크롤, 좁은 폭 줄바꿈/버튼 배치가 정상이다. 임시 QA 엔트리와 PNG는 확인 후 제거했다. 실행 로그는 lab `.tmp/font-catalog-refresh/qa-*.log`.
- migration/기존 블록 alias/없는 폰트/실제 폰트 bytes/빈 glyph coverage 검증을 추가했다. 새 세 폰트 각각에 대해 proxy 우승이 실제 decision/style까지 도달하고 revision 누락·후보 중복·분류기 evidence 유실은 거부되는 테스트를 추가했다.
- 앱 factory/worker를 사용하는 `confirmation-005/c12-current-palette`에서 HayaiOCR 및 봉인된 직접 번역으로 26페이지/159블록 replay가 완료됐다. 새 후보는 실제 proxy 점수에 포함됐으나 이 표본의 최종 선택은 0건이다. 이 결과를 새 서체의 상황별 매칭 품질이 입증됐다는 뜻으로 해석하지 않는다. 005는 개발 표본이며 C12는 이 표본의 네 번째 한국어 후보 실험이다.
- 사용자가 제안한 불안한 말/혼잣말/중간 붓글씨 용도는 후속 시각 평가 기준이다. 아직 상황별 정확도를 새로 학습해 검증했다는 주장은 하지 않는다.
- 전체 화의 원문 폰트 추정 묶음 S6/C11은 별도 연구 상태다. 이번 기본 폰트 교체를 그 연구의 앱 통합 완료로 간주하지 않는다. 기존 v11 evaluation-only, 1,347 direct visual labels training-only이며 human gold가 아니라는 데이터 경계를 유지한다.

Rollback은 제품 커밋을 revert하고 이전 번들 폰트/공개 catalog를 복원하는 것이다. 사용자 fonts에 보존한 세 파일은 삭제하지 않는다. 외부 모델 자산은 변경하지 않았다.
