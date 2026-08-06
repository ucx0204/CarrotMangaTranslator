import { describe, it, expect } from "vitest";
import {
  createTempDir,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  buildOcrRuntimeEnv,
  restoreEnv,
  resolveOcrPipInstallBatches,
  buildPaddleOcrImportCheckScript,
  resolveOcrRuntimeVariant,
  resolveOcrPythonPackageDir,
  collectRequiredPaddleOcrModelDownloads,
  resolveOcrGpuBackend,
  resolveEffectiveOcrDevice,
  buildOcrBboxBatchCommand,
} from "./helpers/runtimeModelContracts";
import { join } from "node:path";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows(
  "runtime model support helpers: NVIDIA and AMD runtime environments",
  () => {
    it("uses the configured CUDA tag for isolated Paddle OCR GPU runtimes", () => {
      const runtimeDir = createTempDir("ocr-runtime-");
      const previousCudaTag = process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG;
      const previousPaddleCudaTag =
        process.env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG;
      const previousOcrGpuCuda = process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA;
      const previousIndexUrl =
        process.env.MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL;
      const previousPaddleIndexUrl =
        process.env.MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL;
      delete process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG;
      delete process.env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG;
      delete process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA;
      delete process.env.MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL;
      delete process.env.MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL;
      try {
        expect(resolveOcrGpuCudaTag({ ocrGpuCudaTag: "cu129" })).toBe("cu129");
        expect(resolveOcrGpuPackageIndexUrl({ ocrGpuCudaTag: "cu129" })).toBe(
          "https://www.paddlepaddle.org.cn/packages/stable/cu129/",
        );
        const env = buildOcrRuntimeEnv(
          { ocrDevice: "gpu", ocrGpuCudaTag: "cu129" },
          { runtimeDir, includePackageDir: false },
        );
        expect(env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG).toBe("cu129");
        expect(env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE).toBe("gpu:0");
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", previousCudaTag);
        restoreEnv(
          "MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG",
          previousPaddleCudaTag,
        );
        restoreEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA", previousOcrGpuCuda);
        restoreEnv(
          "MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL",
          previousIndexUrl,
        );
        restoreEnv(
          "MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL",
          previousPaddleIndexUrl,
        );
      }
    });

    it("uses official cu129 Paddle OCR packages and Windows safetensors for RTX 50 GPU OCR runtimes", () => {
      const cu129Batches = resolveOcrPipInstallBatches({
        ocrDevice: "gpu",
        ocrGpuCudaTag: "cu129",
      });
      const cu126Batches = resolveOcrPipInstallBatches({
        ocrDevice: "gpu",
        ocrGpuCudaTag: "cu126",
      });
      const cpuBatches = resolveOcrPipInstallBatches({ ocrDevice: "cpu" });

      expect(cu129Batches[0]).toEqual([
        "paddlepaddle-gpu==3.3.1",
        "--index-url",
        "https://www.paddlepaddle.org.cn/packages/stable/cu129/",
      ]);
      expect(cu129Batches[1]).toEqual(["paddleocr[doc-parser]==3.7.0"]);
      if (process.platform === "win32") {
        expect(cu129Batches[2][0]).toBe("--no-deps");
        expect(cu129Batches[2][1]).toBe("--force-reinstall");
        expect(cu129Batches[2][2]).toContain("safetensors-0.6.2.dev0");
      }
      expect(cu126Batches[0]).toEqual([
        "paddlepaddle-gpu==3.3.1",
        "--index-url",
        "https://www.paddlepaddle.org.cn/packages/stable/cu126/",
      ]);
      expect(cu126Batches[1]).toEqual(["paddleocr[doc-parser]==3.7.0"]);
      expect(cpuBatches[0][0]).toBe("paddlepaddle==3.3.1");
      expect(cpuBatches[0][1]).toBe("paddleocr[doc-parser]==3.7.0");
      if (process.platform === "win32") {
        expect(cu126Batches[2][0]).toBe("--no-deps");
        expect(cu126Batches[2][1]).toBe("--force-reinstall");
        expect(cu126Batches[2][2]).toContain("safetensors-0.6.2.dev0");
        expect(cpuBatches[1][0]).toBe("--no-deps");
        expect(cpuBatches[1][1]).toBe("--force-reinstall");
        expect(cpuBatches[1][2]).toContain("safetensors-0.6.2.dev0");
      }
    });

    it("isolates NVIDIA Transformers OCR from the CUDA legacy Paddle runtime", () => {
      const runtimeDir = createTempDir("ocr-runtime-");
      const cuda126Options = {
        ocrDevice: "gpu",
        ocrGpuBackend: "cuda",
        ocrGpuCudaTag: "cu126",
        ocrEngine: "transformers",
      };
      const cuda129Options = {
        ...cuda126Options,
        ocrGpuCudaTag: "cu129",
      };
      const cu126Batches = resolveOcrPipInstallBatches(cuda126Options);
      const cu129Batches = resolveOcrPipInstallBatches(cuda129Options);
      const env = buildOcrRuntimeEnv(cuda129Options, {
        runtimeDir,
        includePackageDir: true,
      });
      const script = buildPaddleOcrImportCheckScript(cuda129Options);

      expect(cu126Batches).toHaveLength(3);
      expect(cu126Batches[0]).toEqual(
        expect.arrayContaining(["filelock", "numpy", "pillow"]),
      );
      expect(cu126Batches[1]).toEqual([
        "torch==2.9.1",
        "torchvision==0.24.1",
        "--index-url",
        "https://download.pytorch.org/whl/cu126",
      ]);
      expect(cu129Batches[1]).toEqual([
        "torch==2.9.1",
        "torchvision==0.24.1",
        "--index-url",
        "https://download.pytorch.org/whl/cu130",
      ]);
      expect(cu129Batches[2]).toEqual([
        "paddleocr==3.7.0",
        "transformers==5.13.1",
        "safetensors>=0.6.2",
        "tokenizers==0.23.0rc0",
      ]);
      expect(cu129Batches.flat().join(" ")).not.toContain("paddlepaddle-gpu");
      expect(cu129Batches.flat().join(" ")).not.toContain(
        "safetensors-0.6.2.dev0",
      );
      expect(resolveOcrRuntimeVariant(cuda126Options)).toBe(
        "gpu-cuda-transformers-cu126",
      );
      expect(resolveOcrRuntimeVariant(cuda129Options)).toBe(
        "gpu-cuda-transformers-cu130",
      );
      expect(resolveOcrPythonPackageDir(runtimeDir, cuda129Options)).not.toBe(
        resolveOcrPythonPackageDir(runtimeDir, {
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrGpuCudaTag: "cu129",
        }),
      );
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("transformers");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBe("float32");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBe("ocr");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBe("semantic");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN).toBeUndefined();
      expect(env.MANGA_TRANSLATOR_OCR_DLL_DIRS).toContain(
        join("python-packages-gpu-cuda-transformers-cu130", "torch", "lib"),
      );
      expect(script).toContain("import torch");
      expect(script).toContain("import torchvision");
      expect(script).toContain("import tokenizers");
      expect(script).toContain("torch.version.cuda");
      expect(script).toContain("transformers.AutoModelForObjectDetection");
      expect(script).toContain("from paddleocr import PaddleOCR");
      expect(script).not.toContain("import paddle");
      expect(script).not.toContain("PaddleOCRVL");
      expect(collectRequiredPaddleOcrModelDownloads(cuda129Options)).toEqual(
        [],
      );
    });

    it("uses native Windows ROCm PyTorch packages for AMD Transformers OCR runtimes", () => {
      const rocmBatches = resolveOcrPipInstallBatches({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm",
      });
      const env = buildOcrRuntimeEnv(
        { ocrDevice: "gpu", ocrGpuBackend: "rocm" },
        { runtimeDir: "C:/ocr-runtime", includePackageDir: false },
      );
      const script = buildPaddleOcrImportCheckScript({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm",
      });

      expect(resolveOcrGpuBackend({ ocrGpuBackend: "amd" })).toBe(
        "rocm-transformers",
      );
      expect(rocmBatches).toHaveLength(5);
      expect(rocmBatches[0]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("rocm_sdk_core-7.2.1"),
          expect.stringContaining("rocm_sdk_devel-7.2.1"),
          expect.stringContaining("rocm_sdk_libraries_custom-7.2.1"),
        ]),
      );
      expect(rocmBatches[0].join(" ")).not.toContain("rocm-7.2.1.tar.gz");
      expect(rocmBatches[1]).toEqual(
        expect.arrayContaining([expect.stringContaining("rocm-7.2.1.tar.gz")]),
      );
      expect(rocmBatches[2]).toEqual(
        expect.arrayContaining([
          "filelock",
          expect.stringContaining("typing-extensions"),
          "setuptools",
          expect.stringContaining("sympy"),
          expect.stringContaining("networkx"),
          "jinja2",
          expect.stringContaining("fsspec"),
          "numpy",
          "pillow",
        ]),
      );
      expect(rocmBatches[3]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("torch-2.9.1%2Brocm7.2.1"),
          expect.stringContaining("torchaudio-2.9.1%2Brocm7.2.1"),
          expect.stringContaining("torchvision-0.24.1%2Brocm7.2.1"),
        ]),
      );
      expect(rocmBatches[4]).toEqual([
        "paddleocr==3.7.0",
        "transformers==5.13.1",
        "safetensors>=0.6.2",
        "tokenizers==0.23.0rc0",
      ]);
      expect(rocmBatches.flat().join(" ")).not.toContain("paddlepaddle-gpu");
      expect(rocmBatches.flat().join(" ")).not.toContain("/cu126/");
      expect(rocmBatches.flat().join(" ")).not.toContain("/cu129/");
      expect(env.MANGA_TRANSLATOR_OCR_GPU_BACKEND).toBe("rocm-transformers");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE).toBe("gpu:0");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("transformers");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBe("float32");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBe("ocr");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_VERSION).toBe("PP-OCRv6");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_ATTN).toBe("eager");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBe("semantic");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN).toBe("1");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT).toBe("1600");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH).toBe("1");
      expect(script).toContain("import torch");
      expect(script).toContain("import torchvision");
      expect(script).toContain("import tokenizers");
      expect(script).toContain("0.23.0rc0");
      expect(script).toContain("import transformers");
      expect(script).toContain("'paddlex'");
      expect(script).toContain("'safetensors'");
      expect(script).toContain("transformers.AutoImageProcessor");
      expect(script).toContain("transformers.AutoModelForObjectDetection");
      expect(script).toContain("torch.cuda.is_available()");
      expect(script).toContain("torch.version");
      expect(script).toContain("from paddleocr import PaddleOCR");
      expect(script).not.toContain("import paddle");
      expect(script).not.toContain("PaddleOCRVL");
      expect(resolveOcrRuntimeVariant({ ocrDevice: "cpu" })).toBe("cpu");
      expect(
        resolveOcrRuntimeVariant({ ocrDevice: "gpu", ocrGpuCudaTag: "cu126" }),
      ).toBe("gpu-cu126");
      expect(
        resolveOcrRuntimeVariant({ ocrDevice: "gpu", ocrGpuCudaTag: "cu129" }),
      ).toBe("gpu-cu129");
      expect(
        resolveOcrRuntimeVariant({
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        }),
      ).toBe("gpu-rocm-transformers");
    });

    it("keeps CPU AMD low modes on the static Paddle runtime", () => {
      const options = {
        ocrDevice: "cpu",
        ocrGpuBackend: "rocm-transformers",
        ocrEngine: "paddle_static",
        ocrTextDetectionModelName: "PP-OCRv6_small_det",
        ocrTextRecognitionModelName: "PP-OCRv6_tiny_rec",
      };
      const batches = resolveOcrPipInstallBatches(options);
      const env = buildOcrRuntimeEnv(options);
      const script = buildPaddleOcrImportCheckScript(options);

      expect(resolveOcrRuntimeVariant(options)).toBe("cpu");
      expect(batches[0]).toEqual([
        "paddlepaddle==3.3.1",
        "paddleocr[doc-parser]==3.7.0",
      ]);
      expect(batches.flat().join(" ")).not.toContain("torch");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("paddle_static");
      expect(script).toContain("import paddle");
      expect(script).not.toContain("import torch");
      expect(collectRequiredPaddleOcrModelDownloads(options)).not.toEqual([]);
    });

    it("keeps ROCm Transformers safe GPU defaults scoped to AMD OCR", () => {
      const previousAttn = process.env.MANGA_TRANSLATOR_PADDLEOCR_ATTN;
      const previousDtype = process.env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE;
      const previousDisableMiopen =
        process.env.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN;
      const previousDetLimit = process.env.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT;
      const previousRecBatch = process.env.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH;
      const previousMergeMode =
        process.env.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE;
      try {
        const rocmEnv = buildOcrRuntimeEnv({
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        });

        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBe("ocr");
        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("transformers");
        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBe("float32");
        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_VERSION).toBe("PP-OCRv6");
        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ATTN).toBe("eager");
        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBe("semantic");
        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN).toBe("1");
        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT).toBe("1600");
        expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH).toBe("1");
        expect(
          buildOcrRuntimeEnv({ ocrDevice: "cpu" })
            .MANGA_TRANSLATOR_PADDLEOCR_ATTN,
        ).toBeUndefined();
        expect(
          buildOcrRuntimeEnv({ ocrDevice: "cpu" })
            .MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE,
        ).toBeUndefined();
        expect(
          buildOcrRuntimeEnv({ ocrDevice: "cpu" })
            .MANGA_TRANSLATOR_PADDLEOCR_ENGINE,
        ).toBeUndefined();
        expect(buildOcrRuntimeEnv({ ocrDevice: "cpu" }).OMP_NUM_THREADS).toBe(
          "2",
        );
        expect(buildOcrRuntimeEnv({ ocrDevice: "cpu" }).MKL_NUM_THREADS).toBe(
          "2",
        );
        expect(
          buildOcrRuntimeEnv({ ocrDevice: "cpu", ocrWorkerThreads: 3 })
            .OMP_NUM_THREADS,
        ).toBe("3");
        expect(
          buildOcrRuntimeEnv({ ocrDevice: "cpu" })
            .MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN,
        ).toBeUndefined();
        const cudaEnv = buildOcrRuntimeEnv({
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
        });
        expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_ATTN).toBeUndefined();
        expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBeUndefined();
        expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBeUndefined();
        expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBeUndefined();
        expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_VERSION).toBeUndefined();
        expect(cudaEnv.OMP_NUM_THREADS).toBeUndefined();
        expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBeUndefined();
        expect(
          cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN,
        ).toBeUndefined();

        process.env.MANGA_TRANSLATOR_PADDLEOCR_ATTN = "sdpa";
        process.env.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE = "none";
        process.env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE = "float16";
        process.env.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN = "0";
        process.env.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT = "960";
        process.env.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH = "2";
        const overriddenRocmEnv = buildOcrRuntimeEnv({
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        });
        expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBe(
          "float16",
        );
        expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ATTN).toBe("sdpa");
        expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBe(
          "none",
        );
        expect(
          overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN,
        ).toBe("0");
        expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT).toBe(
          "960",
        );
        expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH).toBe(
          "2",
        );
      } finally {
        restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_ATTN", previousAttn);
        restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE", previousDtype);
        restoreEnv(
          "MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN",
          previousDisableMiopen,
        );
        restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT", previousDetLimit);
        restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH", previousRecBatch);
        restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE", previousMergeMode);
      }
    });

    it("hardens the ROCm OCR child environment against VRAM fragmentation", () => {
      const previousAllocConf = process.env.PYTORCH_ALLOC_CONF;
      const previousLegacyAllocConf = process.env.PYTORCH_HIP_ALLOC_CONF;
      const previousVisibleDevices = process.env.HIP_VISIBLE_DEVICES;
      try {
        delete process.env.PYTORCH_ALLOC_CONF;
        delete process.env.PYTORCH_HIP_ALLOC_CONF;
        delete process.env.HIP_VISIBLE_DEVICES;
        const rocmEnv = buildOcrRuntimeEnv({
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        });
        expect(rocmEnv.PYTORCH_ALLOC_CONF).toBe(
          "garbage_collection_threshold:0.8,max_split_size_mb:512",
        );
        expect(
          buildOcrRuntimeEnv({ ocrDevice: "cpu" }).PYTORCH_ALLOC_CONF,
        ).toBeUndefined();
        expect(
          buildOcrRuntimeEnv({ ocrDevice: "gpu", ocrGpuBackend: "cuda" })
            .PYTORCH_ALLOC_CONF,
        ).toBeUndefined();

        process.env.PYTORCH_HIP_ALLOC_CONF = "max_split_size_mb:128";
        process.env.HIP_VISIBLE_DEVICES = "1";
        const overriddenEnv = buildOcrRuntimeEnv({
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        });
        expect(overriddenEnv.PYTORCH_ALLOC_CONF).toBe("max_split_size_mb:128");
        expect(overriddenEnv.PYTORCH_HIP_ALLOC_CONF).toBeUndefined();
        expect(overriddenEnv.HIP_VISIBLE_DEVICES).toBe("1");
        expect(
          buildOcrRuntimeEnv({ ocrDevice: "cpu" }).HIP_VISIBLE_DEVICES,
        ).toBeUndefined();
      } finally {
        restoreEnv("PYTORCH_ALLOC_CONF", previousAllocConf);
        restoreEnv("PYTORCH_HIP_ALLOC_CONF", previousLegacyAllocConf);
        restoreEnv("HIP_VISIBLE_DEVICES", previousVisibleDevices);
      }
    });

    it("isolates packaged ROCm OCR from an incompatible system ROCm install", () => {
      const previousRocmPath = process.env.ROCM_PATH;
      const previousHipPath = process.env.HIP_PATH;
      const previousVisibleDevices = process.env.HIP_VISIBLE_DEVICES;
      const previousGfxOverride = process.env.HSA_OVERRIDE_GFX_VERSION;
      const previousAllowExternal = process.env.MGT_ALLOW_EXTERNAL_RUNTIME;
      const previousLegacyAllowExternal =
        process.env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME;
      const previousAllocConf = process.env.PYTORCH_ALLOC_CONF;
      const previousLegacyAllocConf = process.env.PYTORCH_HIP_ALLOC_CONF;
      const packagedRoot = createTempDir("packaged-ocr-rocm-");
      const toolsDir = join(packagedRoot, "resources", "tools");
      try {
        delete process.env.MGT_ALLOW_EXTERNAL_RUNTIME;
        delete process.env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME;
        delete process.env.PYTORCH_ALLOC_CONF;
        delete process.env.PYTORCH_HIP_ALLOC_CONF;
        process.env.ROCM_PATH = "C:/Program Files/AMD/ROCm/7.1";
        process.env.HIP_PATH = "C:/Program Files/AMD/ROCm/7.1";
        process.env.HIP_VISIBLE_DEVICES = "1";
        process.env.HSA_OVERRIDE_GFX_VERSION = "12.0.1";

        const env = buildOcrRuntimeEnv({
          toolsDir,
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        });

        expect(env.ROCM_PATH).toBeUndefined();
        expect(env.HIP_PATH).toBeUndefined();
        expect(env.HIP_VISIBLE_DEVICES).toBe("1");
        expect(env.HSA_OVERRIDE_GFX_VERSION).toBe("12.0.1");
        expect(env.PYTORCH_ALLOC_CONF).toBe(
          "garbage_collection_threshold:0.8,max_split_size_mb:512",
        );
      } finally {
        restoreEnv("ROCM_PATH", previousRocmPath);
        restoreEnv("HIP_PATH", previousHipPath);
        restoreEnv("HIP_VISIBLE_DEVICES", previousVisibleDevices);
        restoreEnv("HSA_OVERRIDE_GFX_VERSION", previousGfxOverride);
        restoreEnv("MGT_ALLOW_EXTERNAL_RUNTIME", previousAllowExternal);
        restoreEnv(
          "MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME",
          previousLegacyAllowExternal,
        );
        restoreEnv("PYTORCH_ALLOC_CONF", previousAllocConf);
        restoreEnv("PYTORCH_HIP_ALLOC_CONF", previousLegacyAllocConf);
      }
    });

    it("never overrides the OCR device selected in settings", () => {
      expect(resolveEffectiveOcrDevice({ ocrDevice: "gpu" })).toBe("gpu:0");
      expect(
        resolveEffectiveOcrDevice({
          ocrDevice: "gpu",
          ocrDeviceOverride: "cpu",
        }),
      ).toBe("gpu:0");
      expect(resolveEffectiveOcrDevice({ ocrDevice: "cpu" })).toBe("cpu");

      const runtime = { pythonPath: "python" };
      const gpuCommand = buildOcrBboxBatchCommand(
        {
          ocrDevice: "gpu",
          ocrDeviceOverride: "cpu",
          ocrGpuBackend: "rocm-transformers",
        },
        "C:/batch.json",
        runtime,
      );
      expect(gpuCommand.args).toContain("--device");
      expect(gpuCommand.args).toContain("gpu:0");
    });
  },
);
