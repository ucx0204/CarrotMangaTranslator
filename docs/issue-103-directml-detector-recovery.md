# Issue #103: Text Detector DirectML device-loss recovery

## Evidence and scope

[Issue #103](https://github.com/ucx0204/CarrotMangaTranslator/issues/103) reports repeated analysis failures on Windows 10, GTX 1650 4 GiB, app v2.7.1. The native ONNX error identifies `DmlFusedNode_0_0`, `ExecuteCommandList HRESULT=0x887A0006`, and DirectML device loss. The reporter says v2.6.2 works.

The v2.6.2-to-v2.7.0 diff does not change the detector model, ONNX Runtime version, or detector session/inference code. The report alone cannot establish the driver-level trigger. It does establish an unhandled runtime failure: session creation can fall back to CPU, but an error from an already-created DirectML session previously aborted the entire detector prepass.

The last progress message was misleading: prepass cleanup emitted “all pages detected” even after detection failed. The error occurred during detection, before HayaiOCR starts.

## Recovery contract

- `bubbleLayout/session.ts` recognizes native device removed/hung/reset HRESULTs and explicit DirectML device-loss errors. Cancellation, ordinary inference errors, and aggregate failures remain terminal.
- The failed session is marked unavailable inside its exclusive run lease. Already queued callers cannot run it again. Native release is shared with job cleanup and happens exactly once; a release failure preserves both errors and prevents fallback.
- `bubbleLayout/detector.ts` retries the same prepared tensor once on the CPU provider of the same pinned model. Later pages reuse the CPU session. If CPU creation/inference also fails, both causes are preserved. Cancellation releases tensors and does not start or repeat work.
- Job-level disposal resets provider availability, preserving the existing policy of allowing a later job to try the GPU again.
- OCR engine/device selection, preprocessing, detector output parsing, masks, geometry, and model assets are unchanged. The successful detector-release progress message is emitted only after successful detection.

## Validation

- `tests/bubbleOnnxRuntime.test.ts` exercises the actual detector, preprocessing, output parsing, session cache, and run leases with the native runtime boundary replaced. It covers the issue's exact error shape, CPU output geometry, repeated and concurrent pages, queued leases, unrelated errors, cancellation, CPU failure, and cleanup failure.
- `tests/translationRuntimePort.test.ts` verifies that a failed prepass never starts HayaiOCR or emits the successful detection-complete message. Existing detector geometry and backend tests remain in place.
- Local native smoke used the pinned model with SHA-256 `7cc10d4316371946b8441da3512261a8e148b129abcdb0ea6235ed1d1d06d351`. A single `0x887A0006` error was injected at the native DirectML run boundary; actual ONNX Runtime CPU inference then processed two synthetic blank pages. One CPU session was created and one failed GPU session was released. The run took 13 seconds. Evidence: `.tmp/issue103-native-smoke-20260914/result.json`.
- The local GPU is RTX 4090. This verifies recovery with real CPU inference, not a physical GTX 1650 driver reset.

## References

- [ONNX Runtime DirectML configuration](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html#configuration-options): sequential execution, disabled memory patterns, and no concurrent calls on one DirectML session.
- [Microsoft DXGI error codes](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/dxgi-error).
