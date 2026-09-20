# 반응성 최적화 실측 — 2026-09-20

사용자 원본과 보관함은 사용하지 않고 격리 데이터로 측정했다. 모델 실행 잠금, 저장 revision 검증, transaction publication, 공개 IPC와 저장 형식은 유지했다. Impeccable optimize 절차로 병목을 확인한 뒤 수정했다.

## 이번 변경과 수치

| 재현 조건                                       |               변경 전 |            변경 후 | 변경 내용                                                                     |
| ----------------------------------------------- | --------------------: | -----------------: | ----------------------------------------------------------------------------- |
| 관리 작업 진행률 1,000회, 같은 단계             |          전달 1,000회 |           전달 1회 | main registry에서 기존 job과 같은 32ms 주기로 전달. 내부 snapshot은 즉시 갱신 |
| 30페이지 목록, 180프레임 동안 1px씩 스크롤      | 182 commits / 831.5ms |  2 commits / 0.3ms | 가상화하지 않는 목록은 스크롤로 React 상태를 변경하지 않음                    |
| 500페이지 목록, 같은 스크롤                     | 187 commits / 585.2ms | 10 commits / 7.4ms | 실제 표시 행 범위가 바뀔 때만 갱신, sortable ID 배열 재사용                   |
| 저장 응답 반영, 30페이지 × 20블록               |                 7.6ms |              0.6ms | 변경되지 않은 동일 페이지 객체의 revision 재해싱 생략                         |
| 저장 응답 반영, 500페이지 × 20블록              |                94.5ms |              0.5ms | 같은 최적화와 페이지 ID 조회의 중첩 순회 제거                                 |
| 검수표 900행, 실제 파일 transaction의 쓰기 잠금 |               149.5ms |      120.8–131.6ms | 페이지별 한 번만 블록 배열 반영·완료 상태 재검사                              |
| 검수표 15,000행, 같은 조건                      |             1,078.0ms |      542.6–608.3ms | 행마다 전체 페이지를 복사하던 경로 제거                                       |

수치는 이 PC에서 측정한 개별 실행값이며, 모든 작업이 이 비율만큼 빨라진다는 뜻은 아니다. 저장 응답 측정은 renderer의 응답 병합 구간이며 디스크 저장 전체 시간이 아니다. 동일한 정식 블록 필드를 갖는 fixture로 HEAD의 변경 전 hook 복사본과 현재 hook을 각각 실행했다. 임시 baseline 파일은 앱에서 참조하지 않았으며 측정 후 제거했다.

페이지 내용만 갱신될 때 사용자가 스크롤한 위치를 선택 페이지로 강제로 되돌리던 동작도 수정했다. 선택 변경·순서 변경·목록 크기 변경 때의 선택 항목 노출은 유지했다.

## 함께 확인한 경로

- 캔버스: 실제 `OverlayBlockLayer`, 20블록으로 확대 30회·이동 preview 30회·한 블록 문구 변경 20회. 확대/이동 중 추가 글자 측정 0회. 문구 변경은 실제 레이아웃을 재계산. 각 구간에서 50ms 이상 long task 0회.
- 페이지 탐색: 30/500페이지의 서로 다른 위치 20회 선택을 실제 Chromium에서 실행. 선택이 노출되고 long task 0회. 탐색 render time은 실행마다 변동해 속도 개선 수치로 제시하지 않는다.
- pan/wheel 입력: 기존 frame 묶음 처리 및 단축키 우선순위 회귀 테스트. 이미 한 프레임으로 묶이는 경로는 변경하지 않았다.
- 블록 편집: 기존 이동 preview의 레이아웃 재사용, resize 대상만 재측정, 저장 중 추가 편집·실패·재시도·페이지 변경 계약 검증.
- 가져오기/내보내기: 기존 이미지 준비는 publish 잠금 밖, 공유 export는 snapshot 읽기 보호 및 artifact retention을 사용함을 확인. 이 보호는 유지했다.
- 보관함: 기존 조회 요청 합치기와 원자적 publication 읽기 경계를 확인. 전체 보관함을 영구 캐시하거나 파일 검증을 생략하지 않았다.
- 이벤트: 일반 job의 IPC 묶음 처리/완료 checkpoint 보존, 관리 작업의 동시 ID별 타이머·취소·실패·완료·동일 ID 재사용을 검증.
- 잠금: 모델 독점과 A 페이지 처리/B 페이지 편집의 활동 자원 경계 및 async owner 보존 회귀 테스트.

검수표의 parsing·최신 데이터 읽기·검증·파일 publication은 여전히 기존 쓰기 경계 안에 있다. 잠금 범위를 추측으로 해제하지 않고 그 안에서 확인된 중복 계산을 줄였다. 모델 추론 속도, GPU 메모리 소비, 실제 사용자의 모든 원고 조합에 대한 성능 완료를 주장하지 않는다.

## 검증 자료

- 초기 focused regression: 13개 파일, 108개 테스트 통과. 추가한 스크롤 위치 회귀와 정식 저장 fixture를 포함한 재검증도 통과.
- `npm run check`: **전체 820개 파일, 6,955개 테스트 통과·4개 skip, 177.28초**. 타입·lint·아키텍처·coverage floor·실제 build·page artwork parity·image protocol smoke·bundle 경계를 모두 통과했다.
- 웹 가져오기 통합 테스트는 짧은 작업의 중간 진행이 완료 이벤트로 합쳐지는 계약에 맞춰, 내부 최신 snapshot·최종 진행값·미리보기와 cleanup 소유권을 검사한다. 검수표 무변경 재가져오기와 메타데이터 변경의 완료 상태 보존도 실제 파일로 확인했다.
- 변경 renderer 파일의 Impeccable detect: exit 0, 진단 출력 없음.
- 보관함 경로를 변경한 테스트는 임시 디렉터리만 사용했다. 기존 coverage floor는 유지하고 새로 변경한 `reviewImport.ts`만 원래 baseline에서 등록했다 (existing 760 / introduced 675 / deleted 10).
- 로컬 로그: `.tmp/optimization-save-comparison.log`, `.tmp/optimization-import-before.log`, `.tmp/optimization-import-after.log`, `.tmp/optimization-regression.log`, `.tmp/optimization-final-check.log`.
- QA fixture 보관: `.tmp/optimization-qa/`. production import를 사용하며 완전한 앱 통합 벤치마크를 대신하지 않는다. 임시 앱 엔트리와 baseline test는 제거했다. QA PNG와 미리보기 목록은 사용자 요청에 따라 최종 커밋 직전에 제거했다. 측정 기록과 로컬 로그는 유지한다.
