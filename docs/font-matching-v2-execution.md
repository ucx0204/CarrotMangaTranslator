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
- [x] deterministic blind candidate order
- [x] primary/double/adjudication assignment 계약과 exactly-once 불변식
- [ ] 프로덕션 렌더러 기반 후보 카드
- [x] 1,000–1,200건 pilot inventory
- [ ] pilot 역할 합의 macro-F1 ≥ 0.85
- [ ] pilot tier pairwise 합의 ≥ 0.80
- [ ] pilot acceptable-set Jaccard ≥ 0.70
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

- [ ] `WorkTypographyProfile` 저장·마이그레이션
- [ ] 지속 가능한 semantic role과 intentional override
- [ ] page batch local inference와 prototype cache
- [ ] 번역문 coverage/layout rerank
- [ ] 사용자 block/work lock 우선순위
- [ ] 기존 수동 폰트 무덮어쓰기 회귀 테스트
- [ ] 현행 제목/정규식 엔진 제품 fallback 제거
- [ ] 실제 UI 렌더 QA, typecheck, lint, tests, build 통과

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
