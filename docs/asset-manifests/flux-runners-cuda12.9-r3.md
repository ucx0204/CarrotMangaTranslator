# Flux CUDA 12.9 runner r3 handoff

- Release: <https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/flux-runners-cuda12.9-r3>
- Producer commit: `cc51734daad62e87231959c3ab8ee82369d6ef09`
- Release state: prerelease, asset-only, immutable
- Inventory authority: [`flux-runners-cuda12.9-r3.json`](./flux-runners-cuda12.9-r3.json)
- Checksums: [`flux-runners-cuda12.9-r3-SHA256SUMS.txt`](./flux-runners-cuda12.9-r3-SHA256SUMS.txt)

## SM75 correction

RTX 20-series compute capability 7.5 uses the chunked-attention compatibility path. The r2 runner forced both the quantized Flux transformer compute and VAE to FP16. A real manga crop reproduced the reported failure as an opaque black inpainted rectangle. Holding the input, mask, steps, crop size, VAE and attention implementation fixed showed:

- transformer FP16: black output, peak GPU allocation delta `3,858 MiB`;
- transformer FP32 and VAE FP16: correct light inpainting, peak delta `3,857 MiB`.

VAE-only FP32 and FP32 attention accumulation did not correct the failure. The r3 SM75 runner therefore changes only transformer compute to FP32 and keeps the VAE in FP16. Its runtime hardware gate remains exactly compute capability 7.5.

The controlled reproduction used the same SM75 execution policy in a diagnostic SM89 build because the build host has an RTX 4090. The strict SM75 release binary was separately rebuilt with `CUDA_COMPUTE_CAP=75`; an RTX 2070 Super hardware confirmation remains external to this release process.

## Publication verification

All eight release assets were uploaded without replacement and downloaded again into a new empty directory. Server name, count, byte size and SHA-256 matched the pre-upload inventory. Each ZIP contained exactly one root entry, `mgt-flux-klein.exe`; extracted executable size and SHA-256 also matched the bound manifest.

After publication, [`constants.ts`](../../src/main/inpainting/fluxAssets/constants.ts) was switched to the r3 base URL and SM75 archive SHA. A cold install from a new empty tools directory and runtime root downloaded the real GitHub asset, verified its archive hash, safely extracted it, wrote the cache marker and ran `mgt-flux-klein.exe --help`. Existing r2 cache entries are invalidated by the changed URL and archive SHA in the marker contract.

The source-tree SM75 generic alias at `tools/mgt-flux-klein/mgt-flux-klein.exe` was replaced with the remotely re-downloaded r3 executable (`c303d074…f79442`) as well. Source and development runs therefore cannot select the old FP16-transformer binary ahead of the remote asset.

## Rollback

Do not modify or delete r3 assets. Roll back the consumer in a new commit by restoring the r2 release tag and the r2 SM75 archive SHA in `constants.ts`. The r2 and r3 releases remain immutable for reproducibility.
