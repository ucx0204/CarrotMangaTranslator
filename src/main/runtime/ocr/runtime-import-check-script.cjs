// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const {
  isOcrGpuRequested,
  isOcrTorchRuntime,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrTorchCudaTag,
} = require("./runtime-device.cjs");
const { isHayaiOcrPipeline } = require("./engine-profile.cjs");

/** @param {RuntimeOptions} [options] @returns {string} */
function buildOcrRuntimeImportCheckScript(options = {}) {
  const device = resolveOcrDevice(options);
  if (isOcrTorchRuntime(options)) {
    if (!isOcrGpuRequested(options)) {
      return buildCpuTransformersImportCheckScript(options);
    }
    if (resolveOcrGpuBackend(options) === "xpu") {
      return [
        ...buildTransformersImportPrelude(options),
        "assert not missing, 'Missing HayaiOCR XPU package(s): ' + ', '.join(missing)",
        "import torch, torchvision, tokenizers",
        "assert torch.__version__ == '2.14.1+xpu' and torchvision.__version__ == '0.29.1+xpu', 'Unexpected Intel XPU PyTorch build'",
        "assert tokenizers.__version__ == '0.23.2'",
        ...buildTransformersApiCheckLines(options),
        "assert torch.xpu.is_available(), 'Intel XPU is unavailable. Select HayaiOCR CPU or update the Intel graphics driver.'",
        "index = int(os.environ.get('MGT_HAYAI_XPU_INDEX', 0))",
        "x = torch.ones((1,), device=f'xpu:{index}')",
        "torch.xpu.synchronize(index)",
        "print('Intel XPU', torch.xpu.get_device_name(index))",
      ].join("; ");
    }
    return resolveOcrGpuBackend(options) === "rocm-transformers"
      ? buildRocmImportCheckScript(options)
      : buildCudaTransformersImportCheckScript(options);
  }
  return buildPaddleImportCheckScript(device);
}

/** @param {RuntimeOptions} options @returns {string} */
function buildRocmImportCheckScript(options) {
  const lines = [
    ...buildTransformersImportPrelude(options),
    "assert not missing, 'Missing AMD ROCm OCR package(s): ' + ', '.join(missing)",
    "import torch",
    `_expected_rocm_tag = '+rocm${isHayaiOcrPipeline(options) ? "10.0.0" : "7.2.1"}'`,
    "_torch_version = str(torch.__version__).lower()",
    "assert _torch_version.endswith(_expected_rocm_tag), 'Unexpected AMD ROCm PyTorch build: expected ' + _expected_rocm_tag + ', got ' + _torch_version",
    "assert getattr(torch.version, 'hip', None), 'PyTorch is not a ROCm/HIP build'",
    "import torchvision",
    "_torchvision_version = str(torchvision.__version__).lower()",
    "assert _torchvision_version.endswith(_expected_rocm_tag), 'Unexpected AMD ROCm TorchVision build: expected ' + _expected_rocm_tag + ', got ' + _torchvision_version",
    "assert torch.cuda.is_available(), 'AMD ROCm PyTorch GPU is not available'",
    "x = torch.ones((1,), device='cuda')",
    "torch.cuda.synchronize()",
    "import tokenizers",
    `assert tokenizers.__version__.replace('-', '') == '${isHayaiOcrPipeline(options) ? "0.23.2" : "0.23.0rc0"}', 'Unsupported tokenizers version: ' + tokenizers.__version__`,
    ...buildTransformersApiCheckLines(options),
    "print('torch', torch.__version__)",
    "print('hip', torch.version.hip)",
    "print('gpu', torch.cuda.get_device_name(0))",
  ];
  if (!isHayaiOcrPipeline(options)) {
    lines.push("from paddleocr import PaddleOCR");
  }
  return lines.join("; ");
}

/** @param {RuntimeOptions} options @returns {string} */
function buildCudaTransformersImportCheckScript(options) {
  const expectedCudaTag = `+${resolveOcrTorchCudaTag(options)}`;
  const lines = [
    ...buildTransformersImportPrelude(options),
    "assert not missing, 'Missing NVIDIA CUDA Transformers OCR package(s): ' + ', '.join(missing)",
    "import torch",
    `_expected_cuda_tag = ${JSON.stringify(expectedCudaTag)}`,
    "_torch_version = str(torch.__version__).lower()",
    "assert _torch_version.endswith(_expected_cuda_tag), 'Unexpected NVIDIA CUDA PyTorch build: expected ' + _expected_cuda_tag + ', got ' + _torch_version",
    "assert getattr(torch.version, 'cuda', None), 'PyTorch is not a CUDA build'",
    "import torchvision",
    "_torchvision_version = str(torchvision.__version__).lower()",
    "assert _torchvision_version.endswith(_expected_cuda_tag), 'Unexpected NVIDIA CUDA TorchVision build: expected ' + _expected_cuda_tag + ', got ' + _torchvision_version",
    "assert torch.cuda.is_available(), 'NVIDIA CUDA PyTorch GPU is not available'",
    "x = torch.ones((1,), device='cuda')",
    "torch.cuda.synchronize()",
    "import tokenizers",
    `assert tokenizers.__version__.replace('-', '') == '${isHayaiOcrPipeline(options) ? "0.23.2" : "0.23.0rc0"}', 'Unsupported tokenizers version: ' + tokenizers.__version__`,
    ...buildTransformersApiCheckLines(options),
    "print('torch', torch.__version__)",
    "print('cuda', torch.version.cuda)",
    "print('gpu', torch.cuda.get_device_name(0))",
  ];
  if (!isHayaiOcrPipeline(options)) {
    lines.push("from paddleocr import PaddleOCR");
  }
  return lines.join("; ");
}

/** @param {RuntimeOptions} options @returns {string} */
function buildCpuTransformersImportCheckScript(options) {
  const torchVersion = "2.14.1";
  const visionVersion = "0.29.1";
  return [
    ...buildTransformersImportPrelude(options),
    "assert not missing, 'Missing HayaiOCR CPU package(s): ' + ', '.join(missing)",
    "import torch",
    "_torch_version = str(torch.__version__).lower()",
    `assert _torch_version in ('${torchVersion}', '${torchVersion}+cpu'), 'Unexpected CPU PyTorch build: expected ${torchVersion} or ${torchVersion}+cpu, got ' + _torch_version`,
    "assert not getattr(torch.version, 'cuda', None), 'Unexpected CPU PyTorch build: CUDA-enabled package installed'",
    "assert not getattr(torch.version, 'hip', None), 'Unexpected CPU PyTorch build: ROCm-enabled package installed'",
    "import torchvision",
    "_torchvision_version = str(torchvision.__version__).lower()",
    `assert _torchvision_version in ('${visionVersion}', '${visionVersion}+cpu'), 'Unexpected CPU TorchVision build: expected ${visionVersion} or ${visionVersion}+cpu, got ' + _torchvision_version`,
    "import tokenizers",
    `assert tokenizers.__version__.replace('-', '') == '0.23.2', 'Unsupported tokenizers version: ' + tokenizers.__version__`,
    "import transformers",
    "_auto_model = transformers.AutoModel",
    "_auto_processor = transformers.AutoProcessor",
    "_pretrained_tokenizer = transformers.PreTrainedTokenizerFast",
    "from huggingface_hub import snapshot_download",
    "from PIL import Image",
    "print('torch', torch.__version__)",
    "print('device', 'cpu')",
  ].join("; ");
}

/** @param {RuntimeOptions} options @returns {string[]} */
function buildTransformersImportPrelude(options) {
  const required = isHayaiOcrPipeline(options)
    ? [
        "torch",
        "torchvision",
        "transformers",
        "tokenizers",
        "safetensors",
        "huggingface_hub",
        "PIL",
      ]
    : [
        "torch",
        "torchvision",
        "transformers",
        "tokenizers",
        "paddlex",
        "paddleocr",
        "safetensors",
      ];
  return [
    "import os",
    "_dll_dirs = [p for p in os.environ.get('MANGA_TRANSLATOR_OCR_DLL_DIRS', '').split(os.pathsep) if p]",
    "_dll_handles = [os.add_dll_directory(p) for p in _dll_dirs if hasattr(os, 'add_dll_directory') and os.path.isdir(p)]",
    "import importlib.util",
    `missing = [name for name in ${JSON.stringify(required)} if importlib.util.find_spec(name) is None]`,
  ];
}

/** @param {RuntimeOptions} options @returns {string[]} */
function buildTransformersApiCheckLines(options) {
  if (isHayaiOcrPipeline(options)) {
    return [
      "import transformers",
      "_auto_model = transformers.AutoModel",
      "_auto_processor = transformers.AutoProcessor",
      "_pretrained_tokenizer = transformers.PreTrainedTokenizerFast",
      "from huggingface_hub import snapshot_download",
      "from PIL import Image",
    ];
  }
  return [
    "import transformers",
    "_auto_image_processor = transformers.AutoImageProcessor",
    "_auto_object_detector = transformers.AutoModelForObjectDetection",
  ];
}

/** @param {string} device @returns {string} */
function buildPaddleImportCheckScript(device) {
  const lines = [
    "import os",
    "_dll_dirs = [p for p in os.environ.get('MANGA_TRANSLATOR_OCR_DLL_DIRS', '').split(os.pathsep) if p]",
    "_dll_handles = [os.add_dll_directory(p) for p in _dll_dirs if hasattr(os, 'add_dll_directory') and os.path.isdir(p)]",
    "import importlib.util",
    "missing = [name for name in ('paddle', 'paddlex', 'paddleocr') if importlib.util.find_spec(name) is None]",
    "assert not missing, 'Missing Paddle OCR package(s): ' + ', '.join(missing)",
    "import paddle",
    "from paddleocr import PaddleOCR",
  ];
  if (device.startsWith("gpu")) {
    lines.push(
      "assert paddle.device.is_compiled_with_cuda(), 'PaddlePaddle is not compiled with CUDA'",
      "count = paddle.device.cuda.device_count()",
      "assert count > 0, 'No CUDA device is visible to PaddlePaddle'",
      `paddle.set_device(${JSON.stringify(device)})`,
    );
  } else {
    lines.push(
      "assert not paddle.device.is_compiled_with_cuda(), 'Unexpected CPU PaddlePaddle build: CUDA-enabled package installed'",
    );
  }
  return lines.join("; ");
}

module.exports = { buildOcrRuntimeImportCheckScript };
