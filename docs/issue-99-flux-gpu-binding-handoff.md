# Issue #99: Flux multi-GPU binding handoff

## Branch and scope

- Issue: https://github.com/ucx0204/CarrotMangaTranslator/issues/99
- Working branch: `fix/issue-99-flux-gpu-binding`.
- Original base: `6b03c112baad4c2bb6dd9b5a6e5a2df3d693696a` on `master`.
- PR for review and CI: https://github.com/ucx0204/CarrotMangaTranslator/pull/100
- Keep incremental checkpoint commits on the working branch. The user has now
  authorized integrating current master, fixing CI failures, and squashing the
  completed branch into master as exactly one commit after Actions pass.
- Do not bump the app version or publish runtime assets as part of this work.

## Evidence and working diagnosis

The report shows `CUDA_ERROR_INVALID_PTX` while loading the Flux transformer
on an RTX 3080 Ti + RTX 5070 Ti machine. The report's GPU is a best-GPU
inventory result, not proof of the worker's actual device. The final `auto`
in its inpainting line is `koharuBackend`, not `hardware.computeGpuIndex`.

Automatic Flux runner selection previously used the highest-VRAM NVIDIA
GPU's compute capability while Koharu initialized visible CUDA device 0
without binding to that GPU. Explicit selection queried nvidia-smi by index
but independently passed the number as a CUDA ordinal. The runner and worker
could therefore target different physical GPUs. The reported machine's
actual runner path and CUDA device logs still need to be compared; this
session has not reproduced the crash on physical GPUs.

## Checkpoints

- `a0be5e2`: diagnosis, branch scope, and resumption record.
- `50843cc`: preserve and validate the NVIDIA UUID from the same query as
  compute capability; add hardware-selection regression coverage.
- `01ad435`: bind pooled and direct Flux engine launches to one device
  snapshot; add UUID-aware environment isolation and cache identity.
- `ac00e75`: add requested GPU and selected device fields to the existing
  worker-start log, verify UUID transmission through a real child process,
  and remove redundant cancellation checks from the pool.
- `3969402`: address source formatting failures from the initial CI run.
- `47621be`: integrate master `5cca33a507acb9b22b0dffbbbde601af074614ea`
  without rewriting checkpoint history. GitHub's merge tree had no conflicts;
  upstream Codex quota classification and checkpoint test changes are retained.

- `1acc8d9`: update the handoff and record conditional squash authorization.
- `b4a9ee3`: add an isolated, temporary formatter/lint diagnostic workflow.
  The subsequent CI-fix checkpoint removes it before final validation.
- CI-fix checkpoint: use exact Prettier output for checkbox continuation
  indentation and extract the existing SM75 guard from pool orchestration.
  No lint limit, test, or existing Check workflow is weakened.

## Implemented contract

- `src/main/gpuInfo.ts`: reuse the existing NVIDIA query and highest-VRAM
  policy. Obtain name, memory, capability, and UUID in one response. Explicit
  selection remains the existing `nvidia-smi --id=<index>` query; malformed
  indices and ambiguous explicit responses do not fall back to another GPU.
- `src/main/inpainting/fluxCudaDevice.ts`: resolve and validate one physical
  device snapshot. CUDA launch fails before runtime/model preparation when
  UUID or capability cannot be established. Legacy inventory probing may
  retain a name/UUID with null capability, but Flux does not guess an SM target.
- `src/main/inpainting/fluxEnginePool.ts`: use the snapshot's capability for
  runner selection and its UUID in the lease key; pass that same snapshot to
  preparation rather than independently probe again.
- `src/main/inpainting/fluxEngineLaunch.ts` and `src/main/inpainting.ts`: direct
  engine callers, including diagnostic scripts, use the same binding path.
  A legacy capability-only hint cannot override the actual device's capability.
- `src/main/inpainting/computeGpuEnv.ts` and `fluxWorkerEnv.ts`: pass the full
  UUID in `CUDA_VISIBLE_DEVICES`; it wins over a numeric setting and conflicting
  launch visibility variables. The selected GPU is visible to CUDA as device 0.
- `src/main/inpainting/fluxWorker.ts`: worker-start diagnostics contain
  `requestedComputeGpuIndex`, `selectedCudaDevice` (UUID, name, capability),
  and the existing executable/runtime path. These are selected-device fields,
  not proof of runtime use; compare with the runner's existing
  `mgt-flux-klein: CUDA device 0` stderr probe.

CPU, Metal, AMD, low-level numeric compatibility, OCR, and Gemma routing are
not redesigned. In particular, a shared number is still not a guarantee of
identical devices across CUDA, HIP, Vulkan, and Windows graphics enumeration.
This branch fixes Flux runner/device consistency, not every backend's UI
selection semantics. It does not rebuild or replace native runtime assets.

## Validation history

- 25/25 focused cases passed in the initial offline Node 22 / TypeScript harness
  executing the production modules and the three new test files. A small
  assertion adapter substituted for Vitest; this was not a full Vitest run.
- The focused cases covered mixed-generation auto selection, reversed inventory
  order, explicit index zero, UUID precedence, malformed/missing metadata,
  fallback probing, non-CUDA routing, SM75 binding, direct/pool snapshot use,
  cancellation, and a real Node child process receiving the UUID environment.
- Initial syntax parsing: 15 source/test files, zero parse errors. This was
  not semantic typechecking or a build.
- Initial Check run `34678106135` for `01ad435`: the macOS job passed
  `typecheck`, `typecheck-electron`, and `typecheck-js`, then failed formatting
  in four source/test files. Those source formatting failures were corrected.
- Check run `34678431946` for `3969402`: both jobs failed at formatting.
  The macOS log confirms all three typecheck gates passed and the only
  remaining format diagnostic was this handoff document. Later gates did not
  run. The follow-up document fix does not weaken or skip any check.
- Diagnostic run `34682163595` exported Prettier 3.8.3 and its exact document
  output. Targeted lint reported one error: `acquireFluxInpaintingEngine`
  complexity 14 versus the existing limit of 12. The CI-fix checkpoint extracts
  its unchanged SM75 validation guard into a private helper.
- Inspect the latest PR head's Actions run for current results. Do not treat
  a queued, superseded, or partially successful run as complete validation.
- Actual mixed-generation CUDA execution and packaged app acceptance have not
  been performed in this editing environment. It has no direct GitHub/npm DNS
  access or full repository dependency installation; use the existing CI gates
  for repository-wide validation and keep hardware limitations explicit.

## Coverage inventory follow-up

Check `34682489240` reached the full test suite. Windows passed 6,542 tests
and failed only the coverage-inventory assertion; macOS had the same sole
failing assertion. All new GPU tests passed. The inventory was missing five
previously existing files touched by this fix and the two new Flux modules.

Checkpoint `6b45ab0` adds actual pool preflight tests for SM75 mismatch,
unknown architecture, invalid indices and cancellation. Only the child-process
boundary is mocked; no GPU assets or workers are launched. The isolated
validation in run `34683341705` passed the inventory test, new preflight tests,
existing GPU tests, targeted lint and formatting.

The inventory follow-up preserves every old floor, its provenance fields and
the deletion list unchanged. It adds five existing-file floors measured on
master `5cca33a` and two introduced-module floors from `2bf6230`. Exact ratios,
not rounded-percent approximations, remain enforced. The gate's independent
Git-derived scope stays active; expected counts become 718 existing, 623
introduced, and 10 deleted files.

Evidence for these seven added records supplements, rather than replaces,
the manifest's original cleanup provenance:

- Existing-file measurements: Windows Check `34677858384`, artifact
  `10292509960`, coverage-summary SHA-256
  `569c956bbc2a4e48965de58b8e87668ebc3bffb4d9d7006bd992409329317c75`.
- Introduced-module measurements: Windows Check `34682489240`, artifact
  `10295385137`, coverage-summary SHA-256
  `eeef47c3cbfb8cbc4112c98173139fab170c18014516e4638cbd78e03ae3cf57`.
- The artifact archives were independently downloaded and checked against
  their GitHub SHA-256 digests before extracting these records. The generated
  manifest was compared with the original: exactly seven entries were added;
  all 1,334 pre-existing floor records are unchanged as parsed values.
- Temporary workflow `b18239f` created only immutable Git blobs, never commits
  or branch updates. Its successful run `34683341705` produced manifest blob
  `d1f9bbf4f665b440ed78cc34287effbcb3bd0ad0` and scope-test blob
  `e934e687c3709f75da3da494c66ae202acbfe414`. Both were downloaded and verified
  before the connector committed them. The workflow is removed in that commit.

The next full Check must still pass on both supported CI platforms before
the authorized squash. No coverage threshold or test assertion is removed.

## Resume and acceptance checklist

Read this document and the branch's newest commits first. Then read
`AGENTS.md`, `docs/architecture.md`, and the changed modules/tests. Keep
subsequent fixes in new checkpoint commits. Final CI and merge evidence can
be recorded in PR #100 without changing the already-validated source tree.

```sh
git fetch origin
git switch fix/issue-99-flux-gpu-binding
git log --oneline -10
npm ci
npx vitest run tests/nvidiaGpuSelection.test.ts tests/fluxCudaDevice.test.ts tests/fluxEngineLaunch.test.ts tests/computeGpuRuntimeRouting.test.ts tests/gpuInfo.test.ts tests/fluxWorker.test.ts
npm run check
```

- [x] Isolated branch and incremental remote commits.
- [x] Physical NVIDIA identity + capability contract.
- [x] Flux runner/environment/lease binding, including direct engine callers.
- [x] Selection diagnostics and focused regression tests.
- [x] Offline focused assertions and syntax checks.
- [x] Integrate master `5cca33a` without conflicts or discarded changes.
- [ ] Inspect current-head CI; fix actual failures in new commits.
- [ ] Verify master has not moved beyond the tested integration base.
- [ ] After all Actions pass, squash PR #100 into one master commit.
- [ ] Full repository validation and packaged app smoke.
- [ ] Mixed RTX 3080 Ti + RTX 5070 Ti hardware acceptance: automatic selection
      and each explicit selection must pair the correct SM runner with the
      worker's CUDA device 0. Confirm an actual page completes.
- [ ] Single-GPU, CPU, Metal, and AMD regression acceptance.
- [ ] Confirm cache reuse for the same UUID and replacement for a different
      UUID, including same-architecture GPUs, under the full integration suite.

Before the authorized squash, rollback is to discard/revert the branch's
changes. After squash, revert the single resulting master commit. No user
library data, version, or published runtime assets are changed by this fix.
