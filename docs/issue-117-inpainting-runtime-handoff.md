# Issue 117: Koharu runtime repair and portable CUDA runner

## Code changes

The shared CUDA installer now includes cuFFT and rejects missing, empty,
non-file DLLs and mismatched CUDA/cuDNN cache markers. The native runner
preloads cuFFT before accepting inference requests.

Before a ZLUDA worker starts, the host verifies the six canonical DLLs using
pinned byte sizes and SHA-256 hashes. It installs only `zluda/<name>` entries;
`zluda/trace/` contains duplicate names and must not overwrite the normal DLLs.
Failed repairs leave the old runtime intact. Both the AMD ZLUDA bundle and the
shared cuRAND support installer use staging and rollback publication. The
native bootstrap also rejects empty/non-file DLLs and excludes trace entries.
This preserves the distinct NVIDIA cuFFT and AMD ZLUDA library contracts.

Backend routing is covered with NVIDIA RTX 20/30/40/50, Radeon RX 6000/7000/9000,
Intel Arc/integrated, no-GPU and Metal inputs. These are code-level tests, not
hardware certification. Intel-only Windows machines retain the existing CPU
backend; no Intel GPU accelerator has been implemented or claimed.

## Portable native artifact

The parent tracked executable contains only `.target sm_89` embedded PTX.
The replacement was built from the changed source with CUDA 12.9 and explicit
`CUDA_COMPUTE_CAP=75`, rather than inferring the build host's GPU. Its embedded
PTX target inventory contains only `.target sm_75`.

NVIDIA documents PTX forward compatibility with higher compute capabilities:
https://docs.nvidia.com/cuda/ada-compatibility-guide/index.html#application-compatibility-on-the-nvidia-ada-gpu-architecture
https://docs.nvidia.com/cuda/blackwell-compatibility-guide/index.html

This removes the newer-target-only kernel obstacle on RTX 20/30 while providing
forward-JIT PTX for later NVIDIA GPUs. Driver, other libraries, performance,
AMD translation and actual inference are separate compatibility requirements.

The tracked Windows executable has been replaced, not only its build script.
`npm run build:koharu-cuda-runner` reproduces the pinned target and checks the
CUDA toolkit version. Windows thin packaging checks embedded PTX and rejects
missing, mixed, architecture-specific or newer-only targets.

| Artifact           |    Bytes | SHA-256                                                            |
| ------------------ | -------: | ------------------------------------------------------------------ |
| Parent executable  | 30087168 | `243ef2a2b05e39a3b2d4d0a26f9833af83d787e5c364f6b70c2b8aadf7807bc5` |
| Updated executable | 26418176 | `eafb45245c28fcff30d6f69c0423b3e3e81591b3334481231384cf6d58326c48` |

## ZLUDA integrity source

The existing native runner release is retained:
https://github.com/vosen/ZLUDA/releases/tag/v6-preview.65

Archive: `zluda-windows-5c75a54.zip`, 32,880,554 bytes,
SHA-256 `4a8d04f51a642f358b561482f39cd706639c4329fb685e0156884dee46a43ec1`.
The downloaded bytes matched the GitHub asset digest. Per-DLL hashes and sizes
are pinned in `src/main/inpainting/koharuZludaManifest.ts`.

A separate real-archive smoke called the production installer with the original
ZIP, verified all six extracted canonical DLLs, truncated cuFFT to zero bytes,
and confirmed repair from the verified archive. An initial incorrect nvcuda
inventory entry failed this check and was corrected before committing. This
checks installation without pretending to execute an AMD GPU.

## Validation on 2026-09-19

- Focused Vitest: 9 files, 100 tests passed, including existing Flux/Metal and
  device-routing tests as well as the new runtime/build regression cases.
- Native `cargo test --release --locked`: 11 tests passed, including both new
  native bootstrap tests.
- Real pinned ZLUDA installer/repair smoke: passed.
- TypeScript, Electron TypeScript, checked JavaScript, focused lint, test mock
  boundaries, architecture rules, script entrypoints and generated-file guard:
  passed. Native executable contains no local Windows user path.
- No new GPU hardware inference or packaged installer validation is claimed.
  The earlier RTX 4090 report applies to the parent artifact, not this build.

No release assets/tags have been overwritten and no app version changed.
Rollback this change as a source-and-binary unit; restoring the old executable
alone would fail the new packaging guard and reintroduce the sm_89-only target.
