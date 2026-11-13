# MCP 작업 기록 v2 및 500장 등록 (#176)

## 적용 범위와 데이터 권위

기준은 `origin/master`의 `b136b586`이며 작업 브랜치는
`codex/issue176-job-storage-v2`다. 버전 발행·배포는 포함하지 않는다.
`McpOperationService`가 권한, 요청 중복 판정, 실행과 취소를 계속 소유한다.
`McpJobStore`는 작업별 암호화 저장, 복구, 정리만 담당한다.
보관함 변경 이력, 가져오기 영수증, 출력 영수증과 native transaction은
기존 저장소의 권위다. 작업 기록만으로 실제 페이지·출력의 완료를 추정하지 않는다.

## 저장 계약

```text
mcp-private/
  jobs.enc                              # 암호화된 작은 v2 루트 포인터
  jobs-v2/<generation>/
    receipts/<jobId 첫 2자리>/<jobId>.enc # 작업의 커밋 지점
    details/<jobId>/<revision>/
      manifest.enc
      000.enc ...
  legacy-jobs/<원본 SHA-256>.enc
```

루트에는 전체 작업 목록이나 개수가 없다. ID와 revision은 앱이 생성하고
UUID schema로 검증한다. receipt는 소유자·요청 ID·kind·기존 fingerprint·상태·시각·
증가 revision과 상세 참조만 포함한다. 상세 참조는 manifest 암호화 bytes의
SHA-256과 평문 전체 byte size를 포함한다. 커지는 배열은 상세에만 둔다.

요청과 결과 상세는 각각 최대 8MiB의 UTF-8 JSON이다. 평문 bytes를 512KiB씩
분할하고 Base64 envelope를 기존 OS 암호화로 보호한다. chunk 파일은 암호화 및
외부 Base64 인코딩 후 1MiB 이하, receipt와 manifest는 64KiB 이하다.
`carrot-job-v2` domain, 데이터 프로필, generation, job ID, 요청/결과 종류,
revision, chunk 번호를 모두 결합한다. manifest는 순서별 크기·해시와 전체
평문 해시를 검증한다. 파일 크기는 읽기 전과 후 모두 검사한다.
인증·설정 및 retained-data의 기존 파일 제한은 변경하지 않는다.

상세 revision은 불변이다. 요청 저장 → running receipt 교체가 성공한 후에만
executor가 시작한다. 완료는 새 결과 상세 → 최종 receipt 교체 순서다.
외부에는 최종 receipt 저장 후에만 완료가 표시된다. 취소 요청은 receipt만
갱신하고 실제 종료는 executor와 native cleanup이 끝난 뒤 기록한다.
현재 작업 하나의 갱신이 다른 작업을 읽거나 다시 저장하지 않는다.

## 조회와 수명

시작 시 작은 receipt만 순차 읽어 작업·요청·소유자 색인을 만든다. 복원된
running 작업만 interruption 처리를 위해 상세를 읽으며 자동 실행하지 않는다.
종료된 작업 상세는 조회·재시도·출력 연결 시 읽는다. 목록은 기존 정렬과
offset/limit을 유지하고 선택한 페이지의 상세만 읽는다.

상세 LRU는 직렬화된 평문 32MiB 예산이다. 실행 중 상태는 별도 live map에 있고,
현재 호출의 반환 데이터는 캐시 퇴거로 무효화되지 않는다. 색인은 보존 중 작업
수에 비례한다. 전체 작업 수·전체 파일 용량의 고정 상한은 없다.
캐시 퇴거는 재시작이 아니다. 세션 전용 URL·관찰·제안은 기존 정책대로만
메모리에 존재하며 영속 파일에 추가하지 않는다. 세션 결과는 기존 최근 계층과
같은 최대 512건 범위이며 영속 상세 캐시와 분리한다.

종료 시각 + 7일에 상세와 중복 보호가 만료된다. 조회·재전송으로 연장하지 않는다.
실행 중에는 만료가 없다. 시작, admission, 10분 timer에서 만료를 검사하고
한 배치 128건마다 이벤트 루프에 양보한다. receipt를 먼저 제거한 후 상세를
지우고 검증된 빈 디렉터리만 제거한다. 이미 만료된 ID는 새 요청으로 재사용할 수
있으며 정리 실패로 남은 만료 기록이 새 보호 기록을 덮거나 제거하지 않는다.

정리는 파일별 경로·링크·암호화 binding·해시를 검사한다. 부분 삭제 후에도
남아 있는 manifest로 정리를 재개할 수 있게 manifest를 마지막에 삭제한다.
알 수 없는 파일, 변경된 파일, 정션/심볼릭 링크, 검증 근거가 없는 미완성
revision/generation은 보존하고 진단한다. 사용자 library·원본·출력은 정리하지 않는다.

## 마이그레이션과 오류 복구

기존 데이터 루트 단일 인스턴스 잠금 안에서 v1 전체 schema·ID·참조를 검증한다.
원본 암호화 bytes는 SHA-256 이름으로 복사하고 재독 검증한다. 새 generation에
각 기록을 만들고 재독하여 원본과 비교한 뒤 마지막에 루트만 v2로 교체한다.
`compacted`라는 표시만으로 기존 요청·결과를 더 줄이거나 버리지 않는다.
기존 fingerprint와 job ID는 그대로 유지한다. backup은 전환 후 7일 뒤 원래
해시가 일치할 때만 제거한다.

전환 중 루트가 v1이면 v1만 권위이고, 루트가 v2이면 v2만 권위다. 손상 시
legacy 자동 fallback이나 초기화를 하지 않는다. 구버전 v1 parser는 v2 루트를
거부한다. 지원 복구는 v2 지원 앱으로 다시 실행하는 것이며 downgrade 자동 복원은 없다.

| 실패                             | 동작                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| 최초 상세/receipt 저장 실패      | executor 미실행, 수락 실패                                              |
| receipt 커밋 후 응답 유실        | 같은 owner/request ID 및 정확히 같은 kind·입력은 같은 job 반환          |
| 실제 작업 후 최종 기록 저장 실패 | 현재 런타임 쓰기 중단, 결과 불확실성 표시, 자동 재실행 금지             |
| 최종 커밋 전 프로세스 종료       | 재시작 시 interrupted; 명시적 검토 필요                                 |
| 상세 누락/손상                   | `job_detail_unavailable`, 중복 보호 유지; 다른 정상 작업 개별 조회 가능 |
| 목록 페이지 안의 상세 손상       | 조회 오류; 손상 작업을 숨기지 않음                                      |
| 루트/receipt 손상                | 신규 admission 중단, 원본 보존                                          |
| ENOSPC/EDQUOT                    | 기존 `storage_full` 진단 유지                                           |
| 만료 정리 실패                   | 파일 보존·진단·다음 pass 재시도                                         |

소유자가 다르거나 같은 ID에 다른 입력을 보낸 경우 실행하지 않는다. 상세를 읽지
못하는 경우 새 요청으로 간주하지 않는다. 공간·권한·손상 원인을 해결한 뒤
재시작하여 커밋된 기록을 읽어야 한다. 오류를 피하려고 새 request ID로 동일 작업을
반복하면 원래 작업의 부작용이 중복될 수 있다.

## 500장 등록

`mcpImportLimits.ts`의 공통 계약은 요청 합계 500장·10챕터다. 단일 챕터 500장을
자동 분할하지 않고 검토된 구분과 순서를 유지한다. 501장은 저장 전에 거절한다.
일반 이미지·기존 지원 archive, 일괄 등록, 작품 파일 신규/추가, 중복 원본 identity,
매핑과 retained 영수증의 검증에 같은 값을 사용한다. 매핑 의미와 버전은 그대로다.

파일당 128MiB, 경로별 preview/extract 합계 256MiB, 작품 파일 2,000 entry 제한은
그대로다. 삭제·내보내기·이미지 검토·OCR/번역 및 composite의 50장 작업 예산은
올리지 않았다. 500장 가져오기를 composite에 연결하면 native import 실행 전에
명시적으로 거절한다. 챕터·source identity·영수증·batch 상태는 기존 native
transaction의 동일 커밋 지점에서 게시된다.

## 검증 및 측정

- 실제 파일 adapter: 최초/최종 상세·receipt 쓰기 실패, v1 전환 중단, 구버전
  거절, 손상 상세 및 running 복구, 타 작업 chunk 교환, 변경 receipt 보존,
  정리 중단/재개, unknown 파일·정션 보존, TTL, 페이지 한정 조회와 LRU 퇴거.
- 실제 native importer: 일반 이미지 500장, ZIP 500장, 작품 파일 신규 500장,
  기존 작품에 추가 500장, 첫/중간/마지막 페이지 및 전체 매핑, 재시작 재전송.
  250번째 이미지 검증 실패 시 챕터·영수증이 모두 롤백됨을 확인한다.
- 실제 Electron `safeStorage`: 격리 프로필에서 500장 등록 → 암호화 저장 →
  세션 재구성 → 동일 요청 재전송. 같은 job/receipt이며 챕터가 중복되지 않는다.
  실행 artifact: `.tmp/issue176-native.cjs`, `.tmp/issue176-native3.txt`.
- 규모 시험: `$env:MGT_MCP_JOB_SOAK='1'; npx vitest run tests/mcpJobStoreV2Scale.test.ts`.
  OS 암호화 port에는 인증 암호화 fixture를 연결하고 production 파일 adapter를
  사용한다. 실제 OS 암호화는 위 Electron 시험으로 별도 검증한다.

2026-11-13 Windows 규모 시험은 10,000건, 50,002파일, 146,760,416 bytes
(약 139.96MiB)를 기록했다. 병렬 전체 검사가 함께 돌던 실행의 저장 시간은
450.54초, receipt 색인 시간은 44.90초, 측정 시 heap은 99,886,792 bytes,
RSS는 220,332,032 bytes였다. 프로세스 메모리는 테스트 runner 포함이며
앱의 순수 색인 메모리나 성능 보장 수치가 아니다. 시간 assertion 대신
상세 chunk를 읽지 않는 시작, 작업별 I/O 범위, 32MiB 캐시 예산을 검사한다.
정량 artifact는 `.tmp/issue176-job-scale.json`에 남긴다.

새 파일의 최초 coverage 출처는 `.tmp/issue176-initial-coverage-summary.json`,
SHA-256은 `3de2b534d7dd07ac0a60041b93cf613fa10273de789b91c6bcbcec4da33eb585`다.
기존 coverage floor와 전역 dependency budget은 낮추지 않는다. 기존 durable
storage/hash 및 typed error의 직접 재사용에 필요한 파일별 실측 consumer 수만
갱신한다. 내장 채팅과 외부 MCP는 기존 `McpLocalHost`의 작업 서비스 하나를 계속 공유한다.

최종 `npm run check`는 테스트 11,675개 통과·10개 건너뜀으로 성공했다.
기존 870개 파일과 introduced 1,631개의 보호 coverage gate도 통과했다.
전체 coverage는 lines 87.48%, statements 86.26%, functions 88.54%, branches
79.98%다. 별도의 `npm run build`도 성공했으며 최종 빌드의 실제 Electron에서
500장 등록·세션 재구성·동일 요청 재전송과 512KiB를 넘는 상세의 OS 암호화
분할 저장·재독을 모두 확인했다. 최종 로그는 `.tmp/issue176-final-check.txt`,
`.tmp/issue176-final-build.txt`, `.tmp/issue176-final-native.txt`에 있다.
