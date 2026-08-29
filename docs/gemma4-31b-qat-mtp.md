# Gemma 4 31B QAT + MTP production handoff

## Production selection

The Gemma settings UI exposes `31B speed` (Korean: `31B 속도`) as a built-in
Hugging Face preset. It selects the authentic HauhauCS QAT Q4_K_M target,
matching BF16 multimodal projector, and the repository's 31B MTP head on the
supported NVIDIA CUDA profiles.

Source model:
[HauhauCS/Gemma4-31B-QAT-Uncensored-HauhauCS-Balanced-MTP](https://huggingface.co/HauhauCS/Gemma4-31B-QAT-Uncensored-HauhauCS-Balanced-MTP)

- Pinned revision: `9654466e82d83f5ebfe1518a369bc5900873abb1`
- Main model: `Gemma4-31B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf`
  - Bytes: `18,687,062,176`
  - SHA-256: `71667f9e601a4b914a98425c59150b731f6e15d260d661dbd1f1ee07469fc7db`
- Multimodal projector:
  `mmproj-Gemma4-31B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf`
  - Bytes: `1,200,726,016`
  - SHA-256: `7bef0d0fb3e85fc2941ec5f1c375febf3742645f158132a43ced557093aea841`
- MTP head: `mtp-gemma-4-31B-it.gguf`
  - Bytes: `279,954,368`
  - SHA-256: `b5c4e583fc5982439080114bbc1b7edaec361f9d4c9193d6bed606a3de401b62`

The downloader and `npm run verify:hf-assets` bind all three files to these
exact revisions and digests.

## Runtime choice and memory behavior

The speed route now uses official llama.cpp b10621 on CUDA, Vulkan, and Metal.
Legacy routes remain on their existing b9553/b9547/BeeLlama binaries. Windows
AMD speed routes use the complete Lemonade ROCm b1317 packages because the
official b10621 ROCm archive is missing required runtime DLLs.

b10621 still prints the following warning during automatic fitting:

```text
Gemma4Assistant requires ctx_other to be set (this is normal during memory fitting)
[spec] failed to measure draft model memory
```

This is operationally important. `--fit-target 1536` is the requested fit
margin, not a guarantee that 1,536 MiB remains after the MTP context,
image projector, and Windows allocations are created. Upstream issue
[#24758](https://github.com/ggml-org/llama.cpp/issues/24758) documents this
Gemma 4 MTP fitting failure mode and shows that an under-fitted server may
continue without a usable draft path.

The application therefore runs a short real MTP probe after server startup,
sampling physical free VRAM while the configured text-only or 1,024
image-token path is active. If the measured margin is too small, decode drops
below 10 tok/s, or the 30-second probe times out, the request stops with an
error toast asking the user to lower context length and maximum output tokens.
The risky MTP startup path also has a 60-second startup bound. The runtime does
not rewrite context length, maximum output tokens, or the requested free-VRAM
target, and it no longer restarts with an automatically increased fit target.

## Production speed contract

The CUDA/RTX50 route keeps the speed-oriented batch, cache, and MTP settings,
but context length is always the value saved by the user. No model- or
VRAM-specific context cap is applied. The default is 65,536 tokens.

The current runtime profile is:

| Setting                    |              Production value |
| -------------------------- | ----------------------------: |
| Context                    | User setting (default 65,536) |
| Batch / micro-batch        |                 1,024 / 1,024 |
| Requested free-VRAM target |                     1,536 MiB |
| Main KV cache              |               Q4_0 K/V on GPU |
| Multimodal projector       |                           GPU |
| GPU layers                 |               llama.cpp `fit` |
| mmap                       |                      disabled |
| MTP draft maximum          |                      2 tokens |
| Threads / batch threads    |                       10 / 12 |
| Prompt checkpoints / cache |                  disabled / 0 |

Larger contexts may cause llama.cpp fitting to offload more layers or may fail
on hardware without enough memory, but the application does not silently lower
the requested value. Translation and text-only internet research use the same
context passthrough rule.

### b10621 32K / 1,536 MiB verification

On the RTX 4090, the exact production settings `ctx 32,768`, maximum output
`32,768`, and `fit-target 1,536 MiB` loaded in about 9–11 seconds. Repeated
short probes decoded at roughly 44–49.7 tok/s without an automatic restart or
context reduction. The full preview-only Tavily research run completed in
181.498 seconds, used four search credits, and found all five fixed validation
items: the work title, `開錠（アンロック）`, `ロッド`, `ラヴィ`, and
`五大迷宮`. The original guide hash was unchanged.

b10621 deprecates `--no-mmap`, but still accepts it. Replacing the alias with
`--load-mode none` was explicitly rejected after the matched startup probe
dropped image prompt processing from 637.5 to 157.1 tok/s and decode from 51.2
to 39.3 tok/s. The speed route keeps the working alias until upstream provides
an equivalent new-mode setting; the runtime itself remains b10621.

## Historical b9553 24 GB measurements

All probes below used the same RTX 4090 24 GB, b9553, target weights, projector,
MTP head, Q4 KV, 1,024 image tokens, and chapter-14 page 1 request.

| Probe                                  | Outcome                         |          Board peak | Minimum physical margin | llama shared WDDM |
| -------------------------------------- | ------------------------------- | ------------------: | ----------------------: | ----------------: |
| 16K, fit1024, 1024/1024, strict guard  | stopped before request          |          23,625 MiB |                 514 MiB |           526 MiB |
| 16K, fit1024, 1024/1024, relaxed guard | manually stopped during request | 23,593 MiB observed |                 546 MiB |     pressure path |
| 12K, fit1024, 1024/1024                | completed                       |          23,596 MiB |                 543 MiB |           384 MiB |

These measurements explain why an older production revision forced 12,288
tokens. That hidden cap has been removed; they are retained only as historical
performance evidence. The relaxed 16K request remained at 100% GPU utilization but only about 113 W
and ran many times longer than the completed 12K request. This was the same
practical whole-PC slowdown reported during the earlier 31B experiment, even
though the NVIDIA throttle-reason bit was not set. It was therefore rejected.

The 12K direct request loaded in 11.175 s and completed in 5.856 s for the
128-token speed probe. Prompt processing was 1,197.8 tok/s; target decode was
61.49 tok/s. MTP accepted 83 of 87 proposed tokens (95.4%).

## Batch / micro-batch isolation

A matched legacy-pair probe held fit target, context, model, MTP, and request
constant and changed only `1024/1024` back to `2048/1408`.

| Metric                    | 1024/1024 production |                 2048/1408 control |
| ------------------------- | -------------------: | --------------------------------: |
| Request completed         |                  yes |        no; safety stop after load |
| llama WDDM dedicated peak |         21,698.9 MiB |                      21,761.4 MiB |
| llama WDDM shared peak    |              384 MiB |                           646 MiB |
| Safety threshold          |        not triggered | shared-memory threshold triggered |

The control was stopped before inference, so its sampled board peak is not a
valid full-request comparison. The process-level result is still decisive for
the stability question: reducing both values to 1,024 removed 62.5 MiB of
dedicated commitment and 262 MiB of shared commitment and allowed the request
to finish. The change is not being claimed as a board-wide VRAM reduction from
two fully completed runs.

## Historical b9553 production page result

The frozen first page of chapter 14 was then run through the actual application
pipeline with the same sealed OCR payload used by the 12B and 26B comparisons.
It completed translation, native Flux inpainting, natural wrapping, automatic
font sizing, production v2 font matching, and balloon fitting.

| Metric                                |                        Result |
| ------------------------------------- | ----------------------------: |
| Endpoint startup                      |                      14.988 s |
| Translation request wall              |                      27.926 s |
| Main prompt                           | 4,388 tokens at 1,513.1 tok/s |
| Main output                           |     769 tokens at 58.30 tok/s |
| MTP acceptance                        |              507 / 526, 96.4% |
| Full page pipeline                    |                     115.763 s |
| OCR calls                             |                             0 |
| Erased / incomplete blocks            |                        10 / 0 |
| Leading idle board median             |                     2,098 MiB |
| llama board peak                      |                    23,701 MiB |
| Peak above idle                       |                    21,603 MiB |
| Physical board margin at sampled peak |                       863 MiB |
| llama WDDM dedicated / shared peak    |            21,796.9 / 384 MiB |
| Safety stops                          |                             0 |

The sampled physical margin is 863 MiB, not the requested 1,024 MiB, for the
fit limitation described above. It stayed above the explicit 512 MiB safety
line and did not enter the pathological low-power state. llama was released
before native Flux ran; their peaks did not overlap. The rendered page was
opened at source resolution and showed no clipping or overlap. The narrow
left-edge narration uses aggressive vertical wrapping but remains inside the
page boundary.

Evidence is under `artifacts/gemma4-31b-qat-ch14-20260827-v1`. The production
run is candidate `qat31b-fit1024-ctx12k-b1024-u1024`, run
`page1-production-v2`; its per-request `requestSummary.options` is the authority
for the environment-resolved 31B model and runtime settings. The QA run-config
also records the persisted UI settings, which were intentionally overridden
for this isolated run.

## Hardware-tier runtime policy (2026-08-28)

`31B speed` uses automatic layer fitting, a 1,536 MiB free-VRAM target, and
1,024/1,024 batch/micro-batch. Context and maximum output come directly from
the saved settings; the 24 GB path does not substitute a smaller hidden value.
The same configured fit routing is used on every detected VRAM tier; the
runtime does not silently replace it with `--fit off -ngl all`. If a configured
workload enters the sustained low-VRAM path, the startup/probe guard stops it
and gives the lowering guidance instead of silently changing settings.

## Scope and rollback

These numbers validate the user's RTX 4090 24 GB machine. They do not claim
that this 18.7 GB target plus projector and MTP will have the same speed on a
physical 16 GB GPU; automatic fit will require additional CPU offload there.

Select the existing `31B full` legacy preset to return to the IQ3_S target with
DFlash and its preserved BeeLlama route. For a narrow diagnostic rollback, set
`MANGA_TRANSLATOR_USE_DRAFT=0`. Larger-context experiments should explicitly
override `MANGA_TRANSLATOR_CTX` and retain an external VRAM/shared-memory guard.
