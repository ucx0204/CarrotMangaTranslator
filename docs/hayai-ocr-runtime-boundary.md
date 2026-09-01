# OCR engine runtime boundary

This document defines the production boundary between the current **Text Detector + Hayai OCR** pipeline and the legacy **Paddle OCR** pipeline. The selected pipeline is an execution identity, not a display preference.

## Required identity flow

Every app-created `TranslationOptions` value contains `ocrPipeline`. That identity must survive this complete flow unchanged:

`settings -> translation options -> page/batch options -> managed provider -> runtime variant -> install lock -> child environment -> command -> progress event`

The two managed routes are fixed:

| Pipeline        | Managed provider | Python command        |
| --------------- | ---------------- | --------------------- |
| `hayai`         | `hayai-regions`  | `hayai-bboxes.py`     |
| `paddle-legacy` | `paddleocr`      | `paddleocr-bboxes.py` |

A stale managed-provider value is replaced by the provider owned by the selected pipeline. Delivery-only providers (`none`, `json-file`, and `external-command`) may bypass managed OCR, but they must never be converted into either managed engine. Managed batch command construction rejects them.

## Device and runtime matrix

Device selection is explicit. A failed GPU runtime stops with an engine-specific error; it does not switch pipeline or device. CPU processing only starts after the user selects CPU.

| Pipeline      | Device/backend                      | Runtime variant          | Windows lock                             |
| ------------- | ----------------------------------- | ------------------------ | ---------------------------------------- |
| Hayai         | CPU                                 | `hayai-cpu`              | `requirements-hayai-cpu-win.lock`        |
| Hayai         | NVIDIA CUDA 12.6                    | `hayai-cuda-cu126`       | `requirements-hayai-cuda-cu126-win.lock` |
| Hayai         | NVIDIA CUDA 13.0                    | `hayai-cuda-cu130`       | `requirements-hayai-cuda-cu130-win.lock` |
| Hayai         | AMD ROCm 7.2.1                      | `hayai-rocm`             | `requirements-hayai-rocm-win.lock`       |
| Paddle legacy | CPU / Paddle GPU / Transformers GPU | existing legacy variants | existing legacy locks                    |

Hayai locks are hash-complete and forbid Paddle packages. Custom Hayai package or PyTorch index overrides require a caller-supplied hash-complete requirements lock.

Normal runtimes use variant-specific `.venv-*` and `python-packages-*` directories. Windows ROCm uses short paths because native wheel entries can exceed the legacy path limit. Its engine-owned leaves are disjoint:

- Hayai: runtime `h721`, packages `h`, venv `y`
- Paddle legacy: runtime `r721`, packages `p`, venv `v`

Shared download caches may contain generic pip, Hugging Face, or PyTorch artifacts. An engine's import path, package directory, venv, install marker, and verification contract must remain private.

## Environment policy

Generic `MANGA_TRANSLATOR_OCR_*` device, PyTorch, Hugging Face, worker, cache, and safety settings may apply to both engines. `MANGA_TRANSLATOR_PADDLEOCR_*` compatibility variables are read only by the legacy pipeline. Hayai must not emit Paddle environment keys, prepare PaddleX aliases/models, import Paddle packages, or accept legacy Paddle package/device overrides.

The generic ROCm convolution safety setting is `MANGA_TRANSLATOR_OCR_DISABLE_MIOPEN`. The legacy Python adapter still accepts the old Paddle spelling for backward compatibility, but Hayai does not read it.

## Progress and diagnostics

The canonical runtime progress emitter attaches `ocrPipeline` to every OCR event. Renderer labels are resolved from that identity, while install/download/verification messages use the engine profile label. A Hayai event must never contain Paddle branding, even when the underlying output is a generic Hugging Face download line.

Batches must have one uniform provider, runtime variant, and engine configuration. Mixed profiles fail before runtime preparation so the first page cannot silently choose the engine for later pages.

## Regression contract

`tests/ocrEngineIsolation.test.ts` enforces provider ownership, command selection, runtime/package/venv separation, environment isolation, progress identity, mixed-batch rejection, and Hayai error branding. Runtime planning and package identity suites additionally validate locks, imports, layout, and device-specific install plans.

User-facing naming is **Text Detector + Hayai OCR** or **HayaiOCR**. Koharu is an implementation detail of a detector adapter and is not the pipeline name.
