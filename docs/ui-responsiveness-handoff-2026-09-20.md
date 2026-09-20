# UI·반응성 작업 기록 — 2026-09-20

## 범위와 현재 상태

모델 독점, 동일 페이지 쓰기, 공유 문맥·출력 경로 보호를 유지한다. 기능을 접어 숨기지 않고 설정창 높이와 사이드바의 직접 버튼을 유지한다. 버전 변경·릴리스는 없다. QA 이미지는 검토 동안 보관했고 사용자 요청에 따라 최종 커밋 직전에 정리했다.

## 구현

- 문맥 분석이 기존 활동 gate에서 모델·읽는 chapter·공유 문맥을 예약한다. 분석 알고리즘과 storage 권위는 유지한다.
- 페이지별 편집·삭제·모델 작업 잠금을 분리하고 잠금 파생값을 memo화한다.
- 관리 작업의 중간 진행 이벤트를 프레임 단위로 묶고 종료·취소·소유권 전환은 즉시 반영한다. 종료 후 늦은 진행은 무시한다.
- 100개 초과 페이지 목록은 화면 근처 행만 렌더한다. 선택·포커스와 드래그 drop target을 보존한다. 드래그 중 전체 행 비용은 남아 있다.
- 같은 글자 선택 범위·caret 서식의 반복 이벤트가 React 상태를 다시 만들지 않도록 했다. 선택 ref는 실제 변경 시 즉시 갱신하며 같은 위치의 서식 변경은 반영한다.
- 설정 저장 불가 사유를 하단에 표시하고 해당 탭·입력으로 이동한다. 기존 draft 검증과 parity 테스트를 사용한다.
- 조건 일괄 서식의 항목별 테두리를 걷고 글꼴·글자 모양과 색·효과를 구분한다. 블록 기본 서식과 글자 일부 서식의 적용 범위를 표시한다.
- 설정 간격과 중복 제목을 줄이고 GPU/OCR/Flux/API·서식의 불필요한 접기를 제거한다. 효과음 대기 애니메이션을 제거한다.
- 일반·AI·이미지·조사·단축키·자동 저장 설정, 가져오기 버튼, 빈 화면, 일괄 서식의 불필요한 설명을 제거했다. 에러·지원 불가 사유·원본 보존·작업 시작 조건은 필요한 만큼 남겼다. 모든 입력과 기능은 유지한다.
- 200% 확대에서 화면 밖 absolute 숨김 레이블이 문서 높이를 늘리던 문제를 primitive 위치 지정으로 수정했다. body overflow로 숨기지 않았다.

## 선·테두리 후속 수정

설정 탭·AI 하위 탭·편집 탭·SegmentedControl·장치 선택 버튼에서 둥근 모서리와 겹치던 두꺼운 inset 강조선을 제거하고 1px 선택 테두리를 사용했다. 마지막 설정 섹션의 불필요한 끝 선과 첫 API 하위 그룹의 중복 위 선을 제거했다. 짧은 지원 조건이 한글 한 글자 단위로 끊기지 않도록 했다. 기능 배치와 설정창 높이는 유지했다.

수정한 선택 표시 CSS 3개 파일의 Impeccable detector 결과는 0건이다 (`.tmp/ui-lines-detector.json`). 앞선 변경 TSX/CSS 55개 파일 검사에서는 기존 toast/가져오기·공유 상태의 옆 강조선 4건과 canvas resize handle 2건이 나왔다. resize handle은 카드가 아닌 드래그 표시다. 이 6건을 수정 완료 또는 전체 UI 결함 0건으로 보고하지 않는다.

## 요청 시 표시하는 도움말

마지막 사용자 요청에 따라 상시 설명 제거는 유지하고 해당 조작에 hover/focus할 때 도움말을 제공한다. 가져오기 5종, 일반 설정, OCR·인페인팅 모델/장치, Gemma 원본/런타임/프리셋, 문맥·출력 토큰, API 공급자·Temperature/Top P/Top K/추론/JSON, 조사 추론, 기본 서식 여백에 연결했다. 번역 옵션의 폰트·크기 자동 맞춤은 기존 툴팁 설명을 복구했다. 위험 경고는 여전히 직접 표시한다.

기존 ControlTooltip의 inline 동작은 유지하고 스크롤 영역용 portal 표시를 선택적으로 추가했다. 앞선 QA에서 모달 뒤에 가리던 레이어 오류를 실제 캡처로 발견해 기존 portal-tooltip token으로 수정했다. 후속 캡처에서 정상 표시를 확인했다. tooltip 관련 focused 7파일 83개, 위치/해제/단축키/저메모리 후속 2파일 13개 테스트가 통과했다. isolated coverage 실행은 해당 파일 최초 수치이며 전체 coverage 실행 성공을 뜻하지 않는다.

## 측정과 한계

실제 Chromium에서 production 편집기에 동일한 selectionchange를 한 프레임에 하나씩 100회 전달했다. 수정 전 React commit 100회·렌더 390ms에서 수정 후 0회·0ms로 줄었다. 양쪽 모두 long task 0개, 500페이지 중 실제 mount 13행이었다. 반복 선택 이벤트의 중복 작업 제거를 입증하며 앱 전체 속도나 모델 처리 시간의 개선율을 뜻하지 않는다.

이전 jsdom 회귀 측정에서는 500행 mount가 11행으로 줄고 1,000회 중간 진행 이벤트가 한 프레임으로 묶였다. 실제 IPC 횟수·잠금 대기/보유 시간, 일반/긴 원고의 전체 워크플로, 전역 JSON 잠금의 준비 단계 비용은 아직 전후 실측하지 않았다. 모델 병렬화나 무차별 캐시는 하지 않았다.

## 검증

- 현재 focused 설정·편집 테스트: 5개 파일 87개 통과 (`.tmp/ui-copy-focused-final.log`).
- 앞선 잠금·IME·페이지·설정 회귀: 9개 파일 102개 통과 (`.tmp/ui-followup-regression.log`).
- 최종 `npm run check` 통과: 817개 파일, 6,923개 테스트 통과·4개 skip. 타입·lint·아키텍처·기존 coverage floor와 실제 build, page artwork parity, image protocol smoke가 모두 통과했다 (`.tmp/ui-help-final-check.log`, 198.13초).
- `npm run dev` 재실행은 이미 실행 중인 인스턴스(PID 48444)의 중복 실행 보호에 의해 거절됐다. 해당 Vite(5173 HTTP 200)와 Electron 자식 프로세스가 살아 있음을 확인했다. 사용자 인스턴스를 종료하지 않았으며 이번 변경으로 새로 시작하는 dev 검증은 완료하지 않았다.
- 실제 production 컴포넌트의 1440×900, 1240×760, CSS viewport 절반/device scale 2인 200% 상당 캡처를 확인했다. App 빈 화면 외의 편집 상태는 production 컴포넌트 QA 조합이며 실제 전체 모델 작업을 완주한 화면은 아니다.
- 임시 진입점은 검증 후 제거했다. QA 이미지와 미리보기 목록은 사용자 요청에 따라 최종 커밋 직전에 제거했다.
- Impeccable critique 원본은 `.impeccable/critique/2026-09-20T04-42-36Z__src-renderer-src-app-tsx.md`. 개별 설명 추가 제안은 이후 사용자의 설명 축소 지시에 맞춰 적용하지 않았다. 정적 detector 결과를 디자인 품질 보증으로 취급하지 않는다.

## 보충 설명 전체 유형 후속 정리

이미지·OCR 지원 조건, 하드웨어 권장값 적용, 번역/조사 엔진 선택, Gemma 여유 VRAM·mmproj 처리 위치, 로컬 mmproj 파일, API 재시도/고급 입력의 반복 설명을 정리했다. 관련 컨트롤의 기존 tooltip을 사용하며 실제 오류·메모리 위험·재시작 안내·API 키 개수 등 상태 정보는 유지했다. 이 변경을 두 스크린샷만의 수정으로 제한하지 않았다.

비활성 버튼은 disabled를 유지하고 도움말 wrapper를 키보드로 포커스할 수 있게 했다. 200% QA에서 자동 스크롤이 포커스된 도움말을 닫는 현상을 재현하여 포커스가 내부에 남아 있으면 위치를 갱신하도록 수정했다. 마우스 툴팁의 스크롤 해제와 Escape 해제는 유지한다. 설명을 뺀 엔진 선택 버튼의 잔여 104px 높이와 중복 강조도 정리하고 방향키 선택/포커스를 검증했다.

실제 SettingsModal의 이미지·OCR·하드웨어·Gemma·API·로컬 파일·비활성 도움말을 넓은/좁은 화면에서 캡처했다. 200%에서는 비활성 도움말 및 하드웨어 화면을 추가 확인했다. 임시 QA 진입점은 검증 후 제거했고 캡처는 검토 동안 보관한 뒤 최종 커밋 직전에 정리했다. 최종 전체 검사 결과는 아래에 기록한다.

최종 `npm run check`는 204.08초에 통과했다 (`.tmp/ui-help-sweep-check-final.log`). 817개 파일·6,924개 테스트 통과, 4개 skip. 기존 coverage floor 759개와 introduced 675개, 실제 build, page artwork parity, image protocol smoke 모두 통과했다. 새로 변경한 GemmaLocalModelFields는 기존 Node 22 baseline의 값을 그대로 등록했고 기준을 낮추지 않았다. 이번 변경 TSX/CSS 11개 파일의 Impeccable detector 결과는 0건이다 (`.tmp/ui-help-sweep-detector.json`). 검증 당시 QA 원본 101개와 미리보기 링크를 확인했다.

## 전체 반응성 경로 추가 실측

페이지 목록 스크롤, main 관리 작업 진행 IPC, 저장 응답 병합, 검수표 가져오기의 반복 계산을 추가로 줄였다. 변경 전후 측정값과 확대·블록 편집·잠금 검증의 실제 범위는 [최적화 측정 기록](optimization-measurements-2026-09-20.md)에 정리했다. 모델 동시 실행 금지와 transaction·revision 경계는 유지했다. 특히 검수표는 잠금을 풀지 않고 내부의 행별 전체 페이지 복사를 제거했다.

## 작업 병행과 잠금 후속 검증

정적 디자인 검사와 빈 화면 캡처로 작업 중 사용성을 판정하지 않는다. 명령의 진입점, 실제 대상, renderer 차단, main 자원 예약, 저장·취소 경계를 함께 확인하고, 다음 상태를 회귀 기준으로 삼는다.

| 조작                       | 허용하는 범위                          | 유지하는 보호                                          | 근거                                                                    |
| -------------------------- | -------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| A 모델 작업 중 B 편집·저장 | 관련 없는 페이지 내용                  | A 쓰기·revision·저장 인계                              | `activityConcurrency`, `pageJobLocking`, `workspacePointerInteractions` |
| A 내용 확인·복사·블록 선택 | 잠긴 페이지의 조회                     | 텍스트 변경·변형 핸들                                  | `pageBlockListPanel`, `inpaintingWorkspaceUx`                           |
| 다른 화 전체 서식 적용     | 그 화의 모든 페이지가 충돌하지 않을 때 | 같은 화의 처리 페이지·편집 인계·이력 복원              | `workspaceActivity`                                                     |
| 웹 원본 검색·다운로드 준비 | 독립 브라우저 세션·임시 파일           | 같은 request ID 중복, 세션 단일 소비, 최종 보관함 반영 | `webImportService`, `webImportIpc`                                      |
| 내보내기와 다른 작업 병행  | 별도 대상·출력 경로                    | 읽는 스냅샷과 동일 출력 경로                           | 기존 활동 gate와 `activityConcurrency`                                  |
| 번역·인페인팅 옵션 열기    | 옵션 조회·준비                         | 실제 모델 실행 자원 독점                               | `appCommands`                                                           |
| 작업센터 선택·완료·취소    | 각 작업 ID별 상태                      | 다른 작업 소유권과 모델 직렬 실행                      | `statusCenterConcurrency`, `statusDockButton`                           |

웹 원본 검색·준비가 자원을 선언하지 않아 전체 gate를 독점하던 경로를 수정했다. 기존 AppActivityGate와 AppOperationRegistry를 사용하며 별도 스케줄러는 만들지 않았다. 모델 런타임, 같은 페이지 내용, 구조 예약, 문맥, 내보내기 경로의 충돌 규칙은 완화하지 않았다. 자원이 미선언된 경로도 계속 보수적으로 차단한다.

작업센터는 완료 기록이 실행 중 행을 밀어내지 않게 하고, 배경 작업의 완료도 기록한다. 늦은 진행 이벤트와 이전 foreground props가 종료 상태를 되돌리지 못하게 한다. 화면에서 오래된 기록을 비워도 해당 구독 동안에는 종료 ID를 기억한다. 개별 취소는 기존 ID별 취소 경로를 유지한다.

일괄 서식의 UI와 실행 경계가 같은 chapter 충돌 검사를 사용한다. 페이지 목록·OCR·번역 코드의 읽기 잠금은 disabled 대신 readonly를 사용해 포커스와 복사를 허용한다. 캔버스의 선택 차단과 수정 차단을 분리했다. 상시 페이지 잠금 배너는 제거했으며 저장 인계 실패는 작업센터에서 재시도 조작과 함께 표시한다.

검증 화면은 격리 데이터와 실제 PageList, OverlayBlockLayer, UnifiedRightRail, StatusDockButton을 조합했다. 1440×900, 1240×760에서 페이지 선택·포커스·편집 핸들을 확인했고, 작업센터의 여러 작업·취소·저장 실패는 200% 확대도 확인했다. QA 조합의 200% 전체 편집기 레이아웃이나 실제 AI 추론 완주까지 검증했다는 뜻은 아니다. 임시 진입점은 제거하고 이번 캡처와 썸네일 갤러리는 `.tmp/activity-followup-qa/`에 보존한다. 변경 TSX의 Impeccable detector 결과는 `.tmp/activity-impeccable.json`의 0건이며 행동 검증을 대신하지 않는다.

## 글자별 장평 수정

글자별 장평은 저장 문자열에 반영됐지만 `font-stretch`로 표시해 너비 변형을 제공하지 않는 글꼴에서는 효과가 없었다. 이 속성은 글자를 기하학적으로 늘리는 기능이 아니라 글꼴의 너비별 face를 선택한다([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-stretch)).

기존 장평 값·파서·줄바꿈 측정은 유지하고, 장평이 적용된 글자의 표시 폭과 실제 배치 폭을 함께 맞췄다. 편집기와 페이지 artwork의 잉크·안쪽/바깥쪽 외곽선에 같은 기하 계산을 사용한다. 100% 문장은 기존 렌더 경로를 유지한다. 기존 DOM 렌더/추출·선택 복원 테스트를 유지한 채 글자 내용 렌더를 `richTextEditorRunContent.ts`로 분리했다. 줄바꿈은 텍스트 노드로 보존해 한글 입력과 줄바꿈 뒤 caret offset 계약을 유지한다.

실제 Chromium에서 production RichTranslationEditor의 장평 입력으로 앞 두 글자에 50%, 150%, 200%를 적용했다. 저장한 run 값과 `getBoundingClientRect()`/원래 폭의 비율이 각각 일치했고, 차지하는 폭과 그려진 폭의 차이는 1px 이내였다. 같은 문장의 100/50/150/200% PageArtwork 비교를 1440×900, 1240×760에서 확인했다. 가로·세로 artwork의 세 외곽선/잉크 층 일치와 DOM round-trip·선택 복원을 포함한 focused 4파일 88개 테스트가 통과했다. 원본 캡처와 재현 엔트리 사본은 위 QA 폴더에 남긴다.

새 작업 기록 hook과 글자 내용 renderer만 측정된 coverage floor에 추가했다. 기존 파일의 coverage 기준은 낮추지 않았다. 전체 검사 결과는 `.tmp/activity-and-width-check.log` 및 후속 최종 로그로 확인한다.

글꼴의 비동기 로드 완료 시 장평 글자의 실제 배치 폭도 다시 측정한다. 폰트 로드 전후의 측정 폭을 바꾸는 production 편집기 테스트에서 선택 범위와 저장 문자열이 유지되는 것을 검증했다. 한글 조합 중에는 기존 DOM 동기화 보호를 유지한다.

## 좌우 아치 워프 프리셋

워프에 `archLeft`, `archRight`를 추가했다. 기존 위·아래 아치의 강도 0.22를 세로 위치의 envelope에 적용해 x축으로 휘게 한다. 저장은 기존 version 1의 격자 점 좌표를 사용하며 파일 형식은 바뀌지 않는다. 5개 언어의 프리셋 이름과 타입세팅 프롬프트의 허용 이름도 맞췄다.

기존 격자 검증·역변환 검사에 새 프리셋을 포함하고, 3×3/5×5의 방향·전치 대칭·좌표 정밀도·저장 복원과 production Select의 선택을 검증했다. focused 2파일 47개 테스트 통과. 실제 TransformEditorGroup과 PageArtwork로 1440×900, 1240×760 화면을 캡처해 프리셋 목록과 좌우 결과를 확인했다. `warp-wide-final.png`, `warp-narrow-final.png`를 같은 갤러리에 보존했다.

최종 `npm run check`는 178.95초에 통과했다 (`.tmp/activity-width-warp-final-check.log`). 6,982개 테스트 통과, 4개 skip. 기존 coverage floor, typecheck, lint, 실제 build, page artwork parity, image protocol smoke를 모두 통과했다. 실제 AI 추론을 새로 완주한 검증은 포함하지 않는다. 임시 renderer QA 진입점은 정리했고 캡처와 갤러리는 보존했다.

## 전체 앱 후속 확인

장시간 모델 작업은 실행하지 말라는 사용자 요청을 반영했다. 잠금 중첩 순회를 제거하고 선택 페이지 이동·진행 갱신에 따른 잠금 집합과 파생 값 재생성을 줄였다. 실제 App의 30/500페이지, 제어된 진행 이벤트, B 페이지 편집·자동 저장을 배포용 profiling 빌드로 확인했다. 수치와 검증 한계는 [추가 측정 기록](optimization-measurements-2026-09-20.md#전체-앱-후속-측정)에 남겼다.

720×450 CSS viewport에서 패널이 떠 있는 형태로 바뀌면 grid 자동 배치 때문에 캔버스가 52px 열로 밀리는 결함을 발견했다. 좌·중앙·우 열을 명시해 수정하고 넓은/좁은 화면 및 좌측·양쪽 패널을 펼친 확대 화면을 확인했다. 기존 좁은 화면의 패널 겹침과 열기/닫기는 유지한다. `.tmp/responsiveness-final/index.html`에 수정 전후 원본과 썸네일을 보존했다.

후속 최종 `npm run check`: **292.14초 통과, 6,984개 테스트 통과·4개 skip**. 타입·lint·기존 coverage floor·build·page artwork parity·image protocol smoke·bundle 경계 모두 통과했다 (`.tmp/responsiveness-final/check-confirmed.log`). 새 잠금/파생 값 회귀를 포함한 focused 6파일 32개 테스트와 변경 파일 Impeccable detect도 통과했다. 임시 QA 소스와 벤치마크 테스트는 제거했다. 브라우저 프로세스는 종료했으며, 임시 브라우저 프로필 디렉터리 삭제는 자동 승인 정책에서 차단되어 남겼다. 사용자 보관함과 출력물은 건드리지 않았다.

v2.7.12 커밋·릴리스 요청을 받은 뒤 위 두 QA 폴더의 PNG와 갤러리 35개를 커밋 직전에 정리했다. 측정 JSON·재현 소스·검사 로그는 보존했다. 버전을 올린 뒤 전체 검사와 고정 Hugging Face 자산 36개 검증을 다시 통과했다. Windows·macOS 패키지와 설치/실행 검증은 정식 릴리스 워크플로에서 수행한다.
