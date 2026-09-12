# Issue #99: Flux multi-GPU binding handoff

## Branch and scope

- Issue: https://github.com/ucx0204/CarrotMangaTranslator/issues/99
- Working branch: `fix/issue-99-flux-gpu-binding`, created from `master`.
- Keep checkpoint commits on this branch. Do not squash, merge to master, bump the app version, or publish runtime assets during this work.
- The user will squash the finished branch later.

## Evidence and working diagnosis

The report shows `CUDA_ERROR_INVALID_PTX` while loading the Flux transformer on a machine with an RTX 3080 Ti and RTX 5070 Ti. The reported GPU is a best-GPU inventory result, not proof of the worker's actual device. The last `auto` in the report's inpainting line is `koharuBackend`, not `hardware.computeGpuIndex`.

In the reviewed implementation, automatic Flux runner selection uses the compute capability of the highest-VRAM NVIDIA GPU, but the worker is not bound to that physical GPU. Koharu initializes visible CUDA device 0. Explicit selection also queries a device through nvidia-smi and passes a numeric ordinal to CUDA independently. A mismatch is possible; the user's actual runtime path and CUDA device log still need to be compared before declaring the reported machine reproduced.

## Implementation plan

1. Resolve the physical NVIDIA device identity and compute capability together. Reuse the existing hardware-query boundary rather than introduce a second independent best-GPU policy.
2. Bind the Flux CUDA worker to that identity using `CUDA_VISIBLE_DEVICES=GPU-...`; runner selection, cache identity, and diagnostics must use the same selection.
3. Cover automatic mixed-generation selection, explicit selection, malformed/failed probes, environment precedence, and non-CUDA backends with regression tests.
4. Record requested and selected GPU identity in diagnostics. Do not call an inventory result the actual worker device.

Numeric settings are shared by several backends. Avoid silently claiming that a CUDA, HIP, Vulkan, Windows graphics, and nvidia-smi ordinal are interchangeable. Preserve unrelated backend behavior and document remaining cross-backend limitations.

## Checkpoint status

- [x] Read root AGENTS.md and architecture rules.
- [x] Create the isolated branch.
- [x] Save diagnosis, intended scope, and resumption checklist before code changes.
- [ ] Add physical-device selection contract and tests.
- [ ] Integrate Flux runner/environment/cache binding.
- [ ] Improve diagnostics and regression coverage.
- [ ] Run available checks and record exact results.
- [ ] Confirm branch contents and no master changes.

## Validation environment

The current editing session can read/write GitHub through the authorized connector. Direct git/network access from the execution container is unavailable (`Could not resolve host: github.com`). A full repository checkout and dependency install have not been obtained. Do not report `npm run check`, typecheck, lint, build, CI, or real GPU execution as passed unless they actually run. Focused offline checks may be possible and must be distinguished from the full repository suite.

## Resume

Read this file, then inspect the branch's latest commits and any current diff. Read `AGENTS.md`, `docs/architecture.md`, the GPU query/selection code, `src/main/inpainting/fluxEnginePool.ts`, `src/main/inpainting/fluxWorkerEnv.ts`, `src/main/inpainting/computeGpuEnv.ts`, and the relevant tests before continuing. Keep new code changes in separate checkpoint commits with results and remaining work recorded here.

Hardware acceptance still requires the reported mixed-generation setup: automatic and explicit selections must show matching runner SM target and worker CUDA device 0; single-GPU and non-CUDA paths must remain functional.
