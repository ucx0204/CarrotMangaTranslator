# FLUX Vulkan Windows x64 r1

- Immutable asset release: <https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/diffusion-master-929-vulkan-win-x64-r1>
- Inventory: [flux-vulkan-win-x64-r1.json](flux-vulkan-win-x64-r1.json).
- Producer source commit: `8d373ec5c4a2b3e80c53786ce723bb5c867b2d8f`.
- stable-diffusion.cpp: `3f8527a46c54ecf4cb4ed6003da8e8982283c73c`; ggml: `89c4413f5da6fb20cc796f16033d37f129be81fd`.
- The archive contains exactly `stable-diffusion.dll` and `mgt-flux-klein-vulkan.exe` at its root. No SDK, driver, model, log, or development sidecar is distributed.

## Production contract

`vulkan-native` is an explicit Windows FLUX option. Existing AMD default selection remains ROCm when supported, CPU otherwise. The current CUDA, ROCm and Metal packages and cache versions are unchanged. LaMa/AOT do not accept Vulkan.

`nativeInferencePlan` installs only the shared MSVC package and the Vulkan archive, with a dedicated `-vulkan-r1` cache suffix. `nativeInferenceRuntime` includes the packaged executable in its required inventory and repairs modified or omitted executable receipts. `nativeInferenceLaunch` uses that verified executable. The Vulkan runner rejects other backend manifests and requires `Vulkan0`; no CPU fallback is allowed. `GGML_VK_VISIBLE_DEVICES` isolates the selected physical Vulkan adapter before the runner sees logical device zero. Automatic selection uses adapter zero, matching the existing manual GPU-index contract.

The app retains the existing model, crop, mask and final-composite algorithms. The native runner returns a candidate crop; only the production app composite owns writes to final pixels. Checking mask-exterior identity on the raw runner candidate would test the wrong boundary.

## Rebuild

Use a clean ASCII-path checkout of the exact diffusion commit with its pinned submodules. Use an isolated Vulkan SDK; the producer used LunarG 1.4.363.0, SHA-256 `94a82d378f7a5e3e54c9db7d2fb7016af136e14ac0a18dbf0f2f67a36352d141`, extracted with `copy_only=1`. The end user needs a Vulkan graphics driver, not this SDK.

```powershell
$env:VULKAN_SDK = '<isolated-sdk>'
./scripts/build-native-diffusion-cpu.ps1 -SourceDirectory <pinned-source> -BuildDirectory <new-build> -CMake <cmake-4-executable> -Vulkan
$env:LIBCLANG_PATH = '<isolated-libclang-directory>'
$env:CARGO_TARGET_DIR = '<isolated-runner-build>'
cargo build --release --locked --no-default-features --features vulkan --manifest-path tools/mgt-flux-klein-runner/Cargo.toml
```

The historical CPU build script now accepts `-Vulkan`; its default remains CPU. System CMake 3.31.8 crashed with status `3221226505` while configuring this upstream tree. An existing isolated CMake 4.x completed the same clean source build. No upstream source patch was needed.

Package an explicit two-file list with `scripts/package-native-inference-release.cjs`, renaming the runner to `mgt-flux-klein-vulkan.exe`. The manifest binds archive and extracted-file names, lengths and hashes. Publish to a new asset-only prerelease, never replace this release.

## Verification and rollback

Both server assets (ZIP and `manifest.json`) were downloaded into a new empty `.tmp/flux-vulkan-r1-verify` directory. Server names/count/sizes, downloaded bytes and hashes matched staging. The existing package validator also verified every extracted member and rejected unsafe paths.

The production `prepareFluxWorkerLaunch` then installed the real remote package into a fresh `.tmp/flux-vulkan-remote-*` runtime root, without local runner overrides or a migrated runtime cache. `createFluxEngine` loaded that executable and completed inference/compositing; its receipt is `C:/tmp/carrot-vulkan-179/remote-production-receipt.json` (4,096 changed selected pixels, zero changed exterior pixels). Existing pinned model weights were read without modification. The GPU's shader cache is independent of the empty app runtime cache; these runs are correctness checks, not cold-driver benchmarks.

Local execution used RTX 4090, NVIDIA driver 610.88, Vulkan 1.4.341. A real four-step 256×256 inference completed through Vulkan. The production `createFluxEngine` composite changed 4,096 selected pixels and zero unselected pixels. Radeon hardware is unavailable on this machine: AMD routing is covered by automated tests, not a claim of Radeon hardware validation. QA captures remain at `C:/tmp/carrot-vulkan-179/ui-wide.png` and `ui-narrow.png`.

A 624×320 manga fixture also completed through the downloaded runtime and production composite: 68,478 changed pixels inside the mask, zero outside. The rendered result was inspected (`C:/tmp/carrot-vulkan-179/manga-output.png`, `manga-receipt.json`). Selecting nonexistent Vulkan adapter 999 exited with an unavailable-device error and explicitly disabled CPU fallback (`invalid-gpu.log`).

The v3.8.11 checks above supplied model paths directly to the worker. The shipped app omitted those paths when starting from `prepareFluxInpaintingEngine`, as reported in [#179](https://github.com/ucx0204/CarrotMangaTranslator/issues/179#issuecomment-6903635803). The app now prepares the three model arguments for every native FLUX backend. The regression test in `tests/fluxVulkanEngine.test.ts` captures the worker command from that entry point. After the fix an Electron run starting at the same entry point installed the published package into an empty runtime directory and completed a 256×256 inpaint on RTX 4090 (4,096 selected pixels changed, zero outside). This smoke used the existing model files and let the app resolve and verify them.

Consumers: `src/main/runtime/native-inference-manifest.json`, `src/main/runtimeSupport/nativeInferencePlan.ts`, `src/main/inpainting/fluxAssets/workerLaunch.ts`. Rollback is to select the unchanged ROCm or CPU backend, or revert the app commit adding Vulkan. Preserve immutable published assets and original producer outputs.
