# Astra 번역·식자 연구 — 씨육수

## 현재 권위

- 상태: discovery-001/002/003/004 퇴역·기각, 최초 잠금 6번 1/10 사용·기각. discovery-004 후보 4(v0.4.3)는 14쪽 실행·저장·보고와 최종/배경 28장 직접 검토를 완료했다. 104개 활성 대상 중 24개 원문 복원, 별도 판독 보류 1개로 검토 표시 25개다. 총 105블록 중 나머지 80개도 human gold가 아니다. Astra 109회, 누적 1,622,675 토큰, ImageGen 요청 영수증 77회(모두 사용량 unknown), 2시간 25분 28초. 생성 전경이 활성 상태로 남은 블록은 0개다. 원문 보존은 성공이 아니며 승격 없음. 상세는 `discovery-004/candidate-004/audited-report.html` 및 `direct-audit.json`.
- discovery-005 후보 1(v0.4.5)은 **실패 종료 및 실제 저장본 감사 완료**다. 2026-09-06T04:18:42.274Z 종료, Astra 30회/누적 979,154 토큰, ImageGen 요청 57회(모두 사용량 unknown). 배경 검수 2번째 묶음이 알려진 판독 보류 9곳을 보고하자 validator가 전체 실행을 중단했다. 최종 저장 블록/배경은 없고 원본 RGBA와 차이 0이다. 활성 172+보류 9=181곳 모두 최종 번역 실패이며 검토 블록 0개를 성공으로 세지 않는다. 실제 중간 배경 11개 네이티브 뷰, 마스크 172개, 서체 계열 18개/폰트 견본 4개를 직접 확인했다. 동결 파일 1,750개가 감사까지 같음을 확인했다. 이제 다음 구현을 진행하며 승격 없음.
- 사용자는 원문 전체 core + 바깥 feather의 국소 시각 품질을 “이정도면 합격임. 계속 진행해봐”라고 승인했다. `docs/astra-typesetting-feather-candidate.md`와 `mask-feather-user-acceptance.json`이 권위다. 같은 2개 원시 생성안을 재사용한 매개변수 실험 4회도 별도 개발 출력으로 세고 같은 화에서 추가 탐색하지 않는다. 필수 큰 ギロ에는 같은 매개변수 그대로 전이한 5번째 알려진 회귀 실험을 수행했다. 원문이 제거되고 그림 연결이 자연스러워졌지만 아직 앱 저장/찌릿 전경까지 완료한 것은 아니다. 새 ImageGen 0회, 최초 잠금 転生悪女 6번은 여전히 1/10.
- 기준 commit: `5a0dcb7304a36d4034b06bebf31216eae7b333e4`, branch `codex/astra-typesetting-20260905`.
- 추가 결함 수정: 후보 3 실행 중 확인한 회전 전경의 보존 영역 침범 누락은 후보 3 보고 완료 뒤 v0.4.3에서 수정했다. 실제 투명 출력의 잉크 범위를 보호 검사·실패 복원에 사용한다. 회전·왜곡·곡선·외곽선·이미지 전경 5개 합성 사례의 원본 복원을 픽셀 검증했다. 이는 만화 합성 경계의 품질 개선 증거가 아니다. 근거: `docs/astra-typesetting-transformed-protection-finding.md`.
- 이 문서는 매 실험 전 읽고, 판정 직후 갱신한다. 원시 증거는 `.tmp/astra-typesetting-research/`에 보존한다.
- 실행 규칙: 사용자가 지정한 `C:/Users/sam40/Downloads/codex-progressive-research-playbook.md`.
- 사용자 중간 공유 요청: 텍스트 상태 보고만 하지 않는다. 원본·제거 생성안·실제 저장 배경·한글 합성 결과를 단계별로 직접 보여 주고 성공/실패를 명시한다. 첫 실제 결과, 중요한 수정, 어려운 효과음 실패, 여러 페이지 진행 시 대표 결과를 commentary의 절대 경로 이미지로 공유한다. 원시 생성안을 실제 합성 완료본처럼 표시하지 않는다. 2026-09-06 요청에 따라 이전 큰 ギロ의 원본/생성안/허용 영역을 즉시 다시 보여 주었다.

## 후보 4 진단과 네 번째 전환

### 실행 중인 discovery-005

2026-09-06T02:35:02.839Z 시작. trial `76427c4e-7057-465f-94ed-44952c0722d1`,
job `be82898e-e764-44cf-bd0b-58fed937a18e`.
「魔導細工師ノーミィの異世界クラフト生活」 8.2화의 미사용 전체 입력은
836×16,464 픽셀 JPEG 1개이며 원본 해상도 11구간으로 읽는다. seed
`55451f5c348433d6ad4ac76c3d756e1a203a4415bfd731c6baa27f3c6dfbc6f0`, 원본 SHA
`94e9541d8759b7b6495b90c88a916b294260791e80fb964f410029250fb81585`.
첫 원본 구간은 봉인 후 후보 예약 전에 사용자에게 보여 주었으므로 discovery이며
confirmation으로 세지 않는다. 기존 8개 schema는 그대로, 새 배경 검수 schema만 추가했다.
1,750개 runtime/font/dependency inventory를 봉인했다. 완료·실제 저장본 감사 전
source/out/폰트 변경이나 rebuild를 하지 않는다. 최초 잠금 6번은 자동 재실행하지 않는다.

첫 구간의 실제 판독 효과음 크롭 5개와 판독 보류 곡선 손글씨 1개를
`candidate-001/shared-progress/reading-first-view/`에 영수증과 함께 저장하고 사용자에게
직접 보여 주었다. 이는 원문 판독 단계이며 아직 제거/식자 완료본이 아니다.
이후 실제 제거 도구/배경/합성 중간안도 구분해 이미지로 공유한다.

- 사용자는 큰 효과음도 결국 처리해야 하며 넘어가면 안 된다고 재확인했다.
  `docs/astra-typesetting-required-effects.md`와 해시가 묶인
  `user-regressions/required-stare-20260906.json`을 필수 회귀 기준으로 삼는다.
  discovery-004의 6쪽이며 최초 「転生悪女」 잠금 6번과 혼동하지 않는다.
- 실제 저장 배경과 투명 전경을 합한 RGB 전 픽셀이 14쪽 최종 출력과 동일하다.
  보존 영역/실패 복원/제거 허용 범위 밖 변화는 0이다. 이는 레이어와 보호 검증일
  뿐이며 원문 제거 품질 성공이 아니다. 10쪽 중간안의 잘린 말풍선도 최종에서는
  원문으로 복원됐다. 복원된 일본어를 완료로 세지 않는다.

- 사용자 최신 두 캡처는 3쪽 효과음 원문 위에 한글이 겹친 실제 중간 결함이다.
  제거 제외가 아니다. 생성 원본은 글자를 지우지만 그림/망점 정합에 실패한다.
  `user-regressions/source-residue-20260906.json`에 원본 복사본과 해시를 보존했다.
- 4쪽 효과음은 실제로 읽히는데 투명 PNG 재판독에서 빈 문자열이 된다.
  동일 두 asset을 원래 RGBA / 흰 matte로 나눈 독립 Astra high 호출에서 각각
  빈 문자열 / 정확한 타닥 3회·2회가 나왔다. 17,133 누적 토큰, ImageGen 0회.
  추가 검정/흰색 글자 대조 사전 검증도 실제 Astra 1회, 12,440 토큰으로 통과했다.
  상세: `docs/astra-typesetting-alpha-readback-finding.md`. 후보 4 결과는 수정하지 않았다.
- 궁서체·몽토리의 24/40/60px 보통/굵게 견본이 완전히 동일함을 픽셀로 확인했다.
  별도 실제 렌더 프로세스에서 정적 400 선언으로 바꾸니 평문은 동일하고 굵은
  글자만 바뀌었으며 두 대조 폰트는 그대로다. source/out/폰트 파일은 바꾸지 않았다.
  원인 검증과 외부 팔레트 통합 주의점은
  `docs/astra-typesetting-font-palette-integration.md`에 있다. 외부 워크트리는 읽기만 했다.
- 반복 배경 실패에 따라 네 번째 조사 200개 고유 질의/50개 원시 응답을 봉인했다.
  앞선 600개와 정규화 완전 중복 0. 논문 200개를 읽었다는 주장이 아니다.
  다음은 배경만 먼저 검수하고 실패 배경 위 식자를 생략하는 메커니즘이다.
  `docs/astra-typesetting-background-stage-research.md`. 현재 14쪽 실험과 보고는
  끝까지 완료했고 이 화를 4/5에서 퇴역했다. 다음 미사용 화에서 검증한다.
  새 후보 실행 없음. 어려운 원문을 실패 보존한 상태로 제품 완료를 선언하지 않는다.

## 확정 연구 계약

- 코퍼스: `C:/Users/sam40/AppData/Local/Tachidesk/downloads/mangas`, 읽기 전용. 한국어와 중간 산출물 제외. 원본·library·출력물 보존.
- 새 경로는 Astra가 직접 판독·번역·서체 묶음·폰트·크기·줄바꿈·검수를 담당한다. 기존 Hayai 고정 규칙은 이 경로에 한해 사용자의 명시적 변경으로 해제한다.
- ChatGPT 인증만 사용. API key fallback 및 Sol 호출 없음. ImageGen은 별도 생성 도구이므로 Astra의 판단 품질과 생성 결과 품질을 구분한다.
- 폰트는 화의 원문 crop 전체를 먼저 비교하여 계열을 묶는다. 계열과 굵기·크기·기울기·외곽선·왜곡을 분리하고, 같은 계열에는 일관된 대상 서체를 적용한다. 불확실한 묶음은 억지로 합치지 않는다.
- 프리셋당 최대 10개 폰트와 용도 설명. 사용자 등록 폰트 포함. 실제 폰트 견본과 실제 프로덕션 렌더 결과를 Codex에 제공한다.
- 원본 위치 / 제거 마스크 / 번역 배치 영역을 분리한다. 제거 배경은 고정하고 텍스트는 별도 편집한다. 효과음은 자연스러운 편집 텍스트를 우선하고 필요한 경우만 이미지 합성한다.
- 실패한 영역은 최초 결과 이후 최대 2회 보정한 뒤 원본 보존 + 검토 표시. 부분 제거만 적용하지 않는다.
- 품질 우선 이후 실제 토큰·캐시·생성 호출·시간을 최적화한다. 관측된 품질 저하가 있으면 기각한다.

## 샘플과 실험 예산

- 단위는 한 화. 미사용 화를 검사 전에 seed/inventory/hash로 봉인한다. 기존 20장, Sol 이미지 실험, 기존 폰트 연구 화를 사용 레지스트리에 합친다.
- 기존 6번(転生悪女の黒歴史 9화 015.jpeg)은 **새 캠페인에서 최대 10회**까지만 사용한다. 결과를 보거나 새 출력을 만드는 후보 실행을 예약할 때 먼저 사용 횟수를 기록한다. 끝난 뒤 성공/실패와 관계없이 자동 재생·검수 입력에서 제외한다. 사용자 재요청만 해제 가능하다. 10회를 채울 의무는 없다.
- 6번 7D / 7번 12M / 13번 5D의 보존 요구는 원본 해시·영역으로 기록한다. 6번 사용 제한은 이 영역에도 적용한다.
- 평가 단위당 제품 후보 최대 5회. 개선되면 실제 앱과 UI에서 쓸 수 있는 내부 버전으로 즉시 승격한다.
- 5회 소진 또는 같은 실패 반복 시 미세 조정을 중단하고 최소 200개 의미 있는 고유 검색 질의의 조사로 전환한다. 새 메커니즘은 다음 미사용 화에서 평가한다.
- 최초 결과는 한 화 전체와 제한 내 회귀 사례의 self-contained HTML 비교. 이후 다른 작품의 미사용 화 2개로 확인한다.

## 초기 가설과 실패 참고

- H1: 화 전체의 source-family-first 묶음 + 영역별 weight/effect 변형이 블록별 독립 선택보다 서체 일관성을 높인다.
- H2: 원문 위치와 식자 공간 분리 + 실제 렌더 피드백이 잘림과 부자연스러운 줄바꿈을 줄인다.
- H3: 원문 제거 배경 고정 + 별도 전경이 편집 중 원문 재등장과 불필요한 재생성을 줄인다.
- Sol 참고 실험에는 실제 이미지 생성 성공 기록과 글자 오탈자·배치 마스크 잘림·투명 배경 실패가 함께 있다. 품질 기준선이나 human gold가 아니다. 기존 임계값과 재시도 후 낮은 품질 자동 적용 정책은 승계하지 않는다.

## 승격 게이트

실제 새 번역 UI → 실제 application service → 편집 → 저장/재열기 → 출력이 연결되어야 한다. 전체 화의 원본/완성본과 독립 재판독, 회귀·경계·취소/재개, 넓은/좁은 실제 UI QA 및 저장소 check/build 증거가 필요하다. 검토 표시를 남긴 원본 보존은 품질 성공으로 세지 않는다. 공개 앱 릴리스는 범위 밖이다.

## 작업 공간 보존

이 worktree의 `node_modules`만 기존 checkout의 동일 의존성 폴더를 가리키는 junction이다. library 및 원본 코퍼스 junction은 만들지 않았다. worktree 제거 시 junction 자체를 먼저 분리해야 한다.

## 2026-09-05 · discovery-001 candidate 1 rejected

Actual startAnalysisJob imported all 10 sealed pages. Read 1 succeeded, read 2 emitted bare `seventy` in numeric renderBbox.w. No quality promotion; no page was completed. Measured 9,922 + 8,788 tokens, 130,977 + 82,662 ms. Do not repeat prompt-only JSON at this boundary. Candidate 2 uses server outputSchema generated from the same validation contract. The first import-only infrastructure failure made no model calls and is excluded from the five-candidate budget. Runner also needs an explicit window-all-closed handler so closing its hidden export window cannot abort failure persistence.

## discovery-001 candidate 2 · first rendered page observations (not final)

Ten page readings passed structured JSON. 9 source-family groups were assigned to 4 actual preset fonts. Actual font samples show regular/bold pixel differences for Mongtori, Nanum Gothic, Nanum Myeongjo; Chosun Gungseo rendered identically at the tested regular/bold settings. Do not assume every font supports a distinct heavy treatment.
First page review reported cleanup seams at r2/r5, a missed small Japanese tsu at r6, and an orphan exclamation at r11. All three reference-guided lettering calls returned nontransparent assets and were rejected, despite standalone new-image quang smoke succeeding. No quality promotion. A generated crop looking plausible alone is not evidence of aligned compositing. Next mechanism should inspect registration/edge continuity and distinguish reference-guided editing from new transparent foreground generation; do not blindly repeat identical generation prompts. The running baseline retains its declared maximum two repairs.

## User seam regression · 2026-09-05

User supplied `edge-misalignment-20260905.png` (SHA-256 `e9a73ef3b22c266364ff14a043386f3f6273cbf2b9074f93042d1aaab7f73258`). Diagonal lines visibly jump at a rectangular composite boundary. The running candidate resizes the generated crop and copies the permitted rectangle without registration. Preserve this as a user-observed defect, not a complete human-labeled benchmark.

Existing-output diagnostic 001 used the already generated final page-1 background crops, with no new model calls. Because it changes real rendered pixels after observation, conservatively count it as product candidate 3, despite its incomplete chapter scope. It was not preregistered; this procedural limitation is recorded explicitly. r5 context error fell from 0.2312 to 0.0609 after position/scale fitting but failed the provisional 0.06 gate. r2/r6/r7/r8 passed the geometric gate; that does not establish semantic/artwork quality. r2 still has a visible interior reconstruction defect. Candidate 3 is not promoted. Evidence: `.tmp/astra-typesetting-research/registration-diagnostic-001/`.

Subsequent source changes use a smoothed image only during transform estimation (the pasted pixels are not blurred), raw context/boundary error for rejection, and fail closed on missing or nonopaque coverage. Synthetic tests recover a known shift/scale, reject local redraws, preserve every outside pixel, and reject absent context. These revised source changes have not yet produced a new real-corpus output. Repeated failures retire discovery-001 at three counted candidates; the next mechanism must reserve a trial on the next unused chapter, not candidate 4 on this chapter. Registration is not permission to bypass rendered visual review.

Next candidate also needs selective repairs: retain accepted backgrounds/lettering, pass actual failures to regeneration, and generate new transparent foregrounds from the chapter style description instead of treating opaque source art as an edit target. Actual alpha and rendered reading must still pass. Failed raw outputs must be retained before consumer validation; immutable hash names replace overwritten crop evidence. No quality or cost claim is established by these code changes alone.

## discovery-001 candidate 2 · completed and rejected

Completed at 2026-09-05T14:00:37.957Z through actual app import → startAnalysisJob → optimistic library commit. All 10 sealed source hashes remain unchanged. The final report renders the persisted chapter, not the last unaccepted proposal: `.tmp/astra-typesetting-research/discovery-001/report.html`. All 10 final page PNGs were directly inspected. 80 blocks include 25 review regions with original restoration; zero active generated lettering assets survived. Plain dialogue can be readable, but retained Japanese, damaged reconstruction, and poor large effect treatment prevent promotion.

Measured 8,443,070 ms wall time; 72 Astra calls, 83 ImageGen calls; model input 913,429, output 85,941, total 999,370 tokens. Cached input 61,184 and reasoning 42,499 are subsets, not additional totals. ImageGen token usage and per-call elapsed time were not reported in this baseline and remain unknown, not zero. This cost is unacceptable as a final product even before counting image generation, but quality repair precedes optimization claims.

Read-only audit checked apparent duplicated phrases on page 1 against the original: r1/r2 and r10/r11 are distinct source phrases, not hallucinated duplicates. Actual rendered r11 punctuation wrapped beyond requested newlines; the next candidate records renderer-measured lines and box sizes so repair sees the actual extra line. Do not use requested line breaks as layout success evidence.

The 200-query transition is complete with an audited unique query ledger; this is not 200 fully read papers. Primary sources and limitations are in `docs/astra-typesetting-mechanism-research.md`. v0.2.0 adds crop-based glyph envelopes, context alignment, selective repair, fresh transparent lettering, blind image readback, and actual line measurements as one bundled candidate. No completed real-corpus quality or cost evidence exists for it yet.

## v0.2.0 · verified build and reserved diagnostic

`npm run check` passed all 26 gates in 148.16 s: 5,256 tests pass, 10 platform skips; full coverage floors retained; production panel/export pixel parity has zero mismatched pixels for both native and mismatched-metadata fixtures, including the generated RGBA layer. Latest wide/narrow real editor QA is `.tmp/astra-typesetting-research/ui-qa/layout-telemetry-qa.html`; real image-to-editable toggle checked, temporary entries/captures removed. This proves integration behavior, not manga translation quality.

Locked old page 6 trial `0ab3fc11-d72a-4b27-a942-0a0f62c7269a` was reserved at 2026-09-05T14:31:17.915Z before model input and direct inspection. New campaign uses **1/10**, running; artifacts `.tmp/astra-typesetting-research/locked-page6/trial-001/`. Do not rebuild or mutate compiled runtime/fonts until this trial and its final persisted report finish. Do not replay page 6 at campaign end without user request.

Next unused chapter discovery-002 was sealed at 2026-09-05T14:21:26.386Z, seed `db9292f28802e1686120df1fe838f37027da8d983462b9a84b744dc88d4c87d9`: `Manga Mura (JA)/悪の皇女はもう誰も殺さない/第10.3話-JP_ 第10.3話`. Its complete folder contains one 836×13068 JPEG. Dimensions were read from the JPEG header; no visual cherry-picking or substitution. The generic existing selector's metadata still names its original font-size campaign; the new candidate contract is the authority for this Astra route.

Baseline cost audit: source family + font assignment 36,108 tokens (3.61%); layout 548,477 and review 322,710 (87.17% combined); initial reading 92,075. Image calls: 62 cleanup and 21 lettering, usage unknown. Every page exhausted three layout/review attempts. Prioritize quality and selective repair before reducing the user's all-crop source-family inspection. Evidence `discovery-001/cost-stage-audit.json`; no savings have been measured yet.

## v0.2.0 diagnostic interim observations · not final

Old page 6 has 39 detected Japanese regions, all proposed as editable text. The erasure-plan call used 39 crops, 24,142 tokens and 503,386 ms (12,146 output including 2,588 reasoning). Five plans are empty: r03/r05/r25 tiny or clipped handwriting crossed by lines, r07/r13 outlined effects touching black art and panel borders. These are preserved for review. A tight crop that already clips source strokes cannot be repaired by changing its internal polygon alone. A later candidate should test contextual source-box refinement before freezing crop/style/removal contracts; do not silently enlarge or change this running candidate. Full cleanup/layout/visual review is still pending.

Actual library import → analysis commit → manual move/save → reopen → text edit/save → reopen → production PNG was verified independently with a synthetic stripe marker and the earlier generated transparent 쾅 asset. Moving only renderBbox leaves sourceBbox and the clean-background SHA unchanged; editing to 쿵 deactivates the image while retaining its bytes. All three PNGs directly viewed. `.tmp/astra-typesetting-research/edit-roundtrip/report.html` is integration evidence, not a manga trial.

PSD output had a verified defect: an active generated image could receive editable font metadata. A new real PSD encode/decode test failed before the guard and passes after it, including disabled/stale-image cases (8 focused PSD tests pass). Source fix is in `pagePsdExport.ts`; **not compiled into the frozen running v0.2.0 build yet**. Typecheck/lint pass. Rebuild/full checks only after the current trial report is safely finalized; do not claim the earlier full check covered this later fix.

Discovery-002 trial `e3e5ac44-7682-43e7-9649-c30398544a34` started at 2026-09-05T15:08:21.066Z on the same frozen v0.2.0 build while the locked regression performs its bounded repairs. Job `400c2732-a14f-4108-961c-8a333baf1ac7`, work `2749dca8-43c8-4e71-b0f0-fc0ff7c3bef9`, chapter `c489338c-72a2-412a-bf7a-a995790e26a1`. **Do not rebuild until BOTH running trials and final reports finish.** All seven overlapping read-only original audit tiles were directly viewed: this is Japanese black-and-white manga with a color release-information page at the bottom, all in one long JPEG. The audit tiles were not added to the model's frozen input contract and are not independent pages/trials.

Old page 6 first preview and model review agree that thin masks still leave source fragments and interior grid-like seams. r28 also loses the difference between a large shout and its small aside; the current layout contract cannot independently change target bold or mixed run sizes, even though the renderer has richer capabilities. Do not infer that whole-source family grouping alone solves target stroke weight.

Read-only `locked-page6/trial-001/internal-gap-audit.json` measured 25 already-written immutable generated crops at this snapshot. It uses the stored production transform without changing it or creating a new product image. Example r08 accepted crops have outer weighted context MAE 0.0289/0.0484 but unweighted two-pixel internal no-permission boundary MAE 0.2456/0.2869; r17 accepted crops show 0.0362/0.0514 outside versus 0.1378/0.1063 inside. The metrics differ in weighting and are diagnostic, not calibrated quality scores. The gate still checks the rectangular source bbox boundary, not the actual polygon boundaries. Disagreement can reflect an undersized mask retaining source strokes or internal generative redraw; these causes need distinction. A future gate must inspect actual mask boundaries and retained gaps. Never claim polygon-outside byte preservation proves natural reconstruction.

## v0.2.0 locked page 6 trial 1 · failed and rejected

Trial ended at 2026-09-05T15:25:37.062Z after about 54 minutes. The third layout request failed with `Selected model is at capacity. Please try a different model.` No fallback model was used. No incomplete page was committed: the persisted page still has the original image and zero blocks. Final persisted PNG was directly inspected. The self-contained `locked-page6/trial-001/report.html` explicitly separates its two unapplied intermediate previews from the stored result. Source SHA remains unchanged. Campaign usage stays **1/10**; do not automatically replay this poor-quality trial just to recover from capacity failure.

Recorded model usage is 192,195 tokens (157,382 input + 34,813 output), 8 completed response receipts plus 1 observed failed request with unknown usage, and 32 ImageGen response receipts with unknown token usage. These are lower bounds because receipts were written after responses. `whole-chapter-metrics.json` and `unrecorded-model-calls.json` are the count authority; the report script's console prints only the 8 recorded calls. Quality is rejected independently of the infrastructure error: first intermediate already has leftover source glyphs, internal pattern seams, and lost emphasis.

Next reliability requirement: record request starts and failures, and allow bounded retry of a clearly transient capacity rejection on the same Astra model without replaying completed stages. Cancellation must remain immediate. This is an application defect, not justification for downgrading models or claiming unknown cost as zero. Keep the frozen build until discovery-002 and its persisted report finish.

## discovery-002 v0.2.0 · completed and rejected

Completed 2026-09-05T15:59:22.272Z, 3,060,310 ms wall time. Actual saved chapter has 62 blocks, 35 review/original-preserved regions, zero active image lettering. All seven overlapping native final PNG tiles were directly inspected. Some unflagged translations still retain small source fragments; the remaining 27 blocks are not automatically 27 quality successes. Original source hash unchanged. All 35 failed bboxes have zero changed background pixels and their translations hidden; this protects original data but does not meet the quality goal. Report: `discovery-002/report.html`.

10 Astra response receipts, 6 ImageGen receipts, 308,146 measured model tokens (243,615 input + 64,531 output; cached 60,160 and reasoning 16,456 are subsets). ImageGen usage remains unknown. All six image calls are the same two illustrated regions across three attempts; no accepted background patch from these establishes a seam fix. Different workload from discovery-001: no claimed cost reduction.

Both v0.2.0 trial reports are now finalized, so the compiled runtime freeze is released. The later PSD fix and new bounded capacity-request recovery still require a new full check. The recovery's 10 focused tests cover exact transient retry, no fallback, unknown failures, real timer cancellation, request-before-transport evidence, and preserving both request/I/O errors. No durable cross-job resume has been implemented.

Second transition: 200 unique queries / 50 retained raw responses, no exact duplicates against the first transition. `docs/astra-typesetting-spatial-research.md` is the next pre-registered mechanism and source-limits authority. discovery-002 is retired after one candidate because the same failure family recurred across works. It must not be presented as fresh confirmation again. Page 6 remains 1/10 and is not automatically replayed.

Report HTML browser verification limitation: CUA rejected opening the local file URL by its URL policy; no alternate browser/server workaround was attempted. The embedded final PNGs were inspected directly and reports are linked as local artifacts; do not claim the report's live browser layout was verified in this step.

## v0.3.0 candidate · checked and running on discovery-003

The source-context mechanism is implemented in the actual application route. Context crops use the pre-registered native padding. Their polygons define a new source bbox before all chapter font crops are generated; rebasing preserves their original authorized pixels. Tests include 836×13068, 1530×2160, small/one-pixel pages, clipped edges, empty/degenerate masks and protected numbers. The actual erasure-before-family order is tested. Meaningful Japanese titles are no longer excluded merely as logos. No extra final-render repair or image/text policy change is bundled.

The new full `npm run check` passed all 26 gates in **133.25 s** (`.tmp/astra-v03-check.log`), including the later PSD guard and bounded request recovery. All existing exact coverage floors are preserved; the one new request module brings the introduced inventory to 419. The prior capture with an expected stale-inventory test failure is separately documented and is not called a full pass.

Discovery-003 sealed 2026-09-05T16:18:50.359Z, seed `47384ad7150b827a70dc1d7ffbf8787d2047792ef6f94503f4f34ed4c5539eb5`, eligible 49. Complete unused folder is `Raw Otaku (JA)/死ぬ運命にある悪役令嬢の兄に転生したので、妹を育てて未来を変えたいと思います～世界最強はオレだけど、世界最カワは妹に違いない～/第8話_ 第8話-v10`. One 836×33264 JPEG, 6,500,250 bytes, SHA `acb630d59802c11de03feff8c93e825c94cd5d2374c4509f8c952e06427cc49e`. Dimensions were read from its header without viewing or resampling. Long-image input remains part of this declared candidate; do not silently tile or change model inputs mid-run.

Trial `b8286605-cf76-4f06-864e-7e6ff61c7124` started at 2026-09-05T16:27:18.491Z, artifacts `discovery-003/`. Locked page 6 remains 1/10. Required new-work quality confirmation is still incomplete; do not call two rejected fresh works a successful confirmation.

## discovery-003 v0.3.0 · rejected, explicit unreadability lost

The model explicitly said that the image was too downscaled to read and requested divided original-resolution images. The service discarded this distinction and committed zero blocks as completed. This is a product failure, not an empty Japanese-free chapter. All 17 overlapping original audit tiles were directly viewed. One Astra call, 69,363 ms model time, 7,150 tokens (6,213 input + 937 output; cached 3,072 and reasoning 881 are subsets), no ImageGen call. Job time 73,287 ms. Source hashes unchanged.

The first report capture failed under strict-safe export limits. The existing production original-resolution tiled capture successfully rendered the persisted chapter after changing only the report call's capture option. No new product output was generated or silently fixed. Report: `.tmp/astra-typesetting-research/discovery-003/report.html`; original/final tile pixel comparison: `direct-audit.json`. Runtime freeze ended after this report. The source-context hypothesis was not meaningfully exercised because initial reading failed.

Next candidate v0.3.1, preregistered before source changes: retain original-resolution overlapping views with disjoint center ownership; read each in sequence using chapter context; rebase crop coordinates into native page coordinates, then retain v0.3.0 erasure and chapter-wide font grouping. Layout/review receive native views too, including actual render telemetry. Require an explicit readability field; unreadable means failure before any page commit, never an empty success. Use the existing original export mode rather than raise safety limits. Add an actual permission-boundary gate to reject local reconstruction drift inside the source bbox; unchanged outer rectangle alone is insufficient. This is a bundled candidate, not a causal ablation. Thresholds remain provisional and require visual review. It may be evaluated as candidate 2 on this already used chapter and must not be called fresh confirmation; no page 6 replay.

## v0.3.1 · canonical check passed, candidate 2 running

All 26 `npm run check` gates passed in 132.90 s (`.tmp/astra-v031-check.log`). New focused geometry/readability/mask tests pass; all historical coverage floors are retained. Real Electron input smoke confirms 22 original native views, every decoded pixel equal to its source crop and the already persisted original export, with invalid input size/metadata/path rejection. Original/final discovery-003 audit tiles have exactly zero differing channels across all 17 views; the final is the untouched original, not a translation.

Candidate 2 artifacts: `.tmp/astra-typesetting-research/discovery-003/candidate-002/`. Its immutable contract records one prior trial, so this is **not fresh confirmation**. Freeze compiled runtime and fonts through its completed persisted report. No automatic locked-page-6 replay. The new permission gate compares preserved pixels immediately outside the actual mask, in local 16px spatial groups as well as an overall weighted mean, with the existing provisional 0.12/0.06 thresholds. Passing still does not prove internal reconstruction quality or a seam-free commercial result.

## Next source preparation · v0.3.2, not the running recipe

While compiled v0.3.1 remains frozen, the next source candidate prepares font-guided action changes and rich emphasis using the existing safe text grammar. Scope is preregistered in `docs/astra-typesetting-next-experiments.md`. It does not change current corpus inputs or outputs. Source recipe is now v0.3.2; out/ remains v0.3.1 until candidate 2 and its report finish. Do not run build/check while that freeze remains active.

Tests cover text→image→text repair after actual font samples, fixed source geometry, protected digits, per-run text equality, real rich-text roundtrip, markup-free image prompts/readback, changed-style asset invalidation, opaque output rejection and cancellation. Typecheck/lint pass. The canonical richTextMarkup module's only new fan-in exception is 26, with a stated reuse reason; its algorithm is unchanged. Architecture/dead-export/mock-boundary checks pass.

The new source producer was compiled **in memory only** for a synthetic native-render smoke using the unchanged production renderer. `.tmp/astra-typesetting-research/typography-preparation/report.html` and `mixed-emphasis.png` show one Nanum Gothic block with a red bold 70px shout and a black regular 29px continuation. Directly viewed: correct emphasis, two expected lines, no clipping/overflow. Source producer hashes and renderer recipe are in result.json. This is not manga quality or promotion evidence, and does not substitute for the later full app build/check.

## discovery-003 v0.3.1 · failed and rejected

Trial f47e760e-8f9f-421b-9106-b4faa65226c2 ended 2026-09-05T17:51:38.537Z after 57m13s. All 22 native reading requests completed; source-center ownership retained 287 of 399 detections (280 active Japanese, 7 keep). The one request for all 280 erasure envelopes exceeded the 12-minute turn timeout. No ImageGen, family assignment, layout or review was reached. 23 request receipts, 22 completed calls, 230,355 measured tokens; the failed call's usage is unknown. This is a distinct response-size/scaling failure after the prior explicit-unreadability failure, not another accepted quality trial.

The immutable report is `discovery-003/candidate-002/report.html`. All 17 final audit tiles compare exactly to the previously directly viewed original tiles: zero changed channels, zero stored blocks, source SHA unchanged. The compiled freeze is now released. Page 6 remains 1/10. The new internal mask-boundary gate still lacks successful new-corpus evidence.

Actual production editor wide/narrow QA for the synthetic mixed run fixture also exposed unoutlined black text disappearing against the dark editing surface. Any editing-only readability fix must retain stored run colors/backgrounds and exact artwork/export appearance, with DOM extraction parity.

## v0.3.3 · canonical check and pre-trial validation passed

v0.3.2 was source preparation only, never a paid manga candidate. The next declared bundle is v0.3.3: erasure max 12 regions, layout/review max 16; all native views retained for review; chapter-wide source-family comparison unchanged. Actual layouts update destination and plain wording for subsequent review without changing source/erase geometry. Per-request render labels include only requested region measurements while full measurements stay in saved evidence. There is no cross-job cache or selective repair in this version.

All 26 `npm run check` gates passed in **136.42s** (`.tmp/astra-v033-check-final.log`). The first canonical attempt stopped only on generated coverage-manifest formatting, which was fixed before this full pass. All 664 historical and 422 earlier introduced coverage floors are unchanged; two new files bring the introduced inventory to 424. The earlier coverage capture with an expected inventory failure is not called a full pass.

Read-only deterministic replay of the prior 280-region reading produces 24 erasure batches and 18 layout batches, 2–3 original native views per layout batch, with all 22 views covered and no lost/reordered/duplicated IDs or changed source geometry. Evidence: `discovery-003/candidate-002/v033-readonly-input-shape-audit.json`. These frozen reading outputs are not reused as paid inputs or outcomes in the next candidate.

Production editor wide 1600×980 and narrow 1240×760 captures were directly inspected; unoutlined ink now has an editing-only contrast backdrop. Stored colors/backgrounds roundtrip unchanged. The newly compiled production renderer reproduces the prior mixed-emphasis PNG with identical decoded pixels and no overflow. `typography-preparation/editor-qa.html` and `v033-render-parity.json` are UI/integration evidence, not manga quality. Temporary QA entries and loose capture PNGs were removed after embedding them in the report.

Candidate 3 is the same already used discovery-003 chapter, not fresh confirmation. Freeze out/ and fonts after its contract is sealed through final persisted report. Page 6 remains 1/10. No promotion yet; apply the repeat-failure transition rule before any later candidate.

## discovery-003 v0.3.3 · failed on scoped readability

Trial f5657402-af00-4e11-9369-519c3339e0e8 ran 2026-09-05T18:13:31.660Z to 18:15:00.929Z. First view response says owned title/dialogue are readable but an effect outside ownership is clipped, then sets the single global `readability` to unreadable. The fail-closed gate aborts. One completed Astra call, 80,439ms, 9,104 tokens (7,088 input + 2,016 output; reasoning 1,008 is a subset), no ImageGen. New batch/typography behavior was never reached. The whole-chapter report and audit are `discovery-003/candidate-003/report.html` and `direct-audit.json`; final pixels equal the already verified original, no blocks/source mutation. Runtime freeze is released.

This cause is scoped uncertainty conflation, distinct from v0.3.0 native-resolution loss and v0.3.1 unbounded erasure response. Candidate 4 may test the preregistered v0.3.4 input contract on the same discovery chapter. It separates owned/context readability, gives the ownership box in view-local normalized coordinates, and separates narrative summary from diagnostic reason. Unreadable owned content still aborts; previous global-unreadable responses are not coerced or reused. All other candidate parameters remain v0.3.3. Repeat-family or five-candidate exhaustion requires the research transition and a new unused chapter.

Correction to the earlier measurement-cost explanation: raster labels attached the full measurement list only to the first native view, not every view. This was corrected to the user after inspecting the helper. Batching needed scoped measurements so requests lacking that first view do not lose telemetry. No measured token savings are claimed.

## v0.3.4 · checked input-scope candidate

Owned/context readability separation, narrative/diagnostic separation and explicit view-local ownership are implemented. All native views now identify their source as original or rendered, including batches that exclude view 1; no crop pixels or view boundaries changed. Focused tests: 48 passed, including readable owned text with clipped outside context, rejecting unreadable owned text, rejecting the old global-readability object, and normalized ownership coordinates for overlapping views.

Canonical check before the final origin-label clarification passed in 150.99s. A fresh complete check **after** that final change passed all 26 gates in **141.78s** (`.tmp/astra-v034-check-final.log`). Existing coverage floors remain unchanged. Native input smoke separately verifies all 22 original/rendered labels and identical decoded pixels (`discovery-003/v034-native-label-smoke.json`). Candidate 4 still needs actual whole-chapter evaluation; these checks are not quality evidence. Freeze out/ and fonts through its persisted final report after sealing.

Candidate 4 trial `d47a8ba4-437d-44e3-ac5f-2a4f8a8d9532` started 2026-09-05T18:28:23.843Z, job `acbf4cb5-8415-479e-8b07-35a9c84ea554`, work `f863d24f-58ec-4931-bec0-6bd20f955126`, chapter `ae3a6a29-833b-4e2d-b59c-6a7acf3a9f0b`. It passed the previously failing first view and has continued reading native views. No complete quality result yet. Artifacts: `discovery-003/candidate-004/`.

## v0.3.5 source-only font specimen preparation

Synthetic long-title fixture through the actual frozen v0.3.4 `renderFontSamples` and renderer reproduced clipping: the 60px regular/bold rows overflow the 180px cell and are visibly cut off at the bottom of the 1200×600 image. Original evidence `.tmp/astra-typesetting-research/font-sample-qa/result.json` and `font-nanum-gothic.png`; directly viewed. This is not a manga candidate or new generalization case.

Preregistered source preparation now uses canonical whitespace/grapheme segmentation and safe rich-text serialization. Specimens start at 8 graphemes and can shorten to 4 then 1 based on actual six-row renderer overflow; stated 24/40/60px sizes stay fixed. Missing/incomplete measurements or remaining overflow fail explicitly; actual translated manga text is not shortened. Evidence includes the accepted specimen and actual row measurements. The same five tests failed before the change and pass after it, including grapheme preservation, unchanged size/weight arrangement, exact literal markup and refusal to send unmeasured/clipped samples. Source typecheck/lint/architecture/dead-export/mock-boundary checks pass. The canonical markup module's sole new fan-in exception is 27 with the literal specimen consumer documented; no parser/segmentation algorithm is moved or changed.

Only this production source module was compiled **in memory** against frozen v0.3.4 dependencies/renderer. Its six actual output rows have expected sizes and no overflow; the new PNG was directly viewed. Before/after self-contained report: `font-sample-qa/source-v035/report.html`. Producer SHA `0817ebf322907e4e11fde23c9810efab4ac08ec5b0c448dd325885257eb29ba6`. This is synthetic integration evidence, not manga quality. Source recipe is v0.3.5; **out/ and the running paid candidate remain v0.3.4**. No canonical build/check of v0.3.5 until candidate 4 and its final persisted report complete.

## Third transition and accounting preparation

All 48 masks in the first four completed erasure batches were directly inspected using the frozen production mask producer. `part-4:r9` transcribes `……大丈夫かな` correctly but excludes the final `な` from permitted pixels. Chapter-title furigana also appears partly outside the mask. These diagnostic overlays were never fed back into candidate 4. The current repair path reuses the same reading/mask and cannot remove an excluded source fragment. Final persisted output/review behavior remains to be checked.

The same mask-coverage failure family triggered a third transition: 200 unique meaningful queries, 50 hashed raw search responses, no exact duplicates against the previous 400. This is not 200 read papers. Primary findings and their limitations are in `docs/astra-typesetting-visual-feedback-research.md`. After candidate 4's final report, retire this chapter at four attempts and move to an unused whole chapter with a preregistered mechanism change. Page 6 remains 1/10 and is not automatically repeated.

Cost-accounting source now preserves the thread/turn-scoped cumulative total and last snapshot separately. Only a new ephemeral thread receives `tokenUsageScope=ephemeral-thread-total`; absent totals remain unknown. Child-process tests cover repeated and duplicate notifications, unrelated threads/turns, missing totals and missing usage across both completion paths. The related 21 tests, typecheck/lint and architecture/maintainability checks pass. This is v0.3.5 source preparation only; frozen out/ remains v0.3.4. Historical figures are sums of saved last snapshots, not retroactively verified whole-agent totals. Unknown ImageGen usage stays separate.

Bundled 0.153.1 schema regenerated into `.tmp/codex-protocol-schema-experimental/` with `--experimental` confirms `thread/start.dynamicTools`. The earlier nonexperimental schema omitted that property even though tool response definitions existed. A separate, at-most-three-proposal synthetic image-return proof has started. No production dynamic-tool support or manga quality pass is claimed before its result.

## v0.4.0 source preparation · scoped actual erasure previews

Protocol proof 1 failed because the code-mode host was disabled; no preview reached the client. Proof 2 enabled code mode and passed after three previews (one duplicate), with 105,562 cumulative tokens versus 18,536 in the last snapshot. Proof 3 explicitly emitted each image URL with `image(..., "original")`, passed after two previews, and measured 18,612 cumulative versus 6,674 last-snapshot tokens. These are individual synthetic observations, not a manga savings forecast. The proof PNGs were directly viewed and self-contained HTML reports preserve the actual images.

The final preregistered source bundle is now v0.4.0: v0.3.5 font specimens and cumulative accounting plus a scoped erasure-preview capability only. The ordinary isolated client stays isolated. Each erasure batch receives a registered actual crop/mask producer; final IDs/backgrounds/polygons must equal the last previewed canonical hash. Initial plus two previews, exact membership, protected keep content, unknown tool/thread/namespace, duplicate-ID input conflicts, concurrent proposals and cancellation are guarded. Empty masks are visibly unresolved, not success. Existing `fillPlainMask` is exported for direct reuse without algorithm changes; pixel characterization checks actual allowed fill and unchanged outside pixels. The composition root's specific runtime-import exception is 14 for this additional adapter; global limits are unchanged.

`dynamic-production-proof-001` compiled the new source client/transport/host/producer **in memory only**, using frozen v0.3.4 geometry and actual crop/permission/fill code. It passed in two previews, with zero remaining target pixels, zero changed blue artwork pixels, matching final geometry, and 17,338 cumulative tokens. Initial and corrected actual crop PNGs and full final PNG were directly viewed. This establishes a synthetic source integration, not a whole-app build or manga quality pass. **out/ remains v0.3.4 until candidate 4 and its persisted final report are complete.**

The current manga's first three recorded accepted patches (`part-11:r9`, `part-12:r10`, `part-13:r15`) were independently recomposited read-only with original pixels, recorded transforms, exact permissions and the frozen production compositor. Outside-permission differences were zero for all three. Direct views still show some pale rectangular tone differences and faint contour-like remnants. Evidence: `candidate-004/readonly-accepted-patches-1/`. They are not final whole-page results or quality successes; later final review must still inspect them.

## discovery-003 v0.3.4 finished and retired; v0.4.0 built

Candidate 4 ended failed at 2026-09-05T20:15:48.111Z after 6,444,268 ms. It completed 22 reads, 24 erasure batches, chapter source families and font assignment. 41 artwork regions led to 38 ImageGen calls; 7 individual patches passed the numerical gate. The first layout batch was rejected by the strict server because nested rich-run `sizePx` was optional in the wire schema. No layout or final review was reached. This terminal protocol failure is separate from directly observed mask undercoverage and imperfect accepted patches.

48 completed Astra receipts plus 1 failed receipt; 534,375 saved-last-snapshot tokens (389,003 input, 145,372 output; cached 34,304 and reasoning 55,158 are subsets). Failed-call and all 38 ImageGen usage are unknown. Final persisted page has no blocks or composed background. Its full 836×33,264 decoded raster equals the previously verified original; original JPEG SHA is unchanged. Report, whole-chapter metrics and direct audit are complete. The whole chapter is retired at four candidates, with `discovery-003/retirement.json` and a reservation guard; page 6 remains 1/10. This is not fresh confirmation or successful translation.

Only after the persisted report and full-raster audit finished was out/ rebuilt. v0.4.0 additionally fixes strict wire properties: all object keys are required, nullable inherited style values decode to existing undefined semantics, and mandatory values remain nonnullable. Seven recursive schema-contract cases and the nested run inheritance case pass. An initial synthetic preflight harness referenced a private schema export; that failed attempt is preserved with one unknown-usage call. The corrected public-gateway preflight (`schema-preflight-v040-002`) passed seven actual Astra high server schemas, including mixed runs with null size/color, with 33,415 cumulative tokens and no missing usage.

All 26 canonical `npm run check` gates passed in 142.27s (`.tmp/astra-v040-check-final.log`). Historical 664 floors and prior 424 introduced floors are byte-value preserved; measured new preview-host/producer files bring the introduced inventory to 426. The previously missed request-preview branch is tested without weakening its 100% branch floor. Compiled out/ is v0.4.0, ready to freeze for the next reserved chapter, not promoted.

discovery-004 was sealed before visual inspection at 2026-09-05T20:30:04.436Z: Rawkuma (JA), `Akuninzura shita B-kyuu Boukensha – Shujinkou to Sono Osananajimi-tachi no Papa ni naru`, Chapter 11.2, all 14 pages. Seed `4d2e3ba6f2d7565075f86a9665e2d29c23d25d4e0c911a5acdfeda71e2d989cb`, eligible 48 of the same 1,199-chapter inventory. The reservation guard requires the third 200-query transition, successful actual source preview proof and seven-stage actual strict-schema preflight before launching v0.4.0.

## discovery-004 v0.4.0 · excluded-language readability failure

Trial `20ef6fe1-4fd6-4a45-99f8-d06be38a1fd6` ran 20:34:58.509Z to
20:36:54Z on 2026-09-05. Job `bf211d65-43c6-40ff-9e36-1a1de731e027`,
work `7c8b0e56-6c8d-4ac0-8789-13381b6260bd`, chapter
`f74dd491-95ef-4cd2-b47b-85f152a50d7a`. One successful Astra response,
113,166 ms model time, 10,294 cumulative tokens (6,707 input, 3,587 output;
1,034 reasoning is an output subset). Zero ImageGen calls. The model read
Japanese but marked ownedReadability unreadable because a tiny English logo
line was illegible. The prompt explicitly required all owned lettering to be
readable, contradicting the Japanese-only task. This is a prompt-scope defect,
not an erasure-tool, image-registration or source-resolution outcome.

All 14 source pages were directly viewed; the first final PNG was also viewed.
All 14 final native rasters equal the corresponding original-chapter state
rendered by the same production renderer, with zero blocks/composed background.
All imported source JPEG bytes and corpus hashes are unchanged. An initial
nativeImage-versus-renderer pixel check failed: page 1 has 9,608 differing
channels, each delta 1; other pages have zero. This decoder comparison is recorded
separately rather than silently tolerated as exact equality. Evidence:
`discovery-004/report.html`, `whole-chapter-metrics.json`, `pixel-audit.json`.

Candidate 2 is preregistered in `astra-typesetting-language-scope-candidate.md`.
v0.4.1 changes only the reading prompt and recipe label. Confirmed excluded
content stays protected keep even without a transcript. Unknown script and
unreadable Japanese still fail; no response is coerced or reused. Schemas and
downstream v0.4.0 mechanisms remain unchanged. This is the same discovery unit,
not fresh confirmation. Relevant 38 tests passed before the canonical check.

All 26 canonical v0.4.1 gates passed in 145.83s (`.tmp/astra-v041-check.log`),
including coverage floors, build and actual artwork parity. All seven compiled
schemas equal the previously successful actual v0.4.0 server schemas exactly;
`discovery-004/candidate-002/schema-parity.json` records their hashes. No new
paid schema call was needed. Trial `23b71556-bcd4-45d7-91b7-d9945228f877`
started 2026-09-05T20:49:39.894Z, job
`0b976f6f-c87f-41e2-9404-9fd6c148da15`, work
`7b0d630a-aea8-4847-94b9-07beede79431`, chapter
`66fd8908-ac04-4dde-b1d7-72850d4a1bc4`. Freeze compiled out/ and fonts
through this candidate's persisted final report. Registry summaries are synced
from recorded trials; historical font-research selections remain untouched.

## discovery-004 v0.4.1 rejected; v0.4.2 localized preservation

Candidate 2 ended at 2026-09-05T20:56:39Z. Four completed Astra calls:
2 reads and 2 erasure batches, 74,240 cumulative tokens (64,227 input,
10,013 output; cached 34,432 and reasoning 2,274 are subsets), zero ImageGen.
Page 1's fourteen Japanese targets plus protected English logo proceeded. Its
first batch used two actual previews and its second batch used one. All final
fourteen permission previews were directly viewed. The first r8 preview cut
the balloon border; revision 2 repaired it. Of 108 changed pixels, 90 restored
exact source pixels. This is local real-mask feedback evidence, not synthesis
or whole-chapter quality success.

Page 2 identified a localized uncertain Japanese SFX after `ぐ` while reading
other dialogue. The existing global gate aborted the entire chapter. All 14
persisted finals have zero blocks/background and exactly equal the previously
verified original production rasters. All imported/corpus source bytes/hashes
remain unchanged. Candidate 2's report, metrics and direct audit are complete.

Candidate 3's representation change is preregistered in
`astra-typesetting-partial-reading-candidate.md`. This is a newly observed
localized Japanese ambiguity, distinct from the earlier downscaled input,
non-owned context and excluded-English scope defects. The playbook section 9
allows changing the data representation within the five-candidate unit. Do not
count partial preservation as successful reading or hide the unresolved region
from the whole-chapter denominator. No fourth 200-query transition or fresh
generalization claim is made here; no prior response is reused.

v0.4.2 adds explicit partial status and localized unreadable source boxes.
Contradictory statuses, duplicate IDs, invalid geometry/ownership and global
unlocalized failure remain errors. Qualified unknowns are protected keep with
an empty transcript and preserveReason. They are excluded from active erasure,
font grouping/assignment, lettering and layouts. Final review-only blocks keep
source geometry, zero opacity and needs_review, including all-unknown pages.
Automatic source/render overlap feedback protects keep boxes within the existing
two repairs; persistent conflicts use the existing active-region restoration
closure. Keep IDs are not accepted as active model review targets.

The existing block list now shows review reasons for expanded flagged blocks.
Plain notes remain literal text; legacy feedback arrays display only their
deduplicated human-readable reasons. No new control, surface or selector was
added. Existing batch tests had placed a protected digit on exactly the first
dialogue's box; that unrelated fixture was moved to a separate area, and new
tests explicitly cover overlapping keep regions instead of weakening the guard.

All 26 canonical gates passed in 142.86s (`.tmp/astra-v042-check-final.log`),
with unchanged coverage floors and the same 426 introduced production files.
The first attempt failed only an expected-error catch syntax lint rule, fixed
before the full pass. Actual read-schema preflight passed both readable and
partial fixtures using Astra high, 10,128 cumulative tokens, no missing usage.
Six other schemas exactly match the earlier actual v0.4.0 server preflight.

`partial-reading-roundtrip-v042/` uses real import, analysis save, reopen and
production export with a synthetic marker. The 4,800 protected pixels equal
the original; removing the review marker changes zero output pixels. The final
PNG and actual production component UI were directly viewed at 1600×980 and
760×1000, including clicking the actual review-only filter. A first narrow QA
fixture incorrectly requested a 1000px modal; that failed capture is retained
in the self-contained report and the corrected responsive fixture was recaptured
at both sizes. Temporary entries and standalone captures were removed after
embedding the images. Post-QA 57 focused tests and another production build pass.
These are synthetic integration/UI evidence, not manga-quality promotion.

Candidate 3 trial `514206fd-b855-4941-92fa-e8c884ceaf4b` started
2026-09-05T21:27:33.782Z, job `31ffaea1-5057-47a4-8a4c-024622e20f76`,
work `03dfb375-ba25-4e34-a452-f80d4bf29269`, chapter
`9a2877cf-f943-4439-aeb2-aab6b1afad4f`. Its first page is
`758fedcd-1fdc-41b6-ba45-bc86c56f581c`. Artifacts are
`discovery-004/candidate-003/`; all seven compiled schema hashes match their
actual server preflights. **Freeze v0.4.2 out/ and fonts through the final
persisted report.** Registry shows this chapter at 3/5 candidates, not a new
sample. The UI/integration report was queued in the Codex file panel; that
does not constitute browser inspection of its HTML.

## 2026-09-06 · approved feather, persisted ギロ and SFX mode

Discovery-005 v0.4.5 finished rejected. The background batch returned six active
issues plus nine known protected unreadable IDs; the validator aborted the whole
chapter. All 172 initially active Japanese targets plus 9 unreadable targets remain
in the denominator. Final production output equals the original raster: no target
is a successful translated final. Cost: 30 completed Astra receipts, 979,154
cumulative tokens; 57 completed image-request receipts have unknown usage. The
erasure-planning stage alone used 680,921 observed tokens. Direct native background
inspection and a self-contained audited report are complete. Local splice tuning
001–004 counts as four additional pixel-changing experiments, so close this chapter
at five effective experiments and do not tune it again.

The user approved a filled-word opaque core with outer feather. v0.4.6 implements
native-width starting radii, expanded protection/restoration, explicit alpha
compositing, actual-splice background review and same-job raw reuse for eligible
geometry-only repairs. Legacy numeric registration thresholds are unchanged but
now diagnostic for technically valid staged proposals; actual visual review must
approve them. This authority change is explicit in the feather candidate document,
not disguised as a log-only change or a historical gate pass.

The mandatory discovery-004 ギロ now passes a known-target regression. Actual Astra
background/layout/readback/final review and one generated 찌릿 foreground succeeded.
The first harness used the wrong image client; its 4,829-token text response remains
an infrastructure failure. A second deterministic gate exposed hidden fallback
text overflow being applied to an active image. v0.4.7 fixes only that measurement.
Actual native final pixels are unchanged; library save/reopen/move/edit/restore and
background + transparent foreground reconstruction are exact. `required-stare-
persistence-v047-001/report.html` includes the actual results. Across the known
regression, 43,926 observed tokens include the failed harness call; the one actual
ImageGen request has unknown usage. Persistence replay adds zero model calls.
Other targets on that page were outside this regression, and two fresh different-work
confirmations remain necessary. The original 転生悪女 page 6 stays at 1/10.

The user then required a modal choice of generated SFX or editable font SFX, with
EVERY research SFX fixed to generated. v0.4.8 adds `sfxRendering: image | font`,
defaults old requests/preferences to image, persists the selection, and enforces
it for `role: sound` during every layout and repair. Ordinary text keeps its existing
font-guided treatment. Modal tests exercise legacy defaults, toggling/persistence
and the actual start request; service tests intentionally propose the opposite
treatment and verify the selected mode remains authoritative through repairs.
All 26 canonical checks passed with 5,426 tests and 10 skips in 159.90s. Final actual
modal QA at 1440×900 and 760×1000 passed; the nine model response schemas exactly
match previously exercised server schemas. See `sfx-mode-preparation-v048/verified.json`.

A sampling defect had excluded every other chapter of any previously selected
series, exhausting the pool. The playbook allows unused chapters in a known series.
Rebuilt concrete exclusions from the latest font worktree history, initial 20-page
bbox selection, earlier image experiment and campaign selections before removing
only that series-wide heuristic. The old registry and correction audit are preserved.
No known chapter was reintroduced; 868 unused Japanese chapters remained eligible.
Discovery-006 sealed サラナ・キンジェ 第16.2話, source SHA
`72cb4a1ea2abb44850c9c17d85ede2b8c59043f1d84cbaa2de9acd413a17b131`, seed
`2cf530c82de1081ab1669dc80e56b743cbb72857cb4817ae3a3b22b0f52aea79`.
All 11 original native views were directly inspected after sealing and before
reservation. The complete 836×15,444 chapter is discovery, not confirmation.
Freeze v0.4.8 source/out/fonts through its actual final export and report audit.

## 2026-09-06: user redirects to Korean SFX appearance

The user accepted the current background level and explicitly prioritized source-style
Korean SFX. Discovery-006 candidate-001 was interrupted with original artifacts intact,
after verification of all 30 source modules and 1,752 runtime/font/dependency files.
Its ledger is cancelled, not a whole-chapter quality verdict. The previous freeze
instruction above ended at this recorded interruption; do not resume it against v0.4.9.

The foreground generator had passed zero original images to ImageGen. A targeted
built-in ImageGen experiment now uses actual source crops for ビクッ→움찔,
ニコ→방긋, パァ→화아 and フワッ→사르르, holding the existing background fixed.
Ten calls including corrections produced four independently composited foregrounds.
Opaque checkerboard outputs, incorrect Hangul and thin outlines remain in evidence;
they were not hidden or counted as successful first attempts. Both native-size and
enlarged production exports were directly inspected. The user said the shown examples
were good; use their level as the SFX visual target without over-polishing backgrounds.

Candidate v0.4.9 wires original source context crops into the actual lettering adapter.
It is not automatically promoted by the manual examples. See
`astra-typesetting-sfx-source-reference.md` for exact artifacts, scopes and remaining
automatic/generalization validation. The original locked sample6 is still untouched.
