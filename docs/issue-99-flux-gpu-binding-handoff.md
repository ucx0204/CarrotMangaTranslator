# Issue #99: Flux multi-GPU binding handoff

## Branch and scope

- Issue: https://github.com/ucx0204/CarrotMangaTranslator/issues/99
- Working branch: `fix/issue-99-flux-gpu-binding`.
- Base commit: `6b03c112baad4c2bb6dd9b5a6e5a2df3d693696a` on `master`.
- Draft PR for review and CI: https://github.com/ucx0204/CarrotMangaTranslator/pull/100
- Keep checkpoint commits. Do not squash, merge to master, enable auto-merge,
  bump the app version, or publish runtime assets without a separate request.
  The user will squash the finished branch later.

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

1. `a0be5e2`: diagnosis, branch scope, and resumption record.
2. `50843cc`: preserve and validate the NVIDIA UUID from the same query as
   compute capability; add hardware-selection regression coverage.
3. `01ad435`: bind pooled and direct Flux engine launches to one device
   snapshot; add UUID-aware environment isolation and cache identity.
4. `ac00e75`: the diagnostics/handoff checkpoint adds requested
   GPU and selected device fields to the existing worker-start log, verifies
   UUID transmission through a real child process, and removes redundant
   cancellation checks from the pool.
5. A follow-up style checkpoint addresses the formatting failures reported by
   the first CI run. Inspect the latest head checks before considering it passed.

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

## Validation recorded in this session

- 25/25 focused cases passed in an offline Node 22 / TypeScript harness that
  executes the production modules and the three new test files. A small
  assertion adapter substitutes for Vitest; this is NOT a full Vitest run.
- The focused cases cover mixed-generation auto selection, reversed inventory
  order, explicit index zero, UUID precedence, malformed/missing metadata,
  fallback probing, non-CUDA routing, SM75 binding, direct/pool snapshot use,
  cancellation, and a real Node child process receiving the UUID environment.
- TypeScript syntax parsing: 15 source/test files, zero parse errors. This is
  NOT semantic typechecking or a build.
- Full checks were requested through draft PR #100. Initial Check run
  `34678106135` for `01ad435`: the macOS job passed `typecheck`,
  `typecheck-electron`, and `typecheck-js`, then failed formatting in
  `gpuInfo.ts`, `fluxCudaDevice.ts`, `fluxEnginePool.ts`, and
  `nvidiaGpuSelection.test.ts`. The branch includes a follow-up style fix;
  success must still be confirmed on the current head. Later gates did not run.
- Full Vitest, semantic typecheck, formatting, lint/architecture checks, build,
  packaged app behavior, and actual CUDA hardware execution are not recorded
  as passed here. The editing container has no direct GitHub/npm DNS access
  and no full repository dependency installation.

## Resume and acceptance checklist

Read this document and the branch's newest commits first. Then read
`AGENTS.md`, `docs/architecture.md`, and the changed modules/tests. Keep
subsequent fixes in new checkpoint commits and update this record.

```sh
git fetch origin
git switch fix/issue-99-flux-gpu-binding
git log --oneline -8
npm ci
npx vitest run tests/nvidiaGpuSelection.test.ts tests/fluxCudaDevice.test.ts tests/fluxEngineLaunch.test.ts tests/computeGpuRuntimeRouting.test.ts tests/gpuInfo.test.ts tests/fluxWorker.test.ts
npm run check
```

- [x] Isolated branch and incremental remote commits.
- [x] Physical NVIDIA identity + capability contract.
- [x] Flux runner/environment/lease binding, including direct engine callers.
- [x] Selection diagnostics and focused regression tests.
- [x] Offline focused assertions and syntax checks.
- [ ] Inspect current-head CI; fix actual failures in new commits.
- [ ] Full repository validation and packaged app smoke.
- [ ] Mixed RTX 3080 Ti + RTX 5070 Ti hardware acceptance: automatic selection
  and each explicit selection must pair the correct SM runner with the
  worker's CUDA device 0. Confirm an actual page completes.
- [ ] Single-GPU, CPU, Metal, and AMD regression acceptance.
- [ ] Confirm cache reuse for the same UUID and replacement for a different
  UUID, including same-architecture GPUs, under the full integration suite.

No master merge, release, version bump, or squash was performed by this work.
Rollback is to discard/revert this branch's changes before the user-controlled
squash; no user library data or runtime release assets were modified.
