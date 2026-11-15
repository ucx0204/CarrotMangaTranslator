# Gemma 4 26B QAT + MTP production handoff

## Issue #177: dedicated 8 GiB profile (2026-11-14)

`lowVram26b`, shown as `26B (8GB)`, reuses the exact QAT 26B model and
projector pinned below. It is a separate execution profile, not a new model
asset or release. The existing 12B remains the first option and the default
for 8 GiB GPUs, including recommendation resets. The CPU-expert 26B is the
second option for users with ample system RAM. Its short RAM recommendation
appears only in the existing tooltip. Selecting it enables GPU vision;
explicitly saved model selections remain authoritative.

The profile keeps all MoE expert weights in system RAM with llama.cpp
`--cpu-moe`, retaining automatic GPU fitting for the remaining tensors. It
uses 32,768 context tokens, 1,024/1,024 batch/micro-batch, Q4_0 KV, no mmap, a
1,024 MiB requested free-VRAM margin, and no MTP draft model. This 26B profile keeps the vision projector on GPU; the user's explicit
projector setting remains authoritative. The older 12B 8 GiB default still
uses CPU vision. The normal `26B (16GB)` preset
continues using its previous automatic fitting and CUDA MTP configuration.
Switching between the two 26B profiles shares the same verified model cache.

The tooltip recommends at least 24 GB system RAM with about 16 GB available and
explains that CPU/memory bandwidth can make this slower than 12B. This is an
operational recommendation, not a hard admission check or a physical-8GB
hardware certification. Native validation on this workstation uses an
RTX 4090 24 GB with CPU experts forced by the production profile.

The preset ID and VRAM mode round-trip through stored settings, IPC, model
selection, recommended settings and internet research. Model-file identity
alone intentionally continues to identify the ordinary `qat26b` preset;
the saved mode distinguishes the 8 GiB profile. Diagnostics and result
settings record `cpuMoe`. No library input or output is modified by QA.

Regression tests: `gemmaLowVram26b`, `settingsModalSafety`, existing Gemma
runtime/launch, settings migration, hardware routing, IPC and Metal suites.
UI captures use the real settings modal and styles with the repository QA
bridge at 1440×1000 and 900×760:
`C:/tmp/issue177-secondary-wide.png` and
`C:/tmp/issue177-secondary-narrow.png`, with the focused tooltip captured at
`C:/tmp/issue177-secondary-tooltip.png`. The temporary renderer entry was removed.

Rollback: select `12B (8GB)` under the speed family (or the legacy family
for the older non-QAT 12B), then save. Existing model files remain usable;
no cache migration or asset replacement is required.

### Native verification and rejected settings

Downloaded the two pinned assets into isolated staging, checked their full
byte sizes and SHA-256 values, then moved those exact files into the normal
managed Hugging Face cache. The app's downloader/validator and native server
startup reused them successfully. Inventory: `.tmp/issue177-downloads/verified-assets.json`
(its staging paths predate the move). The native options came from `resolveDefaultAppSettings` for an 8 GiB GPU
and `buildBaseTranslationOptions` before the follow-up restored 12B as the
default. Explicitly choosing the 26B profile retains that tested runtime.

llama.cpp b11146 on RTX 4090 completed a 900×300 Japanese-text image request:
“明日の朝、駅で待ってる。忘れないでね。” became “내일 아침, 역에서 기다릴게. 잊지 마.”
Startup was 11.37 seconds, request wall time 2.85 seconds, prompt throughput
491.65 tokens/s and decode throughput 29.24 tokens/s (17 generated tokens).
Board-wide VRAM sampled once per second rose from 2,496 MiB to 7,240 MiB
(4,744 MiB above idle). Process peak working set was 16,832,270,336 bytes
(15.68 GiB); private committed memory after the request was 22,319,452,160
bytes (20.79 GiB). This is a small image smoke, not a chapter quality benchmark,
a guaranteed VRAM ceiling, or validation on physical 8 GiB hardware.
Evidence: `.tmp/issue177-native-report.json`, `.tmp/issue177-native-final.log`,
`.tmp/issue177-native-request-stderr.log`, `C:/tmp/issue177-japanese-input.png`.

The first experimental 512/256 batch profile was rejected: the native
multimodal request asserted that non-causal attention requires a micro-batch
at least as large as the image-token batch. CPU vision also exceeded the
180-second diagnostic deadline. The final profile retains the established
1,024/1,024 batch and disables mmap, as the native loader recommends for CPU
tensor overrides. Those failures are not presented as successful validation.

The first full suite found seven failures: five new download-inventory tests
needed isolated caches after real assets were installed; one settings-restore
expectation still required 12B; one coverage inventory lacked the newly touched
`gemma-unified-memory.cjs`. Its original Node 22 baseline floor was restored
without lowering any existing floor (lines 15/24, statements 16/26, functions
2/3, branches 16/28). The changed behavior and inventory are rechecked by the
focused suites (304 passed, one platform skip across 16 files, including the
12B-default and tooltip-only follow-up); the remaining
full-suite tests passed.

Final `npm run check -- --phase=build` passed all 25 gates, including the build,
renderer parity and image-protocol smoke. Focused V8 coverage for the touched
native unified-memory owner exceeded its original floor in all four metrics
(76% lines, 78.57% statements, 100% functions, 76.66% branches), recorded in
`.tmp/issue177-coverage/coverage-summary.json`.

### Issue #177 real-manga follow-up (2026-11-14)

The synthetic-image smoke above was followed by a fresh production-pipeline
run on six actual library pages: pages 1–3 of `1×∞` chapter 22 and pages 1–3
of `최강의 검성, 미소녀 메이드로 전생해 빗자루로 무쌍하다` chapter 11.1.
The existing full-pipeline QA runner used isolated source copies and the
production `withExecutionSettings` contract. Settings came from the 8 GiB
12B defaults followed by selecting `lowVram26b` and GPU vision, retaining
the existing 512 MiB reserve exactly as the UI does. OCR, translation, font
selection/size, Flux inpainting and renderer export were all executed fresh.

Evidence root: `artifacts/issue177-real-manga-v1/`.
`run/run-report.json` records six completed pages, zero incomplete inpainting
blocks and six rendered PNGs. `translation-audit.json` records all 70 supplied
ordinary-text slots returned with matching IDs, nonempty translations and
normal stop reasons. Two pages needed one built-in block-repair request each.
After the existing punctuation-preservation policy, 63 blocks were typeset.
The model started once in 11.62 seconds; translation requests including repair
took 27.49, 29.96, 34.70, 41.86, 14.75 and 25.91 seconds. The entire OCR,
typography, inpainting and export run took 508.40 seconds (8 minutes 28 seconds).
`native-launch.json` confirms b11146, `--cpu-moe`, GPU projector, Q4 KV and no
draft. All nine protected original/settings/chapter hashes were unchanged in
`source-integrity-after.json`. Test processes exited successfully.

Every original and rendered image was inspected directly. Runtime completion
is **not** a clean translation/layout-quality verdict: page 4 translates
`月日は流れ` as `달은 흐르고` and invents `메쿠츠카사` for `介錯`; the page-4
title also drops the broom phrase. Some narrow blocks wrap awkwardly, and
Flux changes parts of white balloon/caption interiors on pages 1, 3 and 4.
Some margin credits/copy remain outside the detected translation slots.
These observations are retained in the unedited outputs and `run/review.html`;
they were not manually repaired or hidden by selectively choosing outputs.
This run does not isolate whether those downstream quality issues differ from
the existing 12B or normal 26B profiles.

The workstation is still an RTX 4090 24 GiB, not a physical 8 GiB GPU.
Two-second board-wide samples peaked at 9,878 MiB while llama was alive
(including other app/OCR/font work) and 12,557 MiB during Flux finishing.
Those are whole-board measurements, not the model-only allocation or an
8 GiB guarantee. Sampled llama peak working set was 15.80 GiB and private
commit 20.80 GiB. `memory-samples.csv` preserves the measurements; sampling
started during OCR and does not establish an idle baseline for this run.

### Paired 12B / CPU-expert 26B comparison, stopped by user (2026-11-14)

The planned 20-work, 100-page comparison was stopped at the user's request.
Both profiles translated the same 50 pages from 10 works, with identical OCR
payloads for all 50 pairs. All 386 supplied text slots were returned by each
profile, with no final ID mismatch or empty translation. Nine work pairs
completed the full pipeline; the tenth 26B run was interrupted during finishing.
There are 50 12B and 46 26B completed renders. All 50 paired translation texts
and the first 45 paired final images were reviewed; the extra render from the
interrupted run is retained but is not counted as visually reviewed.

Excluding speed, assistant qualitative review suggests a modest 26B advantage
in context, causative relations and recovery from OCR mistakes. This is not a
human-gold accuracy score or a clean-quality verdict: 26B also omitted gratitude
and a self-repair ability phrase, and reversed leaving versus returning in one
line. Both models mistranslated receding smoke as rising smoke and missed some
decorative source text outside the OCR slots. The existing 12B default and
optional 26B selection remain unchanged.

Evidence: `artifacts/issue177-compare100-v1/summary.html`, `comparison.html`,
`qualitative-notes.json`, and `final-audit.json`. The scope is explicitly stopped,
not 100-page complete. Test workers and the memory sampler exited; all protected
source/settings and bound runtime hashes remained unchanged. Measurements use
RTX 4090 24 GiB hardware, not a physical 8 GiB GPU. The two actual UI profiles
also differ in CPU versus GPU vision, so this is a preset comparison rather
than an isolated parameter-count experiment.

## Production selection

The Gemma settings UI exposes `26B speed` (Korean: `26B 속도`) as a built-in
Hugging Face preset. It selects the official HauhauCS QAT 4-bit model and its
matching multimodal projector. NVIDIA CUDA 12 and RTX 50 profiles also enable
the repository's Gemma 4 MTP head with mainline llama.cpp `draft-mtp`.

Source model:
[HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP](https://huggingface.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP)

- Pinned revision: `f9093662a2e7ae0503f637088bc96f77a1a70c83`
- Main model: `Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf`
  - Bytes: `16,796,015,520`
  - SHA-256: `3c13133469e431312fffb8b1d9c85ae42199e6bb5746ea1da84e8ddf2097d73c`
- Multimodal projector:
  `mmproj-Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf`
  - Bytes: `1,194,827,776`
  - SHA-256: `b5346e5bfd906f5e16878c2d0b8243e948ca7410fa28ea35be9b0c54a0ac10b7`
- MTP head: `mtp-gemma-4-26B-A4B-it.gguf`
  - Bytes: `251,937,728`
  - SHA-256: `62bd3af7f66c9308de9a5454233852f8c7324c93767e8dfb824ed45b9179864a`

The downloader and `npm run verify:hf-assets` use these exact revision, byte,
and digest bindings.

## Common VRAM policy and QAT runtime contract

Fresh or reset settings use a 512 MiB llama.cpp fit target for the two 12B
presets and 1,024 MiB for every larger preset, including `26B speed`. Existing
saved values remain authoritative, and `MANGA_TRANSLATOR_FIT_TARGET_MB` still
takes precedence. The settings UI accepts any integer MiB value from 0 through
16,384 and provides cumulative `+128`, `+256`, and `+512 MiB` shortcuts; the
value is not restricted to a power of two or a 512 MiB multiple.

Metal retains its existing 4,096 MiB reserve for non-31B modes because it uses
unified memory. On a detected dedicated GPU with at most 8 GiB, the reserve is
still 512 MiB but the multimodal projector defaults to CPU offload.

The QAT 26B CUDA settings are:

| Setting                  |                          Value |
| ------------------------ | -----------------------------: |
| Context                  |                  32,768 tokens |
| Batch / micro-batch      |                  1,024 / 1,024 |
| Main KV cache            |         Q4_0 K and Q4_0 V, GPU |
| Multimodal projector     |                            GPU |
| GPU layers               |        llama.cpp automatic fit |
| Default free-VRAM target |                      1,024 MiB |
| mmap                     | disabled for this QAT 26B path |
| MTP draft maximum        |                       2 tokens |
| Threads / batch threads  |                        10 / 12 |

`--fit-target 1024` is a requested free-memory margin during llama.cpp fitting,
not a 1,024 MiB cap and not a promise about final board-wide headroom. On a card
with less memory, llama.cpp automatically moves more model tensors to CPU to
try to retain that margin. On a card with more memory it keeps more tensors on
GPU and runs faster. Consequently, a 24 GB result cannot be converted into a
physical 16 GB result by simply adding or subtracting the reported peak.
Windows display use, another GPU process, and transient allocations can also
consume part of the reserve. The final profile has been launch-tested on the
24 GB test machine; it has not been validated on a physical 16 GB board.

The QAT-specific choices adapt the practical ideas from
[Gemma 4 26B QAT + MTP: 100 tok/s Local MoE on 12GB VRAM](https://carteakey.dev/blog/local-inference/gemma-4-26b-qat-mtp/): keep MTP enabled, use a two-token draft window, and let llama.cpp fit the MoE model instead of disabling acceleration wholesale. This preset deliberately keeps Q4 KV rather than the article's F16 KV. MTP acceptance varies with the generated sequence and offload profile.

Current speed routing uses official llama.cpp b10621 for CUDA/Vulkan/Metal and
Lemonade llama.cpp ROCm b1317 for supported Windows AMD gfx targets. Legacy
model presets retain their previous b9553/b9547/BeeLlama/b1291 runtimes. The
28-page measurements below remain historical b9553 evidence; the current
runtime contract is verified separately by pinned archive hashes, focused
launch tests, and an actual CUDA model smoke.

Windows CUDA MTP routes run a short multimodal startup probe. When the runtime
reports that it omitted the extra model from fitting, the probe is unhealthy,
and measured free VRAM is below the requested margin, the app makes one
runtime-only fit correction. It rounds the measured deficit plus 256 MiB up to
a 256 MiB boundary (minimum 512 MiB, maximum 4,096 MiB additional reserve),
then adds the separately measured pre-load CUDA/physical free-memory gap,
also rounded up to 256 MiB. Windows can expose a larger CUDA memory budget
than the physical headroom reported by `nvidia-smi`; once paging begins,
the remaining free-VRAM sample alone hides that deficit. The existing
`--list-devices` preflight supplies the CUDA budget without another model load.
Automatic refitting requires an unambiguous GPU budget; unknown measurements
and automatic multi-GPU placement are not treated as zero memory.
It confirms the old process has exited before loading the replacement and
repeats the probe. The progress log records both targets; saved settings,
context, output limits and MTP stay unchanged. Healthy starts do not restart.
Successful corrections are retained in the llama.cpp cache directory under
`mtp-fit-v1`, including across app restarts. The cache key covers launch
arguments (excluding the listening port), model/projector/draft and runtime
file identity, GPU identity/capacity, compute environment and output limit.
Both physical free VRAM and the CUDA/physical budget gap must stay within
512 MiB of the successful launch. Unknown measurements, changed configuration,
corrupt entries and entries older than 14 days are cache misses. A hit launches
directly with the successful target but still runs the short performance probe;
a failed cached startup discards the entry, while user cancellation preserves
it. A further low-memory recovery uses the original requested margin and adds
the measured CUDA gap only once, increasing the previous target by at least
512 MiB. Cache I/O failure never fails translation or changes saved settings.
This compensates for the upstream estimator failure; it does not repair the
native estimator or guarantee that every 16 GB configuration will fit.

### Issue #131 recovery verification (2026-09-28)

Persistent-cache validation used the same RTX 4090/QAT 26B/MTP workload with
4 GiB held by a separate CUDA process. Windows paging changed the pre-load
budget between the first two starts, correctly causing a new measurement.
Once it stabilized, the third start reused the successful 6,144 MiB target
without a correction/restart: startup including preflight and the image probe
fell from 61.1 seconds on the preceding recovery to 23.7 seconds, and the
probe decoded at 108.16 tok/s. The saved target stayed at 1,024 MiB. Evidence:
`.tmp/issue131-persistent-fit-smoke-v3.json` and
`.tmp/issue131-persistent-fit-smoke-v3.log`. A separate fresh-process test also
checks persistence across app restarts. Earlier 256 MiB tolerance trials
missed a 436 MiB Windows budget fluctuation; the final 512 MiB tolerance keeps
the health probe and rejects larger changes.

On the RTX 4090 with b10621, QAT 26B + MTP, context 30,000, output limit
20,000 and fit target 1,024 MiB, an ordinary image probe completed without a
restart. A separate CUDA process then held 4 GiB throughout a constrained
run. The original launch timed out after 30 seconds with 456 MiB physically
free. Preflight had measured a 6,368 MiB CUDA/physical budget gap. One refit
to 8,448 MiB completed the startup probe at 75.73 tok/s and a second actual
image request at 87.35 tok/s (16 of 28 draft tokens accepted). Total startup
and request wall time, including the initial timeout, was 59.19 seconds.
Saved fit target, context, output limit and MTP stayed unchanged. This is a
physical-pressure reproduction on a 24 GB card, not validation on a 5070 Ti.

Local evidence: `.tmp/issue131-normal-smoke.json`,
`.tmp/issue131-constrained-smoke.json` and
`.tmp/issue131-constrained-smoke-output-v3.log`. Earlier deficit-only and
capped-total corrections did not recover this run; the final policy accounts
for the full measured budget gap separately from the bounded MTP correction.

## Candidate rejection before tuning

The requested ARA IQ3_S candidate from
[mradermacher/gemma-4-26B-A4B-it-qat-q4_0-unquantized-heretic-ara-i1-GGUF](https://huggingface.co/mradermacher/gemma-4-26B-A4B-it-qat-q4_0-unquantized-heretic-ara-i1-GGUF/tree/main)
completed the same 28-page run. Direct visual review against the Japanese
original favored existing B on 16 pages, ARA on 8, with 4 ties. Its recurring
errors included subject reversal, omissions, quantity changes, register
problems, and instruction-like parenthetical text. ARA therefore did not
replace the existing model.

The detailed review is in
`artifacts/gemma4-26b-ara-iq3s-ch14-20260826-v1/quality/visual-review.md`.

## Chapter 14 benchmark

Date: 2026-08-26. Hardware: NVIDIA GeForce RTX 4090 24 GB and AMD Ryzen 9
7950X. The requested chapter was frozen as 28 source pages with cohort digest
`3507078678d91d6d8c476aa2e79ecac2c316d29c63adf95532daf6a6ce17d5e1`.

All runs used llama.cpp b9553, the same 16,384-token context and sampler, the
same 28 canonical OCR payloads, Flux inpainting, natural line layout,
automatic font sizing, production v2 font matching, and balloon fitting. No
run made a live OCR call.

The table preserves the two completed 28-page QAT runs. The fast reference
used fit target 512 and micro-batch 1,536. The conservative diagnostic used
fit target 9,472 and micro-batch 1,408 to simulate a much smaller GPU budget on
the 24 GB card. The production profile now uses fit target 1,024 and
1,024/1,024 batch/micro-batch, so neither column is mislabeled as an exact
full-run result for the final pair.

| Metric                    | B existing 26B | QAT fit512 reference | QAT constrained diagnostic |
| ------------------------- | -------------: | -------------------: | -------------------------: |
| Completed pages           |             28 |                   28 |                         28 |
| Translation request wall  |       694.10 s |             458.26 s |                   549.25 s |
| Mean request/page         |        24.79 s |              16.37 s |                    19.62 s |
| Median request/page       |        23.12 s |              16.51 s |                    19.77 s |
| Main decode weighted rate |     96.0 tok/s |          111.6 tok/s |                 80.0 tok/s |
| All decode weighted rate  |     94.4 tok/s |          103.7 tok/s |                 78.1 tok/s |
| Main MTP acceptance       |            n/a |                35.3% |                      85.3% |
| All MTP acceptance        |            n/a |                38.8% |                      89.4% |
| Translation stage         |     1,718.13 s |           1,480.91 s |                 1,537.14 s |
| Inpaint/render finishing  |       422.17 s |             409.32 s |                   302.09 s |
| Full QA pipeline          |     2,142.68 s |           1,893.28 s |                 1,840.10 s |

Relative to B, the 28-page fit512 reference shortened translation-request
wall time by 34.0% (1.51x). The constrained run shortened it by 20.9% (1.26x).
Finishing time is output-dependent and is not evidence that model fitting
accelerates Flux.

The previous production `fit512 / batch2048 / ubatch1408` pair was additionally
run through the complete production path for page 1, reusing the same frozen
OCR payload. This remains historical control evidence rather than the current
contract:

| Metric                         | fit9472 / ubatch1408 | Previous fit512 / ubatch1408 |
| ------------------------------ | -------------------: | ---------------------------: |
| Translation request wall       |              15.22 s |                       9.65 s |
| Main decode weighted rate      |           75.4 tok/s |                  140.2 tok/s |
| All decode weighted rate       |           75.2 tok/s |                  132.7 tok/s |
| Main MTP acceptance            |                82.2% |                        83.7% |
| All-sample MTP acceptance      |                87.3% |                        87.7% |
| Idle-relative board VRAM peak  |           15,107 MiB |                   18,948 MiB |
| Full production page completed |                  yes |                          yes |

The main QAT weights, projector, sampler, and target-model validation are
unchanged by fit tuning. MTP changes which target-verified tokens can be
accepted early, not the target model's translation quality. The direct
28-page review favored QAT on 14 pages, B on 5, with 9 ties. That model-level
quality decision is unchanged by the final memory setting. Both completed
28-page QAT runs rendered 28/28 pages with no incomplete production blocks.
The contact sheet was inspected directly with no new clipping, overlap, or
layout failure. Small source-effect text outside the OCR blocks on pages 2 and
28 remained diagnostic-only evidence in both B and C.

## VRAM measurement and interpretation

VRAM was sampled approximately once per second with `nvidia-smi memory.used`.
This is board-wide WDDM usage, so the leading idle median and peak-above-idle
delta are both reported.

| Full-run metric     | B existing 26B | QAT fit512 / ub1536 | QAT fit9472 / ub1408 |
| ------------------- | -------------: | ------------------: | -------------------: |
| Leading idle median |      3,907 MiB |           3,990 MiB |            4,162 MiB |
| llama peak          |     18,626 MiB |          23,330 MiB |           19,303 MiB |
| Peak above idle     |     14,719 MiB |          19,340 MiB |           15,141 MiB |

The earlier user-defined diagnostic gate was B plus at most 1,024 MiB, or
15,743 MiB above idle. The constrained full run passed at 15,141 MiB (B +422
MiB) and left 602 MiB inside that gate. It also saved 4,199 MiB relative to the
24 GB fit512 full-run reference. These results remain useful as a manual
high-offload fallback, but that profile is no longer selected after the
later decision to use a 1,024 MiB default for models larger than 12B.

The exact final page-1 probe measured 4,128 MiB before the run, 23,076 MiB at
the board-wide peak, and an 18,948 MiB idle-relative increase. That high 24 GB
usage is expected: the smaller requested reserve lets llama.cpp keep more MoE
tensors on this card. A physical 16 GB card should offload more tensors, but
its actual peak and speed must be measured on that hardware; the 24 GB delta
is not a physical-16-GB capacity prediction.

### Current 1,024/1,024 confirmation

The current profile completed the first three pages with zero OCR calls and the
same three sealed OCR payload hashes. Every page finished translation, native
Flux inpainting, automatic line wrapping and font sizing, production v2 font
matching, and bubble layout with no incomplete block. A same-session page-1
control isolated the batch change from background GPU-memory drift:

| Page-1 metric             | 2,048 / 1,408 control | 1,024 / 1,024 production |   Change |
| ------------------------- | --------------------: | -----------------------: | -------: |
| Translation request wall  |              10.638 s |                 10.486 s |    -1.4% |
| Main decode               |           123.6 tok/s |              129.8 tok/s |    +5.0% |
| All decode                |           117.6 tok/s |              123.1 tok/s |    +4.7% |
| Main prompt processing    |         3,221.1 tok/s |            3,239.0 tok/s |    +0.6% |
| Main output tokens        |                   394 |                      400 |       +6 |
| Main MTP acceptance       |                 83.7% |                    84.8% |  +1.1 pp |
| Board peak above own idle |            19,367 MiB |               19,353 MiB |  -14 MiB |
| llama WDDM dedicated peak |            19,347 MiB |               19,221 MiB | -126 MiB |
| llama WDDM shared peak    |               410 MiB |                  350 MiB |  -60 MiB |

The 14 MiB board-wide difference is measurement noise, not a useful total-VRAM
saving. With `gpuLayers=fit`, llama.cpp reuses the smaller batch allocation to
keep more MoE tensors on the GPU while preserving the same 1,024 MiB target. The
process-level transient commitments still fell by 126 MiB dedicated and 60 MiB
shared, which is the relevant stability benefit near the WDDM boundary. The
three-page production run reached 135.7 tok/s weighted main decode and a
19,353 MiB idle-relative translation peak. llama was released before native
Flux started, so their process peaks did not overlap.

## Tuning audit

The page-1 search kept OCR and finishing options frozen. Important candidates:

| Candidate                   |      Decode | MTP accept | VRAM delta | Historical B+1GiB gate |
| --------------------------- | ----------: | ---------: | ---------: | ---------------------: |
| fit 512, Q4 KV, MTP 2       | 138.8 tok/s |      91.8% | 19,019 MiB |         3,276 MiB over |
| fit 4,096                   | 142.1 tok/s |      91.8% | 19,367 MiB |         3,624 MiB over |
| fit 8,192                   |  82.5 tok/s |      87.8% | 16,374 MiB |           631 MiB over |
| fit 9,216, mmap             |  76.4 tok/s |      93.2% | 15,411 MiB |          332 MiB under |
| fit 9,216, no-mmap, 16/16   |  77.5 tok/s |      93.2% | 15,420 MiB |          323 MiB under |
| fit 8,704, CPU KV           |  45.7 tok/s |      87.0% | 15,932 MiB |           189 MiB over |
| fit 9,216, no-mmap, 10/12   |  83.4 tok/s |      93.2% | 15,412 MiB |          332 MiB under |
| fit 9,216, no-mmap, 12/12   |  81.8 tok/s |      93.2% | 15,410 MiB |          333 MiB under |
| fit 9,472, ubatch 1,536     |  78.0 tok/s |      92.6% | 15,169 MiB |          574 MiB under |
| fit 9,472, ubatch 1,408     |  75.2 tok/s |      87.3% | 15,107 MiB |          636 MiB under |
| previous fit 512 / ub 1,408 | 140.2 tok/s |      83.7% | 18,948 MiB |         3,205 MiB over |

Moving the projector to CPU disabled the safe MTP path and was too slow. CPU
KV both missed the historical gate and cut decode speed almost in half. The
earlier unstable micro-batch 1,024 probe paired it with batch 2,048 under the
constrained fit experiment; it does not describe the now-tested 1,024/1,024
pair. The paired setting completed all three current production pages and its
same-session control without a runtime failure.

The final production selection is therefore default fit target 1,024,
batch/micro-batch 1,024/1,024, no-mmap, threads 10/12, Q4 KV and projector on
GPU, and MTP maximum 2. The complete local audit is
`artifacts/gemma4-26b-qat-ch14-20260826-v1`. It contains reports, VRAM CSVs,
tuning summaries, aligned output, 28 labeled A/B/C pages, and both contact
sheets. These are local QA artifacts, not release assets.

## Hardware-tier runtime policy (2026-08-27)

`26B speed` keeps automatic fit, the 1,024 MiB reserve/calibration path, and
1,024/1,024 batch/micro-batch below nominal 24 GB VRAM. At 24 GB or more it uses
explicit full GPU offload (`--fit off -ngl all`). A 128 MiB tolerance handles
drivers that report slightly less than the marketed capacity (the RTX 4090 on
the test machine reports 24,564 MiB rather than 24,576 MiB). The route is
computed for each launch and does not overwrite persisted settings or change
the preserved `26B economy`/legacy preset.

## Rollback

Select `26B 절약` to return to the prior IQ3_S model without MTP. For a narrow
diagnostic rollback that keeps QAT, set `MANGA_TRANSLATOR_USE_DRAFT=0`; for fit
troubleshooting override `MANGA_TRANSLATOR_FIT_TARGET_MB`. The isolated QA runs
did not mutate the library chapter. Do not overwrite or repurpose the pinned
Hugging Face assets.
