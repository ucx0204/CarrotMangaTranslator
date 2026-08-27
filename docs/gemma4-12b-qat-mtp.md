# Gemma 4 12B QAT + MTP production handoff

## Production selection

The Gemma settings UI exposes `12B speed` (Korean: `12B 속도`) as a built-in
Hugging Face preset.
It selects the QAT 4-bit model and matching multimodal projector. On the NVIDIA
CUDA 12 and RTX 50 runtime profiles it also enables the repository's Gemma 4 MTP
head with llama.cpp `draft-mtp`. Other runtime profiles keep the QAT model but
do not advertise MTP until that path is validated.

Source model:
[HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced](https://huggingface.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced)

- Pinned revision: `ae8045ac2bd216293ca49a3065da2c942dde4b68`
- Main model: `Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf`
  - Bytes: `7,381,381,760`
  - SHA-256: `59656d7494d6376ca97e9e20b64ea2e16cd97f12ec6d47bfccba91cb785b5134`
- Multimodal projector:
  `mmproj-Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf`
  - Bytes: `175,115,264`
  - SHA-256: `b59e815479b7e5f0665bd29e6784c104a368092bcbc63120148c606f9276ab8e`
- MTP head: `mtp-gemma-4-12B-it.gguf`
  - Bytes: `253,707,328`
  - SHA-256: `c50c91c35f04903815b2e8930cbb8c8c5bee0e1aa00748c30a7b8ff05d2310b4`

The previously configured `akpsahan` mirror carried these same three immutable
payloads: file names, byte sizes, Git LFS object hashes, and SHA-256 values all
match the official `HauhauCS` repository. The source/revision migration therefore
does not invalidate the existing chapter-14 benchmark and requires no rerun.

The application downloader and `npm run verify:hf-assets` use these exact
revision, size, and digest bindings.

## llama.cpp runtime

The speed presets use the official
[llama.cpp b10621 release](https://github.com/ggml-org/llama.cpp/releases/tag/b10621)
on CUDA, Vulkan, and Apple Silicon Metal. Legacy presets keep their existing
b9553/b9547/BeeLlama routing and installed directories; selecting a speed model
does not replace a legacy runtime in place.

Pinned current speed archives:

| Runtime asset         |       Bytes | SHA-256                                                            |
| --------------------- | ----------: | ------------------------------------------------------------------ |
| b10621 CUDA 12 binary | 250,464,283 | `81c2ff62e14b549cd5c766ccdd5c61f09e821a171655c3047bdccfddc2d1a1e2` |
| b10621 CUDA 12 cudart | 391,443,627 | `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6` |
| b10621 CUDA 13 binary | 146,446,450 | `23549ccc00b6a18d74348e95d4789f7e96c9efb11cf6e3f1b185baef34d7449f` |
| b10621 CUDA 13 cudart | 390,970,417 | `1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e` |
| b10621 Vulkan binary  |  34,403,304 | `2672d85bf87c8280d94dee01eb6a86280046878f70a07d786a93637fa9081163` |
| b10621 macOS arm64    |  10,954,823 | `429c8270608600188035e5e92f7d78dffb7900904fe7dd7e6a84f48068cd13cf` |

AMD ROCm speed routes retain Lemonade's Windows build, now pinned to the latest
[b1317 release](https://github.com/lemonade-sdk/llamacpp-rocm/releases/tag/b1317).
All seven supported gfx assets are bound to GitHub's published byte sizes and
SHA-256 digests. Their remote ZIP central directories were audited for safe
selected paths and for `amdhip64_7.dll`, `ggml-hip.dll`, `hipblas.dll`,
`rocblas.dll`, and `llama-server.exe`. The official llama.cpp b10621 Windows
ROCm archive is not used because its published package omits required ROCm
dependencies. Windows runtime publication continues to retry transient
Defender/file-lock failures without replacing a valid installed runtime.

### Production speed preset contract

The CUDA `12B speed` route uses the following measured settings. These are
model-specific overrides for the authentic HauhauCS QAT model; the existing
`12B minimum` model remains on the ordinary minimum preset.

| Setting                    |             Production value |
| -------------------------- | ---------------------------: |
| Context                    |                       16,384 |
| Batch / ubatch             |                1,024 / 1,024 |
| Dedicated-VRAM fit reserve |                      512 MiB |
| KV cache                   | Q4_0 K / Q4_0 V, GPU offload |
| Multimodal projector       |                  GPU offload |
| MTP speculative window     |                    `n_max=8` |

The speed route now deliberately inherits the same 1,024/1,024 batch contract
as `12B minimum`. A 1,024-token image still fits in one micro-batch, while the
smaller transient buffers reduce WDDM process pressure for lower-VRAM users.
The 512 MiB common fit target and `n_max=8` MTP window are unchanged.

On Windows CUDA, MTP speed models also run a short multimodal startup probe.
If actual image-path headroom misses the requested target, the app may restart
the server once with a runtime-only 512 MiB layer-sized correction and reports
the exact change in a toast. It does not overwrite the saved 512 MiB default.

The following table preserves the historical MTP-window selection run. It used
2,048/1,536 for both columns and established `n_max=8`; it is not the current
batch confirmation. The three frozen OCR payloads and the complete production
finishing path were identical.

| Metric                        | MTP `n_max=16` | MTP `n_max=8` |                                    Result |
| ----------------------------- | -------------: | ------------: | ----------------------------------------: |
| Translation request wall time |        38.80 s |       32.18 s |                             17.1% shorter |
| Main decode weighted rate     |    142.0 tok/s |   169.6 tok/s |                              19.4% faster |
| Main output tokens            |          2,218 |         2,207 |                  comparable output volume |
| Main MTP acceptance           |          47.4% |         70.3% | shorter window accepted more consistently |
| llama-phase board VRAM peak   |     13,036 MiB |    12,884 MiB |                             152 MiB lower |

The one-page screen produced the same direction with a 318 MiB lower llama
peak. Because Windows WDDM exposes board-wide `memory.used`, the production
claim is intentionally limited to a small VRAM reduction rather than treating
either absolute delta as process-isolated memory. Smaller windows were rejected:
`n_max=4` and `n_max=2` reduced main decode speed by about 28% and 35%,
respectively. The target model, MTP weights, sampler, context, batch, and ubatch
are otherwise unchanged, so this is a runtime scheduling tune rather than a
translation-quality model change.

The confirmation reports and 250 ms VRAM samples are under
`artifacts/gemma4-12b-qat-ch14-20260826-v1/tuning-mtp-window`.

### Current 1,024/1,024 confirmation

A same-session page-1 control then compared the former 2,048/1,536 pair with
the new 1,024/1,024 pair. Both produced exactly 682 main translation tokens,
reused the same sealed OCR payload, and completed translation, Flux inpainting,
automatic wrapping and sizing, production v2 font matching, and bubble layout.
The sampler recorded both board-wide VRAM and the llama process's WDDM
dedicated/shared commitments.

| Page-1 metric             | 2,048 / 1,536 control | 1,024 / 1,024 production |   Change |
| ------------------------- | --------------------: | -----------------------: | -------: |
| Translation request wall  |               9.298 s |                  9.610 s |    +3.4% |
| Main decode               |           148.4 tok/s |              146.1 tok/s |    -1.5% |
| All decode                |           143.2 tok/s |              140.2 tok/s |    -2.1% |
| Main prompt processing    |         4,481.2 tok/s |            4,762.2 tok/s |    +6.3% |
| Main output tokens        |                   682 |                      682 |     same |
| Main MTP acceptance       |                 73.9% |                    71.3% |  -2.5 pp |
| Board peak above own idle |             9,075 MiB |                8,966 MiB | -109 MiB |
| llama WDDM dedicated peak |             9,055 MiB |                8,821 MiB | -234 MiB |
| llama WDDM shared peak    |               316 MiB |                  232 MiB |  -84 MiB |

The current pair was also run over the first three pages. It completed 3/3
pages with zero OCR calls, the same three OCR SHA-256 values, 2,211 main output
tokens, 148.0 tok/s weighted main decode, 69.7% MTP acceptance, an 8,966 MiB
idle-relative translation peak, and no incomplete production blocks. The
one-page paired result is the cleaner speed comparison; a historical
three-page control ran under materially different background GPU usage.

### Existing 12B minimum VRAM measurement

The existing `culturerevolt/gemma-4-12b-heretic-abliterated-GGUF` Q4_K_M
model was subsequently measured on the same first three chapter pages with the
production minimum settings: b9553, 16,384 context, 1,024/1,024 batch/ubatch,
512 MiB fit reserve, Q4_0 K/V GPU cache, GPU mmproj, and no draft model. All
three frozen OCR payloads were reused.

| Metric                      | Existing 12B minimum |
| --------------------------- | -------------------: |
| Idle board-memory median    |            4,202 MiB |
| llama translation peak      |           12,665 MiB |
| Translation peak above idle |            8,463 MiB |
| Full pipeline board peak    |           13,839 MiB |
| Main decode weighted rate   |           56.6 tok/s |

The current QAT speed run reached 11,226 MiB during llama translation. Relative
to its own idle baseline it added 8,966 MiB, 503 MiB more than the existing
minimum run's 8,463 MiB delta. The two routes now use the same 1,024/1,024
batch contract, but this still is not an isolated MTP-overhead measurement:
the target models and run-time background GPU allocations differ. The full
pipeline peak includes Flux inpainting and is not the model-memory comparison
metric. As with the other measurements, Windows WDDM reports board-wide memory.

The comparison summary is
`artifacts/gemma4-12b-qat-ch14-20260826-v1/tuning-mtp-window/classic-min-vs-qat-speed-n8-pages3-summary.md`.
That file preserves the pre-1,024/1,024 comparison. The current production
report and VRAM samples are under candidate
`qat-12b-mtp-b1024-ub1024` and
`tuning-mtp-window/n8-pages3-b1024-ub1024-fit512-b9553-v1-vram.csv`.

## Chapter 14 benchmark

Date: 2026-08-26. Hardware: NVIDIA GeForce RTX 4090 24 GB and AMD Ryzen 9
7950X. The explicitly requested chapter was frozen as 28 source pages with
cohort digest
`3507078678d91d6d8c476aa2e79ecac2c316d29c63adf95532daf6a6ce17d5e1`.

Both candidates used the same context, sampler, GPU offload, Flux inpainting,
natural text layout, automatic font size, production v2 font matching, and
bubble layout settings. B ran the existing
`culturerevolt/gemma-4-12b-heretic-abliterated-GGUF` Q4_K_M model. C ran the new
QAT model with b9553 `draft-mtp`, `n_max=16`, and the pinned MTP head.

This 28-page table records the original comparison run. The production speed
preset was subsequently tuned to `n_max=8` using the confirmation above; the
model-quality verdict and labeled 28-page images remain the original audit.

C did not invoke OCR. It validated and reused all 28 canonical OCR payloads
from B, including page identity, source image hash and dimensions, cohort
digest, and payload SHA-256. Both candidates completed 28/28 pages and 220
translated blocks.

| Metric                           | B existing 12B | C QAT 12B + MTP |                                         Result |
| -------------------------------- | -------------: | --------------: | ---------------------------------------------: |
| Translation request wall time    |       541.58 s |        324.84 s |                           40.0% shorter, 1.67x |
| Mean translation request/page    |        19.34 s |         11.60 s |                                          1.67x |
| Median translation request/page  |        18.73 s |         11.52 s |                                          1.63x |
| Main decode weighted rate        |     52.6 tok/s |     140.7 tok/s |                                          2.68x |
| All decode weighted rate         |     51.6 tok/s |     131.6 tok/s |                                          2.55x |
| Main MTP draft proposed/accepted |            n/a | 33,360 / 15,207 |                                 45.6% accepted |
| Translation stage                |     1,592.06 s |      1,334.67 s | includes shared font work; B also performs OCR |
| Inpaint/render finishing         |       406.03 s |        368.09 s |                        model-independent stage |
| Full QA pipeline                 |     1,999.95 s |      1,704.41 s |                            C reuses frozen OCR |

The local audit artifact is
`artifacts/gemma4-12b-qat-ch14-20260826-v1`. It contains the two completed run
reports, `benchmark-summary.json`, `benchmark-summary.md`, and 28 labeled
`A original / B existing / C QAT + MTP` comparison images plus a contact sheet.
Artifacts are local QA outputs and are not application release assets.

### Direct visual translation review

All 28 rendered A/B/C pages were reviewed visually against the Japanese
original. B was better on 12 pages, C on 8, and 8 were ties (60% versus 40%
among non-ties). B's advantage came mainly from avoiding occasional malformed
literal translations and one context error in C; C still won several pages by
preserving omitted meaning or using more natural Korean. The result supports
keeping `12B minimum` as the safer quality option and positioning `12B speed`
as the performance choice, not as a quality upgrade. Detailed page verdicts
are recorded in `quality/visual-review.md` inside the local audit artifact.

## Hardware-tier runtime policy (2026-08-27)

`12B speed` keeps the constrained-card contract on nominal VRAM below 12 GB:
automatic fit, the configured 512 MiB reserve/calibration path, Q4 KV, and
1,024/1,024 batch/micro-batch. At 12 GB or more it launches the same model with
explicit full GPU offload (`--fit off -ngl all`) so a higher-memory card does not
spend the long post-CUDA interval on avoidable CPU layer work. Reported board
memory may be up to 128 MiB below the nominal boundary (for example 12,276 MiB
versus 12,288 MiB). This is an ephemeral hardware decision: saved user settings
and legacy presets are not rewritten.

## Rollback

Select the existing `12B 최소` preset to return to the prior 12B model without
MTP. No library chapter is mutated by the benchmark: both candidates run in
isolated QA staging directories. If the speed runtime itself must be rolled
back during development, remove only its exact managed b10621 installation after
the application is stopped; legacy b9553/b9547 discovery remains available. Do not
reuse or overwrite published model or runtime assets.
