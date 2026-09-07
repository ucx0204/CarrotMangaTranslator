# C18 화 단위 폰트 자동 맞춤 — 로컬 앱 통합

2026-09-07. 사용자가 confirmation-010의 C18을 승인하고 즉시 앱 반영과 새 작품 검증을 지시했다.
작업 위치는 사용자의 지시에 따라 기본 워크트리 `master`다. 이전 연구 브랜치를 새로 만들거나
라이브러리·코퍼스·기존 HTML을 이동하지 않았다. 이 문서의 앱 반영은 로컬 소스와 빌드의
일반 전체 페이지 번역 경로다. 설치 파일이나 외부 모델 자산의 공개 릴리스는 아니다.

## 변경과 권위

- `wholePagePipeline`은 번역 결과 준비와 번역 endpoint 해제 후, 출력 페이지를 확정하기 전에
  작업에 포함된 일본어 원문 페이지 전체를 C18 포트에 전달한다. 원본 이미지만 분석하며
  한국어 번역문·사용자 평가 라벨·기존 한국어 렌더는 분류 입력이 아니다.
- Hayai 줄/글자 확인 → S5 원문 형태 표현 → S6 화 단위 묶음 → S20 원문 유형/굵기 →
  C18 묶음별 한국어 서체 선택을 실제 앱에서 실행한다. 각 페이지 coordinator가 그 결과를
  전달하고, 최종 block의 `fontFamily`와 정확한 `fontWeight`에 적용한다.
- 화 전체에서 같은 원문 문자열이 반복돼도 투표를 중복해서 키우지 않는다. 짧은 문자열은
  서로 다른 문자열의 같은 글자 증거가 합의하는 경우에만 결합한다. 페이지 ID별 보정은 없다.
- 인쇄체는 원문 묶음의 굵기 증거로 400/700을 고른다. 손글씨·display font는 native face를
  사용한다. 임의 200 선택과 bold 여부만으로 800을 재생성하는 문제를 막았다.
- 수동 block/role 잠금과 설치 후보 목록을 존중한다. 선택한 C18 폰트가 사용자 후보에 없으면
  기존 허용 후보 결정이 유지된다. 제한된 모든 풀에서 최선의 대체 서체를 다시 찾는 기능은
  아직 없으므로 그 경우 화 묶음의 출력 일관성이 약해질 수 있다.
- C18 결정에는 별도 `sourceChapterStyle`과 버전을 남긴다. 기존 v2 추론이 C18을 선택했다고
  기록하지 않는다. C18 출력에서는 이전 v2 관측을 새 continuity로 저장하지 않는다.
- 원문 크기 추정은 전역 최소 px 없이 유지한다. null 추정 중 짧은 본문과 가는 문장부호 열이
  섞인 경우에만 교차 획 증거를 회복한다. 크기·줄바꿈을 전부 해결했다고 주장하지 않는다.

주요 파일:

- `src/main/pipeline/fontChapterC18*.ts`: 입력, worker 어댑터, 묶음 결과 연결, 적용.
- `src/main/pipeline/fontChapterC18Manifest.json`: C18.1 정확한 모델·참조 폰트·의존성·알고리즘 해시.
- `src/main/runtime/font-chapter-c18/`: 동결된 11개 연구 알고리즘과 JSON-lines worker.
- `src/shared/blockFontWeight.ts`: 정확한 굵기와 사용자 bold/서체 변경의 공통 계약.

원문 shape matching과 학습 모델 추론은 CPU다. HayaiOCR은 기존 앱의 장치 설정을 사용한다.
코드 이동의 허용 차이는 CPU 강제와 근거가 없는 pixel cutoff 처리이며, 원문 입력/선택 결과의
실제 parity로 확인한다. 외부 표본과 1,347개 direct visual label을 human gold로 승격하지 않는다.

## 로컬 자산

이 PC의 `font-chapter-c18/v1`에 모델·일본어 참조 폰트·Python 의존성을 소유 팩으로 설치했다.
총 3,137파일, 911,870,343bytes(ownership 제외)를 코드 manifest와 비교해 확인했다.
원본 producer artifact는 기존 연구 워크트리에 보존했다. 팩과 cache는 Git 추적 대상이 아니다.

새 worker는 앱이 설치한 Hayai Python을 사용한다. Windows embedded Python은 PYTHONPATH를
무시하므로 전체 파일 해시 검증 뒤 소유 dependency 디렉터리만 sys.path에 넣는다.
Hayai 자식 프로세스는 원래 OCR 환경을 사용해 서로 다른 numpy 버전이 섞이지 않게 한다.
추가 의존성은 numpy 1.26.4, OpenCV headless 4.11.0.86, scipy 1.13.1, fonttools 4.51.0,
onnxruntime 1.21.0 및 해당 metadata/보조 패키지다. Anaconda 경로는 제품 코드에 없다.

검증 및 동일 팩 로컬 복사:

```powershell
python scripts/install-font-chapter-c18-local.py --source font-chapter-c18/v1
python scripts/install-font-chapter-c18-local.py --source <검증된-팩> --data-root <앱-데이터-루트>
```

검증기는 다른 bytes를 재봉인하거나 기존 파일을 덮어쓰지 않는다. 현재 팩은 Windows x64용이다.
macOS 및 공개 설치용 자산 배포는 별도 작업이다. 팩이 없거나 다르면 C18 실패를 알리고,
기존 페이지 폰트를 C18 성공처럼 반환하지 않는다. 일반 설정의 v2 모델 ready 표시만으로
C18 팩 설치까지 완료됐다고 판단해서는 안 된다.

## 승인 화와 미사용 화 검증

기존 연구 산출물 루트는 별도 워크트리
`망가번역기-font-palette-lab-20260905/artifacts/font-palette-lab`다.
기존 로컬 8769 서버가 이 루트를 제공한다.

- confirmation-010: C13/C14/C16/C17/C18로 제품 후보 5회 소진. C18은 사용자 승인으로 승격한다.
  이후 실행은 통합 parity이며 이 화에서 새 임곗값·폰트 매핑·모델 튜닝은 하지 않았다.
- confirmation-011: Rukeichi Koushaku Tsuma no Mahou Kaikaku / Chapter 4.2, 사전 봉인한 미사용 화.
  10쪽, 69개 번역 영역. C18 고정 첫 후보를 실제 앱 분석과 렌더까지 실행했다.
  폰트 선택 69/69와 최종 block의 서체·굵기 69/69가 동결 C18 참조 실행과 일치했다.
  이는 통합 검증 수치이며 시각적 정답률이 아니다.
- B는 정확히 v2.5.0 `5a0dcb7304a36d4034b06bebf31216eae7b333e4`의 실제 typography와 exporter다.
  최근 후보 출력을 B로 사용하지 않았다. B/C는 Hayai 입력·직접 번역·지움 결과·말풍선 기하를
  고정 공유하므로 완전한 릴리스 OCR/번역 전체 경로 비교라고 부르지 않는다.

[새 작품 원본 화질 A/B/C 10쪽](http://127.0.0.1:8769/system-reset-004/chapter-011-app-c18-review.html)
보고서는 30개 원본 이미지 bytes를 그대로 내장한다. P001~P010 A/B/C 전부 직접 열어 확인했다.
1440×900, 800×900 실제 Chromium 화면도 확인했다. 여러 이미지를 합성/축소한 패널이 아니다.

일반 대사의 짧은 부분만 갑자기 굵어지는 현상, 연결된 대사의 불규칙한 서체/굵기 차이,
P010의 가는 고딕을 굵은 명조로 쓰던 문제가 줄었다. P004 좁은 독백 단어 중간 줄바꿈,
P005 독립 마침표, P006 닫는 괄호의 단독 줄, P008 반응체 과장, P009 작은 감탄은 남았다.
개별 반례를 숨기거나 이 화에 다시 맞추지 않고 다음 미사용 화에서 함께 검증한다.

사용자는 이 새 화 결과도 승인하고 이전 20작품 194페이지에 같은 상태를 적용하도록 지시했다.
`c18-20-work-002`는 기존 `final-20-work-001/page-selection.json`을 그대로 봉인한
locked regression이다. 새 일반화 검증으로 세거나 이 표본에서 후보를 다시 튜닝하지 않는다.
그 다음 미사용 화 선택은 `real-source-style-s16/S10/chapter-selection.json`에 보존했다.
한 화 최대 5회, 뚜렷한 개선은 조기 승격, 화마다 원본 화질 HTML 보고를 계속 지킨다.

## 통합 중 잡힌 문제와 검사

- 원문 identity에 bbox 객체를 그대로 직렬화하면 같은 좌표도 속성 삽입 순서 때문에
  연결이 끊겼다. `[x,y,w,h]` 값 배열로 고정하고 순서만 바뀐 입력의 회귀 검사를 추가했다.
  최초 approved-010 parity의 선택은 60/60 일치했지만 적용 51개가 누락됐다는 원본 기록도 보존한다.
- 전체 검사에서 발견된 detached panel의 새 fontWeight 표본 누락을 보완했다.
- architecture budget은 공통 언어 판별 재사용 1곳과 기존 pipeline composition root의 새 포트
  조립 1곳만 명시했다. 의존성 순환은 제거했다. 기존 coverage floor를 낮추지 않았다.
  새 6파일의 V8 측정값만 추가했고 Python/Electron 실측을 가짜 V8 coverage로 쓰지 않았다.
- check의 prepare-electron이 out runtime을 재생성하므로 실제 추론과 check/build를 동시에
  실행하면 안 된다. 해당 인프라 실패의 산출물은 보존하고 후보 실험 횟수로 세지 않는다.
- 사용자 기존 수정인 사용 화 registry는 내용이 동일한지 비교하고 서식만 정규화했다.
  그 파일은 이 제품 변경 커밋에 포함하지 않는다. 원래 bytes도 `.tmp`에 보존했다.

최종 `npm run check`가 161.33초에 통과했다. 665개 테스트 파일, 5,401개 테스트 통과,
기존 skip 2개이며 coverage floor, typecheck, lint, build, page-artwork parity,
image-protocol smoke, renderer/preload bundle 검사를 포함한다.
원본 로그는 `.tmp/c18-full-check008.out.log`와 `.tmp/check-logs`에 있다.
빌드 완료 뒤 순차 실행한 approved-010 `app-c18-parity-003`은 원문 선택 60/60과
최종 block 적용 60/60이 모두 동결 참조와 일치했다. 최초 실패를 덮어쓰지 않고
`system-reset-004/c18-app-chapter010-parity-003.json`에 별도 기록했다.

## 연구와 남겨야 할 판단

이번 논리 작업의 research010은 고유 검색 질의 200개를 수행했다.
`system-reset-004/research010-reading-scope.json`과 결과 5묶음에 실제 범위를 남겼다.
검색 결과 1,671개 URL/제목을 논문 1,671편 전문 독해로 부르지 않는다. 선별 원문과
공식 문서에서 얻은 원문 형태/굵기 분리와 CPU 실행 근거만 사용했다.

C16의 5% 악화·10% 개선은 사용자 인상이며 측정 성능 수치가 아니다.
이전 C16 감사의 P008 서체 이름 및 P005 서체 분리 오판은 addendum이 교정했다.
S20의 중간/강한 붓체는 충분히 검증되지 않았고 C18의 성공으로 포함하지 않는다.
손글씨·인쇄체·강조·굵기·작은 글자·배치 전체를 계속 함께 보고 특정 폰트만 따로 최적화하지 않는다.
