# MCP 복합 워크플로 인계

복합 워크플로는 사용자가 정한 페이지, 단계, 비용 한도 안에서 기존 네이티브 작업을 순서대로 연결하는 부모 기록입니다. 기존 1–10번 기능과 `carrot_prepare_workflow` 등 13개 워크플로 도구의 계약은 유지됩니다. 별도 작업 큐를 추가하지 않으며 기존 실행 엔진을 사용합니다.

게시된 소스는 커밋으로, 출력 산출물은 파일 영수증과 실제 바이트로, 현재 클라이언트의 수신은 그 연결에서 파일·이미지를 확인한 기록으로 판단합니다. 앱 연결과 도구 목록 갱신은 [Tailscale 연결 안내](mcp-tailscale-testing.md)를 따르세요.

## 공개 도구와 고정 작업 종류

복합 도구는 다음 15개입니다. 변경 요청의 공통 입력은 `{id, version, requestId}`이며, `id`와 `requestId`는 UUID입니다. `version`은 마지막으로 조회한 부모 버전입니다.

| 도구                                                | 역할과 추가 입력                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `carrot_preflight_composite_import`                 | 기존 가져오기 검토를 읽고 `{phaseId, action}`에 대응하는 대상 봉투 반환                              |
| `carrot_prepare_composite`                          | `requestId`, `reason`, `targets`, `phases`, `budgets`, 선택적 `maxReviewPasses`로 부모 준비          |
| `carrot_bind_composite`                             | 공통 입력에 `phaseId`, `action`, `expectedSnapshot`, `predecessorReceipts`를 추가하여 다음 단계 연결 |
| `carrot_run_composite`, `carrot_resume_composite`   | 공통 입력으로 다음 단계 하나를 명시적으로 시작                                                       |
| `carrot_get_composite`                              | `{id}`로 상태, 사용량, 단계와 자식 영수증 조회                                                       |
| `carrot_list_composites`                            | `offset`, `limit`, 후속 페이지의 `snapshot`으로 같은 소유자의 기록 조회                              |
| `carrot_pause_composite`, `carrot_cancel_composite` | 공통 입력으로 단계 경계 일시 정지 또는 소유한 자식 취소                                              |
| `carrot_reconcile_composite`                        | 공통 입력으로 이미 접수된 정확한 네이티브 시도의 결과 대조                                           |
| `carrot_get_composite_review`                       | `{id, phaseId}`와 페이지 인자로 발급 증거·판정·발견 사항 조회                                        |
| `carrot_get_composite_review_image`                 | `{id, phaseId, evidenceId}`로 이미 발급된 실제 PNG 수신                                              |
| `carrot_submit_composite_review`                    | 공통 입력과 아래 검토 보고서 필드로 연결 AI의 판정 제출                                              |
| `carrot_get_composite_native_review`                | `{id, offset, limit, snapshot?}`으로 선택 페이지의 저장 메타데이터 점검                              |
| `carrot_discard_composite`                          | `{id, confirm:true}`로 정리까지 끝난 부모 기록 폐기                                                  |

목록과 발견 사항은 응답당 최대 25개입니다. 다음 페이지에는 해당 응답의 `snapshot`을 사용하며, 부모의 64자리 `snapshot`과 목록 페이지용 스냅샷을 혼용하지 않습니다. 정확한 필드는 [입력 스키마](../src/shared/mcpCompositeWorkflow.ts)와 [조회 스키마](../src/shared/mcpCompositeWorkflowOutputs.ts)가 기준입니다.

`action`은 `{kind, input}` 형태이며 `kind`는 아래 19개 중 하나입니다. `input`에는 해당 기존 도구의 실제 검토·제안·작업 식별자와 동의 필드를 넣습니다. 문자열 도구 이름이나 임의 JSON 실행 인자로 바꿀 수 없습니다.

| 분야                     | 허용되는 `kind`                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------- |
| 가져오기                 | `import-create`, `work-file-import`, `import-batch-run`                            |
| 조사·문맥                | `research-run`, `context-apply`                                                    |
| 기존 번역 작업·선택 적용 | `workflow-run`, `selection-apply`                                                  |
| 타이포그래피             | `typography-analyze`, `typography-prepare`, `typography-apply`                     |
| 레터링                   | `lettering-prepare`, `lettering-apply`                                             |
| 효과음                   | `sfx-prepare`, `sfx-apply`                                                         |
| 출력                     | `images-export`, `work-file-export`, `zip-export`, `text-export`, `context-export` |

검토는 `{kind:"review", id}` 단계입니다. 네이티브 `action`으로 연결하지 않고 다음 단계가 되었을 때 `run` 또는 `resume`으로 실행합니다. 각 입력의 원래 스키마는 [작업 계약](../src/shared/mcpCompositeWorkflowActions.ts)에 연결되어 있습니다.

## 준비 → 연결 → 실행 → 조회

대상은 실제 저장 페이지의 `workId`, `chapterId`, `pageId`, `blockIds`로 지정합니다. `blockIds:[]`는 해당 페이지 전체를, 비어 있지 않은 목록은 이후 편집의 블록 범위를 뜻합니다. 페이지·챕터 범위는 그대로 고정됩니다.

아래 예시는 한 페이지의 번역 텍스트 출력입니다. ID는 실제 조회한 값으로 바꿉니다. `call(name, args)`는 인증된 MCP `tools/call`의 `structuredContent`를 돌려주는 클라이언트 측 래퍼이며 서버 도구 이름이 아닙니다. 네이티브 실행 요청 ID와 부모 변경 요청 ID는 각각 새 UUID로 생성합니다.

```js
const uuid = () => crypto.randomUUID();
const pages = [
  {
    workId: "work-id",
    chapterId: "chapter-id",
    pageId: "page-id",
    blockIds: [],
  },
];
let parent = await call("carrot_prepare_composite", {
  requestId: uuid(),
  reason: "선택한 한 페이지의 번역 텍스트 출력",
  targets: { kind: "saved", pages },
  phases: [{ kind: "native", id: "text", action: "text-export" }],
  budgets: { admissions: 1, pageAttempts: 1, models: {} },
});
const preview = await call("carrot_preflight_text_export", {
  chapterId: pages[0].chapterId,
  pageIds: [pages[0].pageId],
  options: { format: "txt", field: "translated", includeHeaders: true },
});
parent = await call("carrot_bind_composite", {
  id: parent.id,
  version: parent.version,
  requestId: uuid(),
  phaseId: "text",
  action: {
    kind: "text-export",
    input: { binding: preview.binding, requestId: uuid() },
  },
  expectedSnapshot: parent.snapshot,
  predecessorReceipts: [],
});
const runRequest = {
  id: parent.id,
  version: parent.version,
  requestId: uuid(),
};
await call("carrot_run_composite", runRequest);
parent = await call("carrot_get_composite", { id: parent.id });
```

`prepare`는 실행 없이 범위·정책을 검사하고 부모 메타데이터를 저장합니다. `bind`도 접수되지 않은 다음 단계만 연결합니다. 후속 연결의 `predecessorReceipts`에는 완료된 이전 단계의 `child` 객체들을 순서대로 넣습니다. ID만 적거나 대체 영수증을 구성하지 않습니다.

`run` 응답 뒤 `get_composite`로 `running` 종료와 `phases[].outcome`을 확인합니다. 후속 단계도 명시적으로 연결·실행합니다. `resume`은 같은 접수 경로이며 `held`, `cancelled`, 검토 대기를 해제하지 않습니다. 전송 결과가 불확실하면 요청 전체를 그대로 재전송하거나 상태를 조회합니다. 같은 `requestId`에 다른 입력을 붙이지 않습니다. [컨트롤러](../src/main/application/mcpCompositeWorkflowService.ts)

## 가져오기 대상과 발행 증거

새 페이지 ID는 사전에 추측하지 않습니다. 기존 도구에서 소유한 이미지 가져오기 preview 또는 작업 파일 upload를 먼저 검토합니다. 작업 파일의 경우 `carrot_preview_work_file({uploadId})` 결과의 `snapshot`, `packageChapterId`를 사용하여 원래 `work-file-import` 입력을 만듭니다. 입력에는 `requestId`, `uploadId`, `snapshot`, `chapters`, `target`, `allowNativePreparation:true`, `acknowledgeV1Limitations:true`가 포함됩니다. 새 작업의 `target`은 `{mode:"new", title}`이고 append는 원래 목적지 검토 계약을 그대로 따릅니다.

```js
const targets = await call("carrot_preflight_composite_import", {
  phaseId: "import",
  action: importAction,
});
// prepare의 targets에 위 응답 전체를 사용합니다.
// 첫 phase는 {kind:"native", id:"import", action:importAction.kind}입니다.
```

이 preflight는 가져오기를 실행하거나 upload를 소비하지 않습니다. 반환된 `selectionFingerprint`, `itemKeys`, `maxChapters`, `maxPages`가 준비 범위가 됩니다. 실제 네이티브 발행 이후에만 원래 선택 항목과 실제 저장 페이지의 대응으로 `parent.targets`를 채웁니다.

발행 증거는 원본·작업 이미지 바이트, 페이지 revision, 블록 식별자뿐 아니라 실제 staged 작업·챕터 JSON, 효과음 검토 revision, 스타일 가이드와 챕터 메모리의 해시 또는 부재까지 고정합니다. 선택한 빈 챕터와 append 목적지의 기존 가이드도 포함합니다. 작업 제목, 페이지 이름·순서·구성, 문맥을 발행 뒤에 바꾸면 그 현재 상태를 새 권위로 채택하지 않습니다. 처음 페이지가 0개인 계획에서도 설정과 실제 폰트 환경이 고정됩니다.

갱신은 원래 발행 증거를 검증하고 현재 소스 재조회와 일치 여부를 확인합니다. 증거가 부족한 과거 영수증은 읽을 수 있지만 새로운 복합 가져오기 승인을 대신하지 못합니다. 변경 충돌은 명시적 `reconcile`에서도 그대로 검사합니다. 메타데이터 증거는 최대 22개 파일, 파일당 32MiB로 제한되며 저장하는 것은 경로 없는 해시입니다. [발행 검증](../src/main/libraryStore/importPublicationMetadata.ts), [대상 갱신](../src/main/mcp/mcpCompositeNativeImportedPages.ts)

## 비용 한도와 자식 완료

계획은 최대 32단계, 10챕터, 50페이지, 명시적 블록 ID 100개와 검토 1–3회를 허용합니다. 이 블록 선택 한도는 전체 저장 페이지의 블록 수를 잘라내는 규칙이 아닙니다. 부모 기록은 같은 프로필·소유자에게 7일간 보존되며 최대 1MiB, 기억하는 변경 요청은 최대 128개입니다.

`budgets.models`는 필수입니다. `{}`의 여섯 모델 한도는 모두 0으로 채워집니다. `ocr`, `translation`, `erase`, `typography`, `soundEffect`는 각각 최대 5000, `research`는 최대 30입니다. 일반 한도는 `admissions` 1–500, `pageAttempts` 0–500, `translationRequests`와 `selectedEdits` 0–5000, `researchAttempts` 0–30입니다. 선택 편집은 누적 페이지당 100개 한도도 적용됩니다.

서버는 네이티브 검토에서 비용을 산정하고 실행 전에 시도 식별자와 비용을 예약합니다. 네이티브·검토 단계 모두 접수 1회를 사용하며 검토는 페이지마다 `pageAttempts`를 사용하고 모델 단위는 사용하지 않습니다. `used`는 예약 누계입니다. 불명확한 사용량은 환불하지 않으며 `usageUnknown`을 확인합니다. 예산·단계·제공자 정책은 고정됩니다. [비용 정책](../src/main/application/mcpCompositeWorkflowPolicy.ts)

부모는 정확히 소유한 자식의 정리가 끝날 때까지 실행 소유권을 유지하며, 경합하는 워크플로·복합 단계의 접수는 `editor_busy`로 거부됩니다. `pause`는 현재 네이티브 작업이 저장까지 마친 뒤 경계에서 멈출 수 있습니다. `cancel`은 그 부모의 자식만 취소하고 정리를 기다립니다. 이미 저장된 부분 결과는 남으며 취소·부모 폐기는 Undo가 아닙니다. 권한 철회나 만료 뒤에도 이미 접수된 작업의 제한된 정리·결과 기록은 끝날 수 있고, 새 실행에는 현재 권한이 다시 필요합니다.

## 실제 PNG를 받은 뒤 검토 보고

검토 단계는 기존 `carrot_render_page_preview`로 선택 페이지 전부의 실제 PNG를 발급합니다. 긴 변은 최대 1600픽셀, PNG는 4MiB, 세션 캐시는 128MiB, 이미지 수명은 10분입니다. `get_composite_review`의 메타데이터를 읽은 뒤 각 `evidence.id`로 `get_composite_review_image`를 호출하여 MCP 이미지 콘텐츠를 실제로 받아 확인합니다. 조회는 새 렌더나 출력 파일을 만들지 않습니다.

각 이미지의 `sha256`, 페이지·phase·pass·revision, `pixelMapping`을 유지합니다. 조회와 보고 시에는 전체 부모 소스, 현재 설정·폰트, 이미지 권한과 가리기 상태를 다시 검사합니다. 관리 폰트의 증거는 `appManaged:"bytes-sha256"`, 시스템 대체 폰트는 `systemFallback:"native-render-pixels-only"`입니다. 대체 폰트 파일 바이트까지 검증했다고 기록하지 않습니다. [발급·조회 구현](../src/main/mcp/mcpCompositeNativeReview.ts)

아래는 선언된 검토 단계가 `awaiting-review`인 별도 예시입니다. `parent`는 최근 부모 조회, `review`는 `get_composite_review` 결과입니다. 모든 발급 이미지를 실제로 확인한 연결 AI의 `hostAssessment`를 제출하며, 선택 페이지가 정확히 한 번씩 포함되어야 합니다.

```js
await call("carrot_submit_composite_review", {
  id: parent.id,
  version: parent.version,
  requestId: uuid(),
  phaseId: "review",
  pass: review.evidence[0].pass,
  reviewerKind: "connected-ai",
  verdictOrigin: "host-reported",
  verdict: hostAssessment.verdict,
  assessments: review.evidence.map((e) => ({
    chapterId: e.chapterId,
    pageId: e.pageId,
    evidenceId: e.id,
  })),
  findings: hostAssessment.findings,
  findingsOverflow: hostAssessment.findingsOverflow,
});
```

판정은 `accepted`, `needs-correction`, `blocked`이며 발견 사항은 최대 250개입니다. 각 항목의 `chapterId`, `pageId`, 선택적 `blockId`, `category`, `severity`, `message`는 [보고서 스키마](../src/shared/mcpCompositeWorkflowReview.ts)를 따릅니다. `accepted`에는 blocking 항목이나 overflow가 있을 수 없습니다. 제출은 호스트의 평가를 기록하며 저장 페이지의 `reviewStatus`를 변경하지 않습니다. 서버의 이미지 발급·수신 확인을 AI가 내용을 정확히 이해했다는 보증으로 기록하지 않습니다.

수정은 미리 선언한 `role:"correction"` 네이티브 단계여야 하고, 앞선 `needs-correction` 판정과 뒤의 새 검토 단계가 필요합니다. 수정 입력도 매번 연결하며 기존 페이지·블록 범위와 남은 예산을 따릅니다. 검토 횟수 소진, `blocked`, 발견 사항 overflow, 같은 렌더·발견 사항의 반복 또는 진동은 `held`로 남습니다. 성공한 검토는 다음 일반 작업 전까지 아직 접수되지 않은 수정·추가 검토 꼬리를 건너뜁니다. [검토 정책](../src/main/application/mcpCompositeWorkflowReviewPolicy.ts)

## 중단 복구, 파일 전달, 권한

`partial`, `failed`, `cancelled`, `interrupted` 결과를 완료로 바꾸지 않습니다. `held`에서는 자식 영수증과 `stopReason`을 읽고 실제 결과를 대조합니다. `reconcile`은 같은 family·request·receipt의 증거만 확인하며 작업이나 렌더를 새로 시작하지 않습니다. 이미 접수된 단계는 재연결할 수 없습니다. 증거가 없거나 모호하거나 만료되었으면 보류 상태를 유지합니다.

재시작 뒤 `automaticResume:false`, `crossOwnerHandoff:false`가 유지됩니다. 과거 `running`은 조회 시 중단된 보류로 보이고, 세션에만 있던 구체적 네이티브 입력과 PNG 바이트는 복원되지 않습니다. 미접수 단계는 원래 입력과 여전히 유효한 네이티브 검토로 다시 연결합니다. 접수된 단계는 정리가 끝난 다음 명시적으로 대조합니다. 보존된 이미지 메타데이터만으로 만료된 이미지를 다시 받았다고 처리하지 않습니다.

부모 조회는 원시 작업 입력·경로·이미지·전달 URL을 제외한 메타데이터입니다. 출력 자식의 `child.id`로 `carrot_get_job_file({jobId})`를 호출하고, 페이지별 출력이면 `pageId`도 지정합니다. 보존 파일은 `carrot_get_output_file({id:retainedOutputId})`로 새 URL을 요청합니다. 실제 GET 바이트의 길이·SHA-256과 클라이언트에서 열리는지 확인합니다. 부모 완료나 HEAD 성공만으로 파일 수신을 선언하지 않습니다.

`zip-export`는 `{sourceJobId, requestId, allowPartial}`로 이전 출력 작업을 지정하며 `allowPartial:false`는 전체 완료를 요구합니다. 재시작 뒤에도 해당 보존 파일과 메타데이터를 대조하여 재렌더 없이 ZIP을 구성합니다. 출처·선택·영수증이 달라졌다면 대체하지 않습니다. 보존 ZIP 재조회는 동일 바이트의 새 URL 발급입니다. 작업 파일 출력에는 원본 이미지가 포함되며 기존 `acknowledgeOriginalImages`, `acknowledgeV1Limitations` 동의가 필요합니다. [출력 검증](../src/main/mcp/mcpCompositeNativeOutputs.ts)

공통 `carrot.read` 외에 계획에 선언한 기존 도구들의 `requiredScopes`를 준비 시 검사하고 계속 재검증합니다. PNG 수신에는 `carrot.images`도 필요합니다. 앱의 편집·처리·이미지 허용과 현재 가리기 설정이 함께 적용됩니다. 부모 기록이나 파일 영수증이 추가 권한을 주지 않으며, 임시 capability URL을 부모의 영구 메타데이터나 공개 전달 완료 기록으로 취급하지 않습니다. `get_composite_native_review`는 페이지 전체의 저장 메타데이터 우려를 보여 주지만 렌더, 모델 준비, 실제 이미지 전달, 번역 품질 또는 앱의 출력 preflight를 검사하지 않습니다.

## 격리 네이티브 수용 시험과 검증 근거

실제 시험 계획은 공개 가능한 1–2페이지 작업 파일을 독립 데이터 루트에 복사하고 다음 일곱 단계를 실행합니다. 모델 한도는 전부 0, `admissions:7`, `pageAttempts:14`, `selectedEdits:2`입니다.

| 단계 ID        | 동작                                                          |
| -------------- | ------------------------------------------------------------- |
| `import`       | 검토한 `work-file-import`로 새 작업 생성, 실제 발행 해시 확인 |
| `context`      | `context-apply`로 선택한 문맥 변경만 적용                     |
| `text`         | `text-export` 완료 후 실제 UTF-8 파일 수신                    |
| `review`       | 실제 PNG 수신·해시 확인 후 명시적인 fixture 호스트 보고       |
| `images`       | `images-export`의 각 페이지 파일 보존·수신                    |
| `zip`          | 세션 재구성 후 정확한 보존 출력으로 ZIP 구성                  |
| `working-file` | `work-file-export` 아카이브와 원본 보존 확인                  |

이어 같은 소유자의 재접속, 미접수 단계의 재연결 요구, 실제 취소 정리, 소스 변경 뒤 검토 거부, 다른 소유자·읽기 전용 연결 거부, 암호화 기록과 원본 보존을 확인합니다. [시험 본문](../scripts/mcp-native-composite.cjs)과 [단계별 구현](../scripts/mcp-native-composite-fixture.cjs)이 기준입니다. Fixture의 호스트 판정은 전달·출처 경계 시험이며 번역 품질 평가가 아닙니다.

### 초기 정적 검사 기록 — 최종 실행 전의 역사

아래 문단은 처음 인계 문서를 작성한 시점의 기록입니다. 현재 판정은 이어지는 통합 검증 표가 우선합니다.

작성 시점의 합성 r4 정적 검사에는 lint 오류 0개, TypeScript 3581 roots 진단 0개, checkJS 514 roots 진단 0개가 기록되어 있습니다. **이 일곱 단계의 실제 Electron 실행 결과, 최종 게시 커밋, 공개 산출물과 현재 클라이언트의 실제 수신 결과는 아직 기록 대기입니다.** 실행 후 동일 소스의 커밋·명령·환경·전체 결과·실제 파일 해시를 추가하고, 앞선 정적 성공을 실행 성공으로 대체하지 않습니다.

### 현재 통합 검증 기록

복합 워크플로와 13번 진단 구현은 게시된 소스에 포함됩니다. 최종 통합 수용 판정은 **PASS — implementation, full regression, fresh build, isolated native and six directly inspected production UI captures; actual user-client acceptance remains separate**입니다. 아래의 실행 결과는 실제 검사한 구현 SHA에만 연결하며, 이후 문서만 기록한 커밋을 새 검사 실행으로 표기하지 않습니다.

중간 근거로 `33469783740da4f5dfd6688979a6c8c1aed2b1ac`에서 13번의 다섯 파일 90개 검사가 통과했습니다. 같은 시점의 더 넓은 140파일 검사는 742개 중 740개 통과와 복합 문맥 출력 fixture 두 실패였으므로 전체 성공이 아닙니다. 저장 페이지의 잘못된 배경색 fixture를 고친 `0bb9547bd6d3b30d88c771b48fabce6d6be3e24a`에서는 해당 두 파일 9개가 통과했고 4,675개 소스 fingerprint가 일치했습니다. 이 좁은 결과를 일곱 단계 Electron 실행이나 전체 수용 시험의 결과로 확대하지 않습니다.

#### 등록 전 전체 V8 실측 — 성공 판정이 아닌 역사 기록

`0bb9547bd6d3b30d88c771b48fabce6d6be3e24a`의 선택 제한 없는 V8 측정은 2026-09-23 20:44:57 UTC에 330.047초로 끝났습니다. 1,229파일·전체 9,167개 중 9,155개 통과, **1개 실패**, 기존 보류 11개였습니다. 그중 복합 워크플로의 새 29파일 137개와 13번 5파일 90개는 모두 통과했습니다. 이 부분 집합을 전체 수에 다시 더하지 않습니다.

유일한 실패는 `productionCleanupCoverageGate`의 기존 등록 파일 763개와 실제 inventory 765개 비교였습니다. 종료 코드는 1이며 build/canonical 실행이 아닙니다. 4,675개 소스 fingerprint는 동일했고 coverage SHA-256은 `da61a9487b4e1a76b3470de5c6bdedf817f3b66830e04c8bc1eabbe3c277ca75`입니다. 등록 이후 전체 gate·build·native·UI 결과는 아래 최종 표에서 별도로 판정합니다.

같은 coverage artifact의 후속 native floor 감사에서는 **7개 소스 파일의 기존 지표 14개 미달**과 실측 등록 누락 65개도 확인했습니다. 기존 1,870개 행은 보존됐으며 floor를 낮추지 않았습니다. 측정 inventory는 existing 765 / introduced 1,170 / deleted 11개입니다. 테스트 보고서의 inventory assertion 한 실패와 이 추가 지표 미달은 각각 해결 근거가 필요합니다.

0bb의 실제 architecture 그래프는 2,500개 모듈·11,802개 의존 관계였고 layer/cycle 오류는 없었습니다. 검토한 22개 지표 budget 후보는 같은 저장 그래프의 기존 checker를 통과했지만 아직 게시된 등록이나 최종 canonical 통과가 아닙니다.

후속 `24a8e9b54bbde14e27a446b6ce8d996b208ff77f`는 테스트 7개 파일만 바꾸고 사례 6개를 보강했습니다. Production 소스와 기준값은 유지했습니다. 실제 Prettier/lint/TypeScript(3,537 roots)를 통과했고 좁은 7 suite 27/27 및 4,675개 소스 fingerprint 불변을 확인했습니다. 새 전체 V8 재측정을 시작한 상태이며, 이 좁은 통과만으로 기존 지표 14개가 회복됐다고 판정하지 않습니다.

24a의 후속 전체 측정은 2026-09-23 21:07:40 UTC에 324.641초로 완료됐습니다. 1,229파일·전체 9,173개 중 9,161개 통과, inventory assertion 1개 실패, 기존 보류 11개였습니다. coverage SHA는 `87bc01a2b429577c288e36e51fde38d7054788bf5fd87bdb644d348967f30e86`입니다. 실제 후속 floor 감사는 앞선 14개 중 11개 지표 회복을 확인했으며 `mcpLibraryImportSession.ts`의 lines/statements/branches 3개 미달을 남겼습니다.

`037fa1c4ecfcc5b8655d3cb1604af162c509f1d2`는 기존 selection 테스트에 28줄을 추가해 `assertJobAuthorized` 없는 직접 호출을 dialog·job·storage 앞에서 거부하는 경계를 검사했습니다. 21파일의 assertion 97개와 대상 네 metric floor는 통과했지만, 선택된 부분 coverage 프로세스의 종료 코드는 1이므로 전체 검증 성공이 아닙니다. Production 소스와 기준은 바꾸지 않았습니다.

037의 선택 제한 없는 전체 V8는 21:24:34 UTC에 323.813초로 끝났습니다. 1,229파일·전체 9,174개 중 9,162개 통과, inventory assertion **1개 실패**, 기존 보류 11개이며 종료 코드 1입니다. 새 복합 29파일 139개와 13번 5파일 90개는 모두 통과했고 4,675개 소스 fingerprint가 동일했습니다. Raw coverage SHA는 `8dfa06f43290ec555ca0771b2e75f58a6dfed0dbdf61316b72dbf689cd3a45f9`입니다. 이 시점에는 새 floor 감사와 등록 파일 네 개를 준비하고 있었으며, Vitest 실패가 inventory 한 건이라는 이유로 모든 기존 floor 회복을 확정하지 않았습니다.

#### ecab 등록 완료 — 최종 통합 수용과 분리

후속 037 coverage의 실제 native floor 감사는 기존 지표 14개 미달이 모두 정확한 비율 비교에서 회복됐음을 확인했습니다. 기존 1,870개 직렬화 행과 metadata·삭제 기록을 그대로 보존했고 실측 행 65개(existing 2 + introduced 63)를 추가했습니다. Inventory는 existing 765 / introduced 1,170 / deleted 11입니다. 기존 floor와 checker를 낮추지 않았으며, 이 감사 결과가 앞선 V8 프로세스의 종료 코드 1을 성공으로 바꾸지는 않습니다.

`ecab24ade4b4a3ec7027a01100edd3f470031ed7`에서 coverage manifest·inventory assertion·검토한 architecture 한도 22개와 [등록 근거](mcp-composite-gates-20260923.json)를 게시했습니다. 그래프는 0bb에서 실제 수집한 2,500개 모듈·11,802개 의존 관계·layer/cycle 오류 0개이며, 등록한 한도는 같은 그래프의 기존 checker를 통과했습니다. Production/collector 입력은 037을 거쳐 ecab까지 동일하고 등록 커밋은 scripts 2개·test 1개·근거 문서 1개만 바꿨습니다. 이를 새 그래프 수집으로 표기하지 않습니다. 이 등록 직후 체크포인트에서는 ecab의 canonical/build/native/UI 실행 결과가 아직 대기 중이었습니다. 후속 결과는 다음 기록에 보존합니다.

#### ecab canonical 완료 기록

같은 ecab 구현에서 `node scripts/check.cjs`의 26단계가 모두 종료 코드 0으로 통과했습니다(전체 368.304초). V8는 322.918초, 실제 1,229파일·전체 9,174개 중 9,163개 통과·실패 0개·기존 skipped 11개였습니다. 같은 소스의 build는 `cacheHit:false`로 14.475초에 통과했고 4,675개 소스 fingerprint가 일치했습니다. Canonical coverage floor 및 architecture 단계도 통과했습니다. 이 canonical 완료 시점에는 native 23 marker와 UI 여섯 화면의 직접 검토가 아직 남아 있었습니다. 후속 native 실패와 fixture 보정은 다음 기록을 따릅니다. 전체 stage·hash·report binding은 [최종 수용 근거](mcp-final-acceptance-20260923.json)에 보존합니다.

#### ecab native 실패와 격리 fixture 보정 기록

ecab의 성공한 build로 실행한 native 검사는 2026-09-23 21:52:03 UTC에 종료 코드 1, marker 16/23으로 끝났습니다. Wrapper timeout은 없었고 소스 4,675개 불변, 리스너 종료, 소유 Electron profile 제거와 native 임시 디렉터리 정리는 확인했습니다. 정리 성공이 기능 검증 실패를 성공으로 바꾸지는 않습니다.

원인은 편집기 없이 실제 `ActiveJobStore`를 만드는 격리 fixture가 CSV import의 page-edit handoff에 응답하지 않은 것입니다. `ddc43675872629560830b787d252dd6b0faed256`에 게시한 보정은 새로 가져온 fixture 장·페이지, 살아 있는 `mcp-edit` job, `finishing-edits` 요청과 편집기 부재를 모두 확인한 뒤 응답합니다. 이후 native source·revision·권한·저장 검증은 그대로 진행되고 실제 응답 및 job/handoff 정리를 단언합니다. 변경은 fixture script 3개이며 production 코드·모델·timeout·worker·fixture 크기를 바꾸지 않습니다. ecab 실패는 [수용 근거](mcp-final-acceptance-20260923.json)에 보존하고, 이 보정 게시 체크포인트에서 최종 표는 보정된 구현의 새 canonical/native/UI 결과를 기다렸습니다. 이후 ddc 실패는 다음 기록을 따릅니다.

#### ddc cold canonical 실패 기록

ddc의 cold canonical은 2026-09-24 05:25:27 UTC에 종료 코드 1로 끝났습니다(전체 542.115초). 계획한 26단계 중 20단계가 실행되어 19개가 통과했고 test-coverage가 실패했습니다. 실제 1,229파일·전체 9,174개 중 9,162개 통과, `mcpWorkDeletionStaging`의 최대 용량 복구·재검증 사례 1개가 기존 15초 제한에 도달했습니다(실측 15,004.7904ms). 기존 skipped 11개, test 단계 463.835초, 소스 4,675개 불변 및 report binding은 확인했습니다. 이 실행에서는 새 build·native·UI가 수행되지 않았습니다. 최대 용량과 모든 검증을 유지한 테스트 책임 분리를 검토 중이며 timeout·worker 한도를 늘리지 않았습니다. 실패 원본은 [수용 근거](mcp-final-acceptance-20260923.json)에 보존합니다.

#### 99cd의 테스트 책임 분리 게시

`99cd9cd822f034316f8c66011fb29d9d6c042bd4`는 기존 `mcpWorkDeletionStaging.test.ts` 한 파일에서 native staged 복구·ownership marker 재검증·게시와, 게시된 source 동등성·2,001번째 일반 항목 거부를 두 사례로 분리합니다. 두 번째 사례는 실제 첫 게시 완료를 기다립니다. 원래 준비 및 native 호출 순서, 2,000항목(디렉터리 1,999개와 metadata 1개), mkdir batch 50과 모든 용량 검증을 보존하고 전체 promise를 정리 전에 회수합니다. Production·worker 8개·사례 제한 15초·coverage/architecture 정책은 바꾸지 않았습니다.

실제 formatter/lint/TypeScript는 통과했고 선택한 두 assertion은 각각 9.2652801초와 1.9570836초에 통과했습니다. 선택 실행에 기존 전역·파일별 coverage 정책이 적용되어 프로세스 종료 코드는 1이며, 전체 coverage 수용이나 전체 실행 시간 개선으로 표기하지 않습니다. 다음 cold canonical은 게시된 99cd 소스에 연결하며 이 게시 체크포인트에서 최종 canonical/native/UI는 대기 중이었습니다.

#### 99cd canonical 통과와 native 실패 기록

99cd의 cold canonical은 26단계 모두 종료 코드 0으로 통과했습니다(전체 511.644초, test 411.742초). 실제 1,229파일·전체 9,175개 중 9,164개 통과·실패 0개·기존 skipped 11개였고, 같은 소스의 build는 cache를 끈 상태에서 16.155초에 통과했습니다. 소스 4,675개와 report binding이 일치했습니다.

이후 native 검사는 2026-09-24 05:51:21 UTC에 종료 코드 1, marker 20/23으로 끝났습니다. 11번 text/context exchange·delivery·saved-source 비교·approved sync marker 4개는 모두 통과했고, 복합 marker 2개와 최종 marker는 통과하지 못했습니다. Wrapper timeout은 없었고 소스 보존·리스너 종료·소유 profile/native 디렉터리 정리는 확인했습니다. 이 소스에서 UI는 실행하지 않았습니다. 복합 실패를 조사하던 이 체크포인트의 전체 canonical/native 원본을 [수용 근거](mcp-final-acceptance-20260923.json)에 보존하며, 정리 및 일부 marker 성공을 최종 native 통과로 표기하지 않습니다.

#### a4e6의 실행 중 관측 상태 보정 게시

99cd 로그의 첫 work-file-import child는 selection fingerprint와 item mapping을 가진 완료 결과를 남겼지만, parent의 durable 중간 체크포인트 `held/native-outcome`이 동일 소유 실행의 receipt/source refresh가 끝나기 전에 public get/list에 노출됐습니다. `a4e6ce9aef7e5b83100302692904039f6cc9aad9`는 완료된 다음 phase outcome과 동일 owner의 시작된 실행이 있는 동안 `McpCompositeWorkflowService.observe`의 반환용 복사본만 running으로 보여 줍니다. Durable checkpoint, 소유 실행이 없는 재시작, refresh 실패 및 제어 상태는 보존합니다. 변경은 service 1개와 기존 test 파일 2개이며 store·queue·timer·자동 재시작을 추가하지 않습니다.

실제 후보를 읽는 formatter/lint/TypeScript/maintainability/error-handling/mock-boundary 6개 정적 검사가 통과했고, 선택한 7파일의 assertion 39개가 모두 통과했습니다. 선택 coverage의 service 수치는 L119/144·S122/157·F25/27·B43/68이며, 기존 전체 실행 floor 통과가 아닙니다. 전역·파일별 coverage 부족으로 프로세스 종료 코드는 1입니다. 새 테스트의 준비 단계 lint/type 오류를 보완한 뒤 같은 production 보정을 게시했으며, 이 시점의 새 cold canonical/native/UI 결과는 아직 대기 중이었습니다.

99cd의 원래 실패와 cleanup AggregateError도 보존합니다. 로그가 개별 nested cleanup 오류를 펼쳐 출력하지 않았으므로 구체적인 server/session 종료 실패 원인을 확정하지 않습니다. 별도 cleanup 의미 변경이나 오류 억제는 적용하지 않았습니다.

#### a4e6 canonical 통과와 native 취소 보고 실패 기록

a4e6의 cold canonical은 26단계 모두 종료 코드 0으로 통과했습니다(전체 476.474초, test 381.578초). 실제 1,229파일 status가 모두 passed이고, assertion은 전체 9,177개 중 9,166개 통과·실패 0개·기존 skipped 11개입니다. 같은 소스의 build는 모든 cache를 끈 상태에서 13.160초에 통과했고 소스 4,675개와 report binding이 일치했습니다. 변경된 composite service를 포함한 전체 floor gate도 통과했습니다. 이 소스의 raw coverage SHA는 `eb2f1e0701d568748b7a13fdeae5453ade905a6fe89e3f443e3567b9af2402c0`입니다.

이후 native는 2026-09-24 06:27:17 UTC에 종료 코드 1, marker 20/23으로 끝났습니다. 이전 import/held 경계를 지나 복합 import·context·text·review·image·ZIP·working-file·restart/rebind·cancel·invalidate helper가 진행됐지만, 최종 fixture errors가 빈 배열이어야 한다는 단언에서 정상 취소 `AbortError` 1개가 관측됐습니다. 복합 marker 2개는 이 단언 뒤에 출력되므로 통과로 셈하지 않습니다. 소스 보존·리스너 종료·소유 profile/native 디렉터리 정리는 확인했고 wrapper timeout과 UI 실행은 없었습니다.

Stack의 `McpOperationService`는 취소 reason 생성 위치이고, 실제 오류 보고자는 정상 cancelled 결과를 반환하면서 자체 reason을 보고한 `McpExportBatchService.run` catch입니다. 이 체크포인트에서는 해당 batch 보고 경계만 보정하는 후보를 검토 중이었으며 OperationService나 전반적인 cleanup 오류 억제는 바꾸지 않았습니다. 이 a4e6 오류가 99cd의 알 수 없는 nested cleanup 원인을 밝혀 준 것으로 해석하지 않습니다. 원본 기록은 [수용 근거](mcp-final-acceptance-20260923.json)에 별도 보존합니다.

#### f375a37f의 batch 취소 보고 보정 게시

`f375a37f50b7ec5e9a655f9b63a791b2f0771bdc`는 `McpExportBatchService.run`의 보고 조건 하나와 기존 batch test 파일의 새 사례 4개만 변경합니다. 자체 operation signal이 aborted이고 예외가 그 signal의 reason과 동일한 객체일 때만 정상 취소로 보고에서 제외합니다. 다른 `AbortError`, cleanup `AggregateError`, 취소되지 않은 상태의 falsy 예외는 계속 보고합니다. Batch/page 결과·보존한 부분 출력·물리 정리·journal 복원·OperationService·native 오류 단언은 그대로 유지하며 timer·timeout·worker·coverage 기준은 바꾸지 않습니다.

후보의 실제 정적 검사 6개와 선택한 18 suite의 assertion 85개가 모두 통과했고 소스 4,675개는 불변이었습니다. Batch 파일은 L68/70·S72/74·F21/21·B49/52로 기존 네 floor를 넘었지만, 선택 실행에 적용된 전역·다른 파일의 coverage 부족으로 프로세스 종료 코드는 1입니다. 이는 전체 coverage 성공이 아닙니다. 게시 시점에 `.tmp/mcp-bundle12-f375a37f-20260924`의 새 cold canonical을 시작했고 native/UI는 실행 전이었습니다. 원본 게시·선택 검사 근거는 [수용 근거](mcp-final-acceptance-20260923.json)에 보존하고 최종 수용 표는 새 전체 근거가 완성된 뒤에 확정합니다.

#### 최종 통합 근거

| 검증 항목                                                 | 실제 결과                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 검증한 구현 전체 SHA                                      | `f375a37f50b7ec5e9a655f9b63a791b2f0771bdc`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 전체 canonical 단계와 종료 코드                           | PASS — `node scripts/check.cjs --cold`, 26/26 stages, exit 0; 458.451 s; completed 2026-09-24T06:52:57.795Z                                                                                                                                                                                                                                                                                                                                  |
| 전체 V8 파일·통과/실패/보류 수와 digest                   | PASS — all 1,229 physical files passed; 9,181 assertions = 9,170 passed / 0 failed / 11 inherited skipped; coverage SHA-256 `0b9d574fbd9dd8c8438bde764450ab2af10d218ad08236994c337ee2ee41f8de`                                                                                                                                                                                                                                               |
| 이전 coverage floor 보존과 실제 측정 추가                 | PASS — 1,870 inherited serialized rows/metadata/deletions preserved; 65 measured additions; inventory 765/1,170/11; all 14 earlier gaps closed; same-source canonical floor gate passed                                                                                                                                                                                                                                                      |
| 실제 architecture edge와 등록한 한도                      | PASS — 22 reviewed ceilings published at ecab from the saved 0bb graph (2,500 modules / 11,802 edges / 0 layer/cycle errors); same-source canonical architecture stage passed                                                                                                                                                                                                                                                                |
| 같은 소스의 build와 소스 불변 근거                        | PASS — same-source cold build, 13.882 s, `cacheHit:false`; exact build-step outcomes retained in acceptance evidence; PASS — 4,675 source fingerprints unchanged through canonical/native/UI; source/report digests, counts and Vitest stage timestamp binding verified                                                                                                                                                                      |
| 위 일곱 단계와 기존 native 경로, 총 23개 필수 marker·정리 | PASS — 23/23 required markers, child exit 0; actual native import/context/review/output/restart boundaries, listener closed, owned profile/native fixtures removed, source and originals preserved                                                                                                                                                                                                                                           |
| production UI 여섯 화면 캡처와 직접 열어 본 결과          | PASS — six actual production captures, each opened and reviewed; automated layout checks passed; owned entries/profiles/captures removed, no cleanup warnings. Initial wrapper port checks were Windows 10035/undetermined; separate later Node ECONNREFUSED and Windows listener-table observations resolved the same six targets without rerunning QA; original failed wrapper retained. Descendant PIDs were not independently enumerated |

실제 ChatGPT 연결의 도구 목록 갱신과 이미지·파일 수신, 사용자 원본의 번역/모델 품질, 실행 중인 앱의 재시작·재접속은 별도 사용자 수용 단계에 남습니다. fixture 호스트 보고는 평가 경계 시험이며 모델 품질의 정답 라벨이 아닙니다. 격리 시험의 다운로드 바이트·해시 일치는 현재 대화의 첨부 수신을 대신하지 않습니다. 이 문서는 사용자 앱 재시작이나 모델·계정 작업을 자동으로 시작하라는 지시가 아닙니다.
