# Bug Hunter 전수 탐색 재개 기록 — 2026-09-08

사용자 요청으로 전수 탐색을 중단했다. 기준 커밋은 `192fb4f66d9538cf10e04fa361a8bfaccf13e838`이며, 직접 전체 읽기가 기록된 고유 코드 파일은 **1,053 / 2,265개**, 전역 미검토는 **1,212개**다. 전체 감사 완료 또는 무결 판정이 아니다. 확정된 **39건의 수정 상태와 검증 근거**는 [bug-hunter-2026-09-08-fixes.json](bug-hunter-2026-09-08-fixes.json)에 별도로 기록한다. 탐색 커버리지와 수정 완료 상태를 혼동하지 않는다.

체크포인트 시각은 `2026-09-08T13:42:24.010Z`다. 감사 제어 파일의 기존 `IN_PROGRESS` 상태는 그대로 보존했다. 이 문서 작성으로 제어 상태를 변경하거나 탐색을 재개하지 않았으며, 추가 탐색은 다음 사용자 요청을 받은 뒤 진행한다.

정확한 미검토 목록은 [bug-hunter-2026-09-08-remaining.json](bug-hunter-2026-09-08-remaining.json)의 `remainingFiles`에 저장했다. 1,212개 고유 저장소 상대 경로 각각에 `baselineSha256`과 `chunkId`가 있다. `queueSnapshot`에는 모든 162개 chunk의 당시 상태와 배정·전역 읽기·잔여 개수를 보존했고, `metadataSources`에는 집계에 사용한 감사 산출물의 상대 경로와 해시를 기록했다.

| 큐 상태   | 개수 | Chunk                       |
| --------- | ---: | --------------------------- |
| `done`    |   45 | C001–C042, C044, C045, C162 |
| `partial` |    1 | C043                        |
| `pending` |  116 | C046–C161                   |

큐의 `done`은 감사 배정 완료를 뜻하며 버그 수정 완료와는 별개다. 다른 chunk의 승인된 확장 읽기가 겹칠 수 있으므로 큐 상태나 파일 수를 단순 합산하지 않는다. 고유 파일 집계의 권위는 `.bug-hunter/full-192fb4f6/coverage.json`, 당시 기준 해시의 권위는 `.bug-hunter/full-192fb4f6/source-hashes.json`이다. 확정 판정과 원 보고는 같은 디렉터리의 `referee.json`, `hunter-findings.json`에 있다.

C043은 root가 직접 읽었다고 전달한 첫 4개와, 배정 내 미확인 26개를 그대로 보존했다. 아래 목록은 기존 읽기 기록의 이전이며 이 문서 작성자가 새로 읽었다는 뜻이 아니다.

C043에서 전체 읽기가 기록된 4개:

- `src/renderer/src/app/session/applyGatherTextFormatRequest.ts`
- `src/renderer/src/app/session/applyTranslatedTextUpdates.ts`
- `src/renderer/src/app/session/AppSessionView.tsx`
- `src/renderer/src/app/session/appSessionViewModel.ts`

C043 배정 내 미확인으로 기록된 26개:

- `src/renderer/src/app/session/buildPanelSyncState.ts`
- `src/renderer/src/app/session/createAppOverlayProps.ts`
- `src/renderer/src/app/session/createConditionalBatchEditorProps.ts`
- `src/renderer/src/app/session/createGatherTextProps.ts`
- `src/renderer/src/app/session/createModalCloseActions.ts`
- `src/renderer/src/app/session/createOriginalImageOpacityProps.ts`
- `src/renderer/src/app/session/createPanelBlockActions.ts`
- `src/renderer/src/app/session/createRightRailProps.ts`
- `src/renderer/src/app/session/createStylePresetDeleteAction.ts`
- `src/renderer/src/app/session/createStylePresetSaveAction.ts`
- `src/renderer/src/app/session/createTranslationModalProps.ts`
- `src/renderer/src/app/session/createWorkspaceProps.ts`
- `src/renderer/src/app/session/createWorkspaceViewProps.ts`
- `src/renderer/src/app/session/jobTargetLocks.ts`
- `src/renderer/src/app/session/panelCommandDispatcher.ts`
- `src/renderer/src/app/session/sessionRenderBoundaries.ts`
- `src/renderer/src/app/session/useAppSessionCommandController.ts`
- `src/renderer/src/app/session/useAppSessionCoreState.ts`
- `src/renderer/src/app/session/useAppSessionDerivedState.ts`
- `src/renderer/src/app/session/useAppSessionInpaintingController.ts` — C013 확장 읽기 완료; 전역 미검토에서는 제외
- `src/renderer/src/app/session/useAppSessionLifecycleEffects.ts`
- `src/renderer/src/app/session/useAppSessionShortcuts.ts`
- `src/renderer/src/app/session/useAppSessionUiState.ts`
- `src/renderer/src/app/session/useAppSessionWorkspaceHistory.ts`
- `src/renderer/src/app/session/useChapterSessionController.ts`
- `src/renderer/src/app/session/useInpaintingController.ts`

위 26개 중 `src/renderer/src/app/session/useAppSessionInpaintingController.ts`는 `.bug-hunter/full-192fb4f6/chunks/C013-coverage.json`의 `extensionFullyRead`에 이미 기록돼 있다. 이전 감사의 상속 읽기가 아니라 C013 확장 읽기다. 따라서 C043 로컬 기록은 **4 / 26**으로 유지하고, 중복을 제거한 전역 미검토 목록에 속하는 C043 파일은 **25개**로 계산한다. 나머지 큐에 속한 전역 미검토는 1,187개다.

다음 요청에서 재개할 순서:

1. 이 기준 커밋과 현재 작업 상태를 먼저 비교한다. `git diff --name-status 192fb4f66d9538cf10e04fa361a8bfaccf13e838 HEAD`로 커밋된 차이를 확인하고, `git diff --name-status --cached`, `git diff --name-status`, `git ls-files --others --exclude-standard`로 staged·unstaged·신규 파일도 확인한다. 변경·신규·삭제·이동 파일은 기존 미검토 큐와 구분한 **delta 검토를 먼저** 수행한다. 이 문서 작성 중에는 해당 소스 차이 검토를 실행하지 않았다.
2. 기존 baseline commit, `.bug-hunter/full-192fb4f6/source-hashes.json`, 이 스냅샷의 baseline hash를 덮어쓰지 않는다. 수정 후 해시와 비교 기준은 별도 delta 산출물에 기록하고 이전 기준과의 연결을 남긴다. 삭제·이동된 경로도 제거됐다는 이유만으로 읽기 완료로 바꾸지 않는다.
3. 기존 `fullyRead` 파일이 기준과 동일하면 종전 읽기 크레딧을 이어받는다. 해시 확인만 한 파일이나 변경 없는 파일을 새로 재검사한 수에 더하지 않는다. 반대로 수정된 기존 읽기 파일은 delta 범위에서 다시 검토해야 하며, 과거 읽기 기록으로 새 내용을 검증했다고 보지 않는다.
4. delta 검토 이후 현재 트리에 적용되는 `remainingFiles`부터 이어간다. C043은 로컬 26개를 무조건 다시 읽는 대신 전역 잔여 25개와 delta 결과를 기준으로 처리한다. 다른 pending chunk에서도 이미 승인된 확장 읽기와 겹치는 경로를 중복 집계하지 않는다.
5. 실제 전체 본문을 받아 읽고 분석한 파일만 `fullyRead`로 올리고, 부분 읽기와 미확인은 분리한다. 확정 39건의 수정·회귀 검증 기록은 탐색 커버리지와 별도로 관리한다. `remaining.json`에 남긴 39개 finding ID 자체는 상태를 담지 않으며, 각 수정 상태는 `fixes.json`으로 확인한다.

미검토 목록은 기존 감사 메타데이터를 집계한 스냅샷이다. 이후 확정 결함을 고치며 읽은 코드나 회귀 테스트를 실행한 사실을 전수 탐색의 새 완료 수로 올리지 않는다. 다음 담당자는 위 세 문서와 현재 diff를 함께 읽고, 수정 검증과 미검토 탐색을 각각 이어간다. 모든 공개 경로는 저장소 상대 경로다.

## 확정 결함 수정 후 검증

2026-09-09 KST에 확정 39건의 수정과 전체 `npm run check` 26단계가 통과했다. 732개 테스트 파일에서 6,175건 통과, 기존 2건 제외이며, 기존 커버리지 기준을 낮추지 않았다. 빌드, 실제 화면/출력 이미지의 픽셀 동일성 2건, 288자 긴 경로 이미지 프로토콜 스모크도 통과했다. 검증 시각·단계·수정 소스 SHA-256은 `fixes.json`의 `finalValidation`에 있다. 이후 소스가 바뀌면 해당 기록을 현재 내용의 검증으로 간주하지 않는다.

별도 사용자 요청인 노트북 로그·CPU AOT 초기/권장 설정·DirectML 임시 폴더 수정은 [laptop-cpu-log-2026-09-09.md](laptop-cpu-log-2026-09-09.md)에 기록했다. 번역문이 이미지에 보이지 않는다는 신고는 표시 상태 확인 답변이 없어 미확정으로 남았다. 모델/자산을 바꾸지 않고 실제 네이티브 글꼴 테스트의 공유 빌드 폴더 경합도 고유 임시 자산 사본으로 격리했다. 이 추가 검증으로 전수 탐색의 읽기 수를 늘리지 않았다. 커밋·푸시·릴리스는 이 검증 기록에 포함되지 않는다.
