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

## Runtime choice and fit limitation

The speed route now uses official llama.cpp b10621 on CUDA, Vulkan, and Metal.
Legacy routes remain on their existing b9553/b9547/BeeLlama binaries. Windows
AMD speed routes use the complete Lemonade ROCm b1317 packages because the
official b10621 ROCm archive is missing required runtime DLLs.

b10621 still prints the following warning during automatic fitting:

```text
Gemma4Assistant requires ctx_other to be set (this is normal during memory fitting)
[spec] failed to measure draft model memory
```

This is operationally important. `--fit-target 1024` is the requested fit
margin, not a guarantee that one physical GiB remains after the MTP context,
image projector, and Windows allocations are created. Upstream issue
[#24758](https://github.com/ggml-org/llama.cpp/issues/24758) documents this
Gemma 4 MTP fitting failure mode and shows that an under-fitted server may
continue without a usable draft path.

The application therefore runs a short real multimodal MTP probe after server
startup, sampling physical free VRAM while the 1,024 image-token path is active.
If the measured margin misses the requested target plus 128 MiB beyond a 64 MiB
tolerance, it restarts once with a runtime-only correction. Corrections use
512 MiB layer-sized steps because +256 MiB did not change the 31B placement,
while +512 MiB crossed the next fit boundary. The saved UI value is never
rewritten. A toast reports the requested value, effective value, correction,
and measured margin.

## Production speed contract

The measured 24 GB CUDA profile is:

| Setting                    | Production value |
| -------------------------- | ---------------: |
| Context                    |    12,288 tokens |
| Batch / micro-batch        |    1,024 / 1,024 |
| Requested free-VRAM target |        1,024 MiB |
| Main KV cache              |  Q4_0 K/V on GPU |
| Multimodal projector       |              GPU |
| GPU layers                 |  llama.cpp `fit` |
| mmap                       |         disabled |
| MTP draft maximum          |         2 tokens |
| Threads / batch threads    |          10 / 12 |
| Prompt checkpoints / cache |     disabled / 0 |

The 12,288-token cap is specific to this 31B QAT speed route. An environment
override can still request a larger context for an explicit diagnostic. The
chapter-14 production request used 4,388 prompt tokens and produced 769 output
tokens, so the cap did not truncate this workload.

### b10621 fit-correction verification

On the RTX 4090, the final application-path smoke started from the persisted
1,024 MiB target, exercised a real 1,024-token image probe, measured a 671 MiB
minimum, and displayed this correction:

```text
MTP fit 보정: 1024 → 1536 MiB (+512 MiB, 실측 여유 671 MiB)
```

The restarted server completed the same probe at 51.2 tok/s with 688 MiB
minimum free VRAM. A separate 128-token page probe at effective fit 1,536
loaded in 9.129 s and finished in 4.405 s: prompt 940.9 tok/s, decode
60.35 tok/s, and MTP accepted 83/88 draft tokens. Its board peak was 23,448
MiB with a 691 MiB sampled physical minimum. This matched the earlier b10621
fit-1,024 decode rate (59.10 tok/s) instead of trading away throughput.

b10621 deprecates `--no-mmap`, but still accepts it. Replacing the alias with
`--load-mode none` was explicitly rejected after the matched startup probe
dropped image prompt processing from 637.5 to 157.1 tok/s and decode from 51.2
to 39.3 tok/s. The speed route keeps the working alias until upstream provides
an equivalent new-mode setting; the runtime itself remains b10621.

## Historical b9553 evidence for the context cap

All probes below used the same RTX 4090 24 GB, b9553, target weights, projector,
MTP head, Q4 KV, 1,024 image tokens, and chapter-14 page 1 request.

| Probe                                  | Outcome                         |          Board peak | Minimum physical margin | llama shared WDDM |
| -------------------------------------- | ------------------------------- | ------------------: | ----------------------: | ----------------: |
| 16K, fit1024, 1024/1024, strict guard  | stopped before request          |          23,625 MiB |                 514 MiB |           526 MiB |
| 16K, fit1024, 1024/1024, relaxed guard | manually stopped during request | 23,593 MiB observed |                 546 MiB |     pressure path |
| 12K, fit1024, 1024/1024                | completed                       |          23,596 MiB |                 543 MiB |           384 MiB |

The relaxed 16K request remained at 100% GPU utilization but only about 113 W
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

## Hardware-tier runtime policy (2026-08-27)

`31B speed` remains tightly fit for its intended 24 GB tier: automatic fit,
1,024 MiB target, 12K context, and 1,024/1,024 batch/micro-batch. Only nominal
32 GB or larger cards (with a 128 MiB reporting tolerance) switch to explicit
full GPU offload (`--fit off -ngl all`). The decision is runtime-only, so an
existing user's stored fit target and the legacy BeeLlama preset remain
untouched.

## Scope and rollback

These numbers validate the user's RTX 4090 24 GB machine. They do not claim
that this 18.7 GB target plus projector and MTP will have the same speed on a
physical 16 GB GPU; automatic fit will require additional CPU offload there.

Select the existing `31B full` legacy preset to return to the IQ3_S target with
DFlash and its preserved BeeLlama route. For a narrow diagnostic rollback, set
`MANGA_TRANSLATOR_USE_DRAFT=0`. Larger-context experiments should explicitly
override `MANGA_TRANSLATOR_CTX` and retain an external VRAM/shared-memory guard.
