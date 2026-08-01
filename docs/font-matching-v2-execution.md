# Font Matching V2 실행 기록

이 문서는 [설계 계획](./font-matching-v2-plan.md)의 실제 구현·검수 상태와 완료 근거를 추적한다. 체크 표시는 명령 출력이나 생성 artifact로 다시 검증된 항목에만 붙인다.

## 기준점

- 작업 시작 커밋: `185d05d chore: checkpoint current workspace progress`
- 기준선 TypeScript typecheck: 통과 (`npm run typecheck`, 2026-08-01)
- 기준선 Vitest: 304 files, 2,136 passed, 2 skipped (`npm test -- --reporter=dot`, 2026-08-01)
- 기준선 FontClip Python tests: 96 passed (`python -m unittest discover -s tests/python -p "test_*fontclip*.py"`, 2026-08-01)

## P0 — 데이터·폰트 계약

- [x] 28,115개 승인 crop 통합 inventory
- [x] base/hard 공통 `raw_224/context_224/glyph_224` view contract
- [x] 기존 split 폐기 및 전역 `work_id` split map
- [x] duplicate/root/variant group split 누출 0
- [x] synthetic/QA overlay 유입 0
- [x] 15개 한국어 family와 실제 face 파일 inventory
- [x] font binary SHA-256, CSS weight, 내부 metadata, coverage 기록
- [x] P0 전체 데이터에서 validator 통과

## P1 — blind review 기반

- [x] 라벨 JSON Schema와 candidate tier 불변식
- [x] 역할·스타일·후처리·tier 육안검수 규약
- [x] deterministic blind candidate order
- [x] primary/double/adjudication assignment 계약과 exactly-once 불변식
- [x] 프로덕션 렌더러 기반 후보 카드
- [x] 1,000–1,200건 pilot inventory
- [ ] pilot 역할 합의 macro-F1 ≥ 0.85 (실측 0.6362, 실패)
- [ ] pilot tier pairwise 합의 ≥ 0.80 (실측 0.5747, 실패)
- [ ] pilot acceptable-set Jaccard ≥ 0.70 (실측 0.4714, 실패)
- [ ] `none_acceptable` catalog ceiling 판정

## P2 — 전수 대응

- [ ] 약 4,000건 calibration batch 완료
- [ ] 24개 작품 `WorkTypographyProfile` 정답 작성
- [ ] 28,115건 primary visual review 완료
- [ ] 최소 5,623건 독립 double review 완료
- [ ] 모든 disagreement/low-confidence/none/재크롭 adjudication 완료
- [ ] 작품별 본문 전환·효과음 팔레트 일관성 audit 완료
- [ ] 미검수·중복 최종결정·ledger 오류 0

## P3 — 모델과 평가

- [ ] 현행 규칙 baseline
- [ ] 역할/work majority baseline
- [ ] frozen FontCLIP baseline
- [ ] 실제 한글 render retrieval/ranker
- [ ] role/style/treatment/none heads
- [ ] 작품 단위 profile optimizer
- [ ] frozen work holdout 및 GroupKFold
- [ ] 장르 제거/교환/unknown 반사실 평가
- [ ] 계획서의 offline gate 통과

## P4 — 앱 통합

- [x] `WorkTypographyProfile` 저장·마이그레이션
- [x] 지속 가능한 semantic role과 intentional override 계약
- [ ] page batch local inference와 prototype cache
- [x] 번역문 glyph coverage hard gate
- [ ] 실제 렌더 측정 기반 layout rerank
- [x] 사용자 block/work lock 우선순위 결정 계약
- [x] 기존 수동 폰트 무덮어쓰기 회귀 테스트
- [x] 현행 제목/정규식 엔진 제품 fallback 제거
- [x] 실제 UI 렌더 QA, typecheck, tests, build 통과
- [x] 변경 범위 lint 및 안전성 감사 P1 수정 통과

## P5 — blind QA와 출시 판정

- [ ] 미관측 작품 ≥ 5, 페이지 ≥ 100 blind A/B
- [ ] V2 선호 ≥ 65%
- [ ] 수동 font 변경 ≥ 30% 감소
- [ ] 페이지 수정 시간 ≥ 25% 감소
- [ ] SFX/필기 cohort 선호 ≥ 60%
- [ ] coverage 실패 0
- [ ] p95 ≤ 150ms/block, 10-block page ≤ 1s, peak RAM ≤ 300MB
- [ ] shadow → suggestion → automatic 단계별 결과 기록
- [ ] 요구사항별 최종 completion audit

## 실행 로그

각 단계가 끝날 때 아래 형식으로 추가한다.

```text
YYYY-MM-DD / 단계
- 명령:
- 결과:
- artifact:
- SHA-256 또는 commit:
- 남은 실패/예외:
```

2026-08-01 / P0 통합 crop·split 계약

- 명령: `python scripts/build_font_matching_master.py validate --base-root datasets/fontclip-accepted-v1 --hard-root datasets/fontclip-hard-accepted-v2 --library-root library --master-dir C:\tmp\font-matching-master-p0-live --expected-total 28115`
- 결과: 28,115건, 24작품, train 15작품/19,681건, val 4작품/4,221건, frozen test 5작품/4,213건. work/split 누출·손상 asset·synthetic·QA overlay 모두 0.
- artifact: `C:\tmp\font-matching-master-p0-live`
- SHA-256: manifest `835642f06f606b6038298e8b4e15196bc05884719d904d0ec502481f2b8808e7`, split map `8a1e0bc106f95107fec3a04985c9ec091de07ed36c5e195bba3edcd2f6c735c2`
- 남은 실패/예외: 없음. artifact는 zero-copy 계약이라 원본 base/hard/library root가 필요함.

2026-08-01 / P0 폰트 face·실렌더 계약

- 명령: `npm run build:font-face-manifest`, `npm run build:font-render-bank`, `npm run check:font-face-manifest`, `npm run check:font-render-bank`
- 결과: 15 family/31 face/35 weight 후보, Electron Chromium 실제 렌더 680/680, `fonts.ready` 680/680, fallback 0, 잘림 0, QA overlay 0.
- artifact: `datasets/fontclip-font-catalog-v1`, `datasets/fontclip-font-render-bank-v1` (둘 다 gitignored 재생성 artifact)
- SHA-256: render manifest `131181d5ed384655c14c2448b90f90783c5950561e96fe4b91d74041cb371ccf`
- 남은 실패/예외: 나눔고딕 light의 원본 archive provenance는 미확인으로 명시. Chromium이 거부하던 regular/bold/extra-bold 3종은 공식 Naver archive SHA `25eee9a54f391d1d81dc5bbaab313f6c055bcbd2e7ab5d2cca8a0aa57257bdd9`의 무변형 파일로 교체함.

2026-08-01 / P1 파일럿·보정 표본 inventory

- 명령: `python scripts/build_font_matching_pilot.py validate --master-manifest C:\tmp\font-matching-master-p0-live\manifest.jsonl --output-dir C:\tmp\font-matching-review-inventory-p1`
- 결과: pilot 1,200건(24작품·214화·수동 재크롭 39/39, 가로쓰기 34.75%, quota deficit 0), calibration 3,950건.
- artifact: `C:\tmp\font-matching-review-inventory-p1`
- SHA-256: inventory `c115cd4e03b736a8bd6976e1c4705eb95c971a0908afd603d80306e38c1889f9`
- 남은 실패/예외: 계획 당시 nominal hard 위험군 2,972건보다 실제 정책 합집합이 3건 많은 2,975건. ordinary proxy 후보 자체가 부족한 3개 화에서 총 11건 부족하며 `coverage_gap`으로 보존함.

2026-08-01 / P1 블라인드 실렌더 review 카드

- 명령: `python scripts/build_font_matching_review_cards.py build ... --output-dir C:\tmp\font-matching-review-card-qa-live-v1 --stage primary --batch all`, 이어서 같은 입력으로 `validate`
- 결과: 실데이터 가로·세로 카드 각 1장, 15 family 후보 총 30칸 중 실제 렌더 29/29, 가로 카드의 세로전용 family 1칸만 `orientation_unrenderable`. font 이름·ID·모델 제안 노출 0, 학습 asset 복사·수정 0. 두 PNG를 원본 2,400×3,508 해상도로 직접 열어 bbox, 문맥, raw/context/glyph, 후보 15개, 워터마크의 잘림·겹침이 없음을 확인함.
- artifact: `C:\tmp\font-matching-review-card-qa-live-v1` (QA 전용, `qa_overlay=true`, `training_asset=false`)
- SHA-256: manifest `a7fb153bbf98d41566fcb32b7c1b2f74261a2385123016df07d31f88530e841d`, builder source `b79efc687a0ae44420448abbdc46264849eb993218a3b543ec2d8ce647953982`, renderer `b356a7a09ad900af63696c111a24d0fbfa53a4c85fba86a868b072cd9c483df6`, vertical card `c07d2aaecfdff4e5be65f356b5cb9c688248e551473b6346fe6ec6b0e894fa53`, horizontal card `5bad10152d969f64791eef5d3cf0dc95696a773f57bd450bfa9aa5558708a0bb`
- 남은 실패/예외: 카드 자체는 학습 입력으로 사용하지 않는다. pilot 합의 gate가 통과되기 전에는 전수 라벨 확장 및 모델 학습을 시작하지 않는다.

2026-08-01 / P2 전수 검수 assignment·원장 계약

- 명령: `python scripts/font_matching_review_ledger.py plan --master-manifest C:\tmp\font-matching-master-p0-live\manifest.jsonl --render-bank datasets/fontclip-font-render-bank-v1/manifest.json --base-priority-inventory C:\tmp\font-matching-review-inventory-p1\inventory.jsonl ...`
- 결과: primary 28,115건, secondary 정확히 5,623건, 총 33,738 assignment, 24/24 작품에 독립 2차 표본, 수동 재크롭 39건 추적. claim/submit은 원자적이며 secondary와 adjudicator의 reviewer 독립성을 강제한다. disagreement·저확신·none·미검수·crop/render/catalog/policy/role·수동 재크롭을 모두 재판정 큐로 보내고, unresolved queue가 있으면 완료 검증을 거부한다.
- artifact: `C:\tmp\font-matching-review-ledger-plan-v1`
- SHA-256: assignments `750c4b3742b1b9b7ff7e0e7bb1659b19c37803166cd4a9a421d9b3f207d3bd93`, inventory `7172847598db7fc738e898d43cc4885d92b686783f83151240b1600ce4b61963`
- 남은 실패/예외: 이는 검수 실행계획과 원장 계약 완료이며, 사람/에이전트의 실제 28,115건 판정 완료를 뜻하지 않는다.

2026-08-01 / P4 작품 타이포그래피 프로필 계약

- 명령: focused Vitest, ESLint, Prettier, `npm run deadcode:exports`, `npm run arch:deps`
- 결과: 15개 semantic role, source style/treatment, ranked evidence와 abstain, block lock → work role lock → profile → V2 → user default/Top-3 우선순위, 본문 anchor+hysteresis, 역할별 2–4 family palette, intentional override, 장르 style bias 최대 10%를 version 2 schema로 고정. V1 migration과 작품별 `typography-profile.json` 원자 저장을 구현했고 10/10 focused test를 통과함.
- artifact: `src/shared/fontMatchingProfile*.ts`, `src/shared/fontMatchingEvidenceSchemas.ts`, `src/main/libraryStore/workTypographyProfileFiles.ts`
- 남은 실패/예외: 아직 현재 번역 pipeline이나 UI에는 연결하지 않았다. 이 범위 focused 검증은 모두 통과했고, 뒤이은 V2 결정 엔진 통합 검증에서 저장소 전체 typecheck도 통과함.

2026-08-01 / P3 최종판정 학습 export 계약

- 명령: `python -m pytest tests/python/test_export_font_matching_training_examples.py -q`, Ruff format/check, `py_compile`
- 결과: 완료된 human final/adjudication만 `raw_224/context_224/glyph_224` 실데이터, listwise tier, pairwise 순위, multi-positive retrieval 예제로 결정론적 변환한다. unfinished/unresolved, QA overlay, synthetic core, 작품 split 누출, font/render/hash 변조는 hard-fail하며 생성형 증강은 별도 train-only manifest에서 evaluation 불가로 고정했다. focused 7/7 test 통과.
- artifact: `scripts/export_font_matching_training_examples.py`
- 남은 실패/예외: 실제 pilot/final 라벨이 완료되기 전에는 학습 예제를 생성하지 않는다.

2026-08-01 / P4 순수 V2 결정 엔진

- 명령: focused Vitest, TypeScript typecheck, ESLint, Prettier, dependency architecture, architecture budget
- 결과: block lock → role lock → 작품 anchor/palette → calibrated V2 → user default/Top-3 abstain 순서를 구현했다. 번역문 glyph coverage·layout·orientation을 hard gate로 두고, 본문 hysteresis, 역할별 palette/visual-cluster 재사용, intentional override margin, 장르 style 기여 최대 10%를 적용한다. legacy 제목/정규식 fallback은 항상 false이며 33/33 focused test를 통과했다.
- artifact: `src/main/pipeline/fontMatchingDecisionV2*.ts`
- 남은 실패/예외: 현재 제품 pipeline에는 아직 연결하지 않았다. 명시적 사용자 lock이 렌더 불가일 때는 자동 폰트로 조용히 덮지 않고 abstain하며, unknown role도 hard-gate-safe한 명시적 user lock만 예외적으로 허용한다.

2026-08-01 / P1 전체 pilot 카드·실검수 원장

- 명령: canonical master/inventory/assignment를 사용한 `build_font_matching_review_cards.py build`와 독립 2회 결정론적 재빌드·전 파일 SHA 비교, 이어서 `font_matching_review_ledger.py init/validate/claim/prepare-response/submit`
- 결과: 1,200개 고유 실표본의 primary 1,200장과 secondary 255장, 총 1,455개 blind 카드를 모두 원본 크기로 한 장씩 확인했다. 가로 카드의 세로전용 후보 499칸만 명시적 `orientation_unrenderable`이며 font ID/name/model 제안 노출은 0이다. 1,458개 파일 1.75GB를 durable dataset으로 복사하고 원본과 전 파일 SHA가 일치함을 확인했다. exactly-once assignment 1,455건, 교차 단계 중복 0, 원장 무결성 오류 0이다.
- artifact: `datasets/font-matching-review-cards-pilot-v1`, `datasets/font-matching-review-ledger-pilot-v1`
- SHA-256: card manifest `e508aef74ea90efc9ea0fd5b9585af233b63a531d8d0eaa3ab4f44407731e09a`, ledger workspace record `f45185ece607d84243273a6878f06cc2c90da44b0d6eda5ed72301fd0ce56bb5`
- 남은 실패/예외: agreement gate 실패로 662건이 adjudication 대상이다. 일치한 538건은 uncontested final로 확정했으며, QA 카드는 계속 학습 입력에서 제외한다.

2026-08-01 / P3 오프라인 release 평가 계약

- 명령: `python -m pytest tests/python/test_evaluate_font_matching_v2.py tests/python/test_export_font_matching_training_examples.py ... -q`, Ruff check, CLI gate fixture
- 결과: Preferred@1, Acceptable@1/3, tier NDCG, pairwise agreement, none precision/recall/F1, selective accuracy/abstain, role/style/treatment, 작품·역할 macro와 하위 10%, 11개 핵심 cohort를 계산한다. current-rule/role-work-majority 대비 작품 bootstrap 95% CI와 장르 제거·교환 및 cohort 퇴행 gate를 기계 판정하며, frozen-test 누출·누락·중복·hash/catalog/model 불일치는 hard-fail한다. 관련 Python 회귀 61/61이 통과했다.
- artifact: `scripts/evaluate_font_matching_v2.py`, `scripts/export_font_matching_training_examples.py`
- 남은 실패/예외: 실제 final label과 학습 모델이 아직 없으므로 실데이터 release gate 실행은 의도적으로 대기한다. baseline이나 장르 variant가 빠지면 평가기는 `not_evaluable`로 기록하고 release를 거부한다.

2026-08-01 / P1 pilot 이중검수 완료와 합의 gate

- 명령: `python scripts/evaluate_font_matching_review_agreement.py --reviews datasets/font-matching-review-ledger-pilot-v1/reviews.jsonl --output datasets/font-matching-review-ledger-pilot-v1/agreement.json`, `python scripts/font_matching_review_ledger.py finalize-uncontested --workspace datasets/font-matching-review-ledger-pilot-v1 --resolver pilot-uncontested-v1`
- 결과: primary 1,200/1,200, secondary 255/255, exactly-once 1,455, 무결성 오류 0. 24작품·255개 이중검수에서 역할 macro-F1 0.6362, tier pairwise 0.5747, acceptable-set Jaccard 0.4714, none agreement 0.9412로 세 필수 gate가 모두 실패했다. 일치한 538건만 uncontested final로 확정했다.
- artifact: `datasets/font-matching-review-ledger-pilot-v1/agreement.json`, `datasets/font-matching-review-ledger-pilot-v1/finals.jsonl`
- SHA-256: workspace record `f45185ece607d84243273a6878f06cc2c90da44b0d6eda5ed72301fd0ce56bb5`, reviews `cd1ce23bdd5c45aec4a643aca85369fd3f2675638ab74e53e058d0a6709c3c5b`
- 남은 실패/예외: 662건을 원본·후보 15종·두 blind review를 대조해 제3자 adjudication한다. 이 큐와 rubric/card/tier 보정이 끝날 때까지 28,115건 전수 라벨과 학습을 시작하지 않는다.

2026-08-01 / P4 자동 맞춤 제품 경로 V2 교체

- 명령: `npm run typecheck`, `npm run typecheck:js`, focused Vitest, `npm test`, `npm run build`, `npm run qa:ui -- --entry qa.html ...`의 1,440×1,000 및 760×900 캡처
- 결과: 제품 pipeline에서 제목·본문 키워드·폰트명 정규식 기반 legacy 선택기를 제거했다. Gemma/API/Codex 출력에 15개 시각 역할과 독립 신뢰도를 추가하고, 작품 프로필·사용자 lock·glyph coverage·보수적 abstain 결정을 연결했다. 자동 맞춤 설명 문구를 실제 정책에 맞게 바꾸고 실제 `TranslationOptionsModal`을 넓은/좁은 화면에서 확인했다. 전체 Vitest와 production build가 통과했다.
- artifact: `src/main/pipeline/automaticFontMatchingV2.ts`, `src/main/runtime/font-matching-intent.cjs`, `src/main/runtime/prompts/font-matching-intent.cjs`
- SHA-256 또는 commit: 커밋 전 작업트리
- 남은 실패/예외: 실제 crop pixel encoder/ranker와 실렌더 layout 측정은 아직 없다. 따라서 semantic bootstrap 단독 결과는 신뢰도를 0으로 고정해 shadow/abstain만 허용하며, 검증된 호환 작품 프로필이나 명시적 사용자 lock이 없으면 폰트를 자동 적용하지 않는다.

2026-08-01 / P4 자동 맞춤 안전성 감사와 회귀 검증

- 명령: `npm run typecheck`, `npm run typecheck:js`, focused ESLint/Prettier/Vitest, `npm test`, `npm run build`, `npm run arch:deps`, `npm run arch:budget`, `npm run check:reexports`, `git diff --check`
- 결과: 낮은 역할·프로필 신뢰도와 근거 수, stale work/catalog/model/renderer 프로필, persisted lock 복원, keep 재번역 서식 보존, parser token injection·범위 밖 confidence·역할 모순, profile load error를 모두 fail-closed로 고쳤다. built-in 후보 metadata로 catalog 호환성을 판정하며 custom font 변화는 작품 프로필 전체를 잘못 폐기하지 않는다. 전체 Vitest 313개 파일에서 2,222개 통과·2개 skip, TypeScript/JavaScript typecheck, production build, 변경 범위 lint·format, dependency/re-export/architecture 검사가 통과했다.
- artifact: `src/main/pipeline/automaticFontMatchingV2Catalog.ts`, `src/main/pipeline/automaticFontMatchingV2Ranking.ts`, `src/main/pipeline/fontMatchingDecisionV2Compatibility.ts`
- SHA-256 또는 commit: 커밋 전 작업트리
- 남은 실패/예외: 저장소 전체 lint budget은 이번 변경과 무관한 작업트리의 인페인팅 파일 9개 오류 때문에 실패한다. 자동 적용의 실제 픽셀 retrieval과 Chromium 실측 layout evidence는 P3/P4 후속 구현 전까지 의도적으로 비활성 상태다.

2026-08-01 / P1 v2 규약·독립 calibration 표본

- 명령: `python scripts/build_font_matching_rubric_calibration.py --master-manifest C:\tmp\font-matching-master-p0-live\manifest.jsonl --inventory C:\tmp\font-matching-review-inventory-p1\inventory.jsonl --rubric docs\font-matching-v2-review-rubric-v2.md --output-dir C:\tmp\font-matching-rubric-calibration-v2`, 이어서 `font_matching_review_ledger.py plan`으로 primary/secondary 100% 이중검수 assignment 생성
- 결과: v1 pilot과 frozen test를 모두 제외한 18개 development 작품에서 작품당 최대 16개, 총 282개를 결정론적으로 선택했다. train 218/val 64이며 ordinary proxy 151, aside/free 70, SFX 42, treatment 위험군 140, OCR 위험군 35, 가로쓰기 52가 중복 cohort로 포함된다. 282개 모두 primary+secondary를 배정해 총 564 assignment이며 QA overlay·synthetic·pilot overlap·frozen test 유입은 0이다.
- artifact: `C:\tmp\font-matching-rubric-calibration-v2`, `docs/font-matching-v2-review-rubric-v2.md`
- SHA-256: rubric `e4c39bd127d3392b060669a538a344083065d3a385191378a4584e257933b0ef`, subset master `9100b9d834b344c9c06f6dbe5bc7d5151adc724deb4e4bf28acbaea7ce8046ce`, inventory `d9b31e573bea5cd1ccf2e0a0bf97834aedcd174ad473381ca913ebf6711e5bb8`, assignments `f518ce08daa4b72b1300744ac10160af54c6666c76797e30b78ee4a28e703e15`
- 남은 실패/예외: v2 독립검수는 orientation 사전감사와 카드 재봉인이 끝날 때까지 시작하지 않는다.

2026-08-01 / P1 v2 예비 카드와 orientation 사전감사 gate

- 명령: `build_font_matching_review_cards.py build ... --stage all --batch calibration`, 대표 primary/secondary 가로·세로 카드 4장을 `view_image(detail=original)`로 직접 확인, `python scripts/font_matching_orientation_audit.py build ... --shards 3 --expected-samples 282`
- 결과: 예비 blind 카드 564장, 실제 후보 패널 8,356개, 방향 미지원 104개, identity leak 0, 학습 asset 복사·수정 0. deterministic 내부 재빌드 검증을 통과했다. 대표 카드의 source page/local/raw/context/glyph, 15개 패널, header/footer는 잘림·겹침 없이 선명했고 primary/secondary 후보 순서도 독립적이었다. 그러나 실제 세로 원문을 horizontal로 표시한 metadata 오판을 육안으로 발견했다. 당시 완료된 v1 final 750건을 대조하니 69건(9.2%)에서 detector 방향과 최종 육안 방향이 달랐으므로, 예비 카드는 calibration 판정에 사용하지 않고 282건 전수 방향 검사를 먼저 수행하도록 차단했다.
- artifact: `C:\tmp\font-matching-rubric-calibration-cards-v2`, `C:\tmp\font-matching-orientation-audit-v2`
- SHA-256: card manifest `9a047e0c9766888f5b7ea76769afd8c6fad0106f1dc0922cb879f79246ed595b`, orientation tasks `849ae274d64078ffe54462087ef57c6874fcbe1b3cc2df0ebc99e99c3fe9cfed`
- 남은 실패/예외: 3개 shard 각 94건을 original detail로 전수 확인하고 horizontal/vertical/mixed/unknown 및 recrop 상태를 확정한 뒤, 고친 방향으로 564장을 다시 렌더·봉인해야 한다.
