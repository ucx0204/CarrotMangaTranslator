// @ts-check
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");

const DEFAULT_MODEL_HF =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
const DEFAULT_HF_FILE =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf";
const DEFAULT_MMPROJ_HF =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
const DEFAULT_MMPROJ_FILE =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_REASONING_EFFORT = "low";
const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_MODEL = "gpt-5.5";
const DEFAULT_API_KEY = "local-llama-server";
const DEFAULT_API_TEMPERATURE = 0.2;
const DEFAULT_API_TOP_P = 0.95;
const DEFAULT_API_TOP_K = null;
const DEFAULT_API_REASONING_EFFORT = null;
const DEFAULT_API_EXTRA_BODY_JSON = "";
const DEFAULT_API_CUSTOM_HEADERS_JSON = "";
const DEFAULT_OCR_CPU_PIP_PACKAGES = [
  "paddlepaddle==3.3.1",
  "paddleocr[doc-parser]==3.7.0",
];
const DEFAULT_OCR_GPU_PADDLE_PACKAGE = "paddlepaddle-gpu==3.3.1";
const DEFAULT_OCR_GPU_EXTRA_PACKAGES = ["paddleocr[doc-parser]==3.7.0"];
const DEFAULT_OCR_GPU_CUDA_TAG = "cu126";
const AMD_ROCM_721_SDK_WHEEL_PACKAGES = [
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl",
];
const AMD_ROCM_721_META_PACKAGES = [
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz",
];
const AMD_ROCM_721_SDK_PACKAGES = [
  ...AMD_ROCM_721_SDK_WHEEL_PACKAGES,
  ...AMD_ROCM_721_META_PACKAGES,
];
const AMD_ROCM_721_TORCH_PACKAGES = [
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
];
const AMD_ROCM_721_TORCH_DEP_PACKAGES = [
  "filelock",
  "typing-extensions>=4.10.0",
  "setuptools",
  "sympy>=1.13.3",
  "networkx>=2.5.1",
  "jinja2",
  "fsspec>=0.8.5",
  "numpy",
  "pillow",
];
const DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES = [
  "paddleocr==3.7.0",
  "transformers==5.13.1",
  "safetensors>=0.6.2",
];
const DEFAULT_HAYAI_OCR_PACKAGES = [
  "transformers==5.13.1",
  "safetensors>=0.6.2",
  "tokenizers==0.23.0rc0",
];
const OCR_INSTALL_MARKER_FILE = "install-complete.json";
const MAX_LOG_PREVIEW_LENGTH = 8000;
const MM_PROJ_CANDIDATE_NAMES = [
  "mmproj-BF16.gguf",
  "mmproj-F16.gguf",
  "mmproj-F32.gguf",
  "mmproj.gguf",
];
const DEFAULT_OCR_BBOX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_OCR_BBOX_PAGE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS = 30000;
const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DOWNLOAD_RETRY_COUNT = 3;
const DEFAULT_DOWNLOAD_RANGE_CONCURRENCY = 4;
const HF_DOWNLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const CROP_RETRY_MIN_SIDE_PX = 192;
const CROP_RETRY_MIN_MARGIN_PX = 64;
const CROP_RETRY_MARGIN_RATIO = 0.5;
const PADDLE_OCR_MODEL_PINS = Object.freeze({
  "PP-DocLayoutV3": Object.freeze({
    revision: "7b48a7566925fa464281f930c58eee04fe2c862a",
    weightsSha256:
      "70bd316b0582769ec968829fd1feb1a6a58b7c941b938327e551b6b12b45c137",
  }),
  "PP-OCRv6_medium_det": Object.freeze({
    revision: "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
    weightsSha256:
      "85218d2e3d98f5a21c58b4220627be923a97aee5db3cc71f39536ab31ac53960",
  }),
  "PP-OCRv6_medium_rec": Object.freeze({
    revision: "e5a92bcbc5cc1b494628e458d267778f0704fd7c",
    weightsSha256:
      "1b01c79a914587933f615569e75de54f2e638ebb5d3f3b3c1b38c24ede8c7319",
  }),
  "PP-OCRv6_small_det": Object.freeze({
    revision: "106c97591b235f607453300d9fc8c1cad1b25488",
    weightsSha256:
      "5043d4ccc8d63402ccea8feefcee4db57077431a873e78d2191836a178a492da",
  }),
  "PP-OCRv6_small_rec": Object.freeze({
    revision: "bd619643acac4b9650c040234da8d944476ee3f1",
    weightsSha256:
      "406e1e689c9a7fbb04178007a3fe10cf852afe7bf8bb3bc6dbb9d532b13bd907",
  }),
  "PP-OCRv6_tiny_det": Object.freeze({
    revision: "d3177d4e5551463292a61e27cfca2b53e7c3fe9d",
    weightsSha256:
      "853f7ed317d4f2f80de646842e5bbc32f9d39c601562cbe466cda42e4bafb1b1",
  }),
  "PP-OCRv6_tiny_rec": Object.freeze({
    revision: "0736086f72f666350ebcdc0c3a504eeac89cdfad",
    weightsSha256:
      "bb2f8f54d1e25f28c71b6fa4fe23f5940e159cae27fbee96155c99f822156e57",
  }),
});
const PADDLE_OCR_MODEL_DOWNLOADS = [
  {
    name: "PP-OCRv6_medium_det",
    repo: "PaddlePaddle/PP-OCRv6_medium_det",
    ...PADDLE_OCR_MODEL_PINS["PP-OCRv6_medium_det"],
    weightsFile: "inference.pdiparams",
    files: [
      ".gitattributes",
      "README.md",
      "inference.json",
      "inference.pdiparams",
      "inference.yml",
    ],
  },
  {
    name: "PP-OCRv6_medium_rec",
    repo: "PaddlePaddle/PP-OCRv6_medium_rec",
    ...PADDLE_OCR_MODEL_PINS["PP-OCRv6_medium_rec"],
    weightsFile: "inference.pdiparams",
    files: [
      ".gitattributes",
      "README.md",
      "inference.json",
      "inference.pdiparams",
      "inference.yml",
    ],
  },
];

function resolveAmdRocmSdkPackages(options = {}) {
  if (
    isTruthy(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_ROCM_SKIP_META_PACKAGE",
        options,
      ),
    )
  ) {
    return AMD_ROCM_721_SDK_PACKAGES.filter(
      (item) => !isAmdRocmMetaPackage(item),
    );
  }
  return AMD_ROCM_721_SDK_PACKAGES;
}

function resolveAmdRocmSdkWheelPackages(options = {}) {
  return resolveAmdRocmSdkPackages(options).filter(
    (item) => !isAmdRocmMetaPackage(item),
  );
}

function resolveAmdRocmMetaPackage(options = {}) {
  return resolveAmdRocmSdkPackages(options).filter(isAmdRocmMetaPackage);
}

/**
 * @param {unknown} item
 * @returns {boolean}
 */
function isAmdRocmMetaPackage(item) {
  return /(?:^|[/\\])rocm-\d+(?:\.\d+)*\.tar\.gz(?:[?#].*)?$/i.test(
    String(item ?? ""),
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

module.exports = {
  AMD_ROCM_721_META_PACKAGES,
  AMD_ROCM_721_SDK_PACKAGES,
  AMD_ROCM_721_SDK_WHEEL_PACKAGES,
  AMD_ROCM_721_TORCH_DEP_PACKAGES,
  AMD_ROCM_721_TORCH_PACKAGES,
  CROP_RETRY_MARGIN_RATIO,
  CROP_RETRY_MIN_MARGIN_PX,
  CROP_RETRY_MIN_SIDE_PX,
  DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
  DEFAULT_HAYAI_OCR_PACKAGES,
  DEFAULT_API_KEY,
  DEFAULT_API_BASE_URL,
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_MODEL,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_K,
  DEFAULT_API_TOP_P,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_RANGE_CONCURRENCY,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
  DEFAULT_HF_FILE,
  DEFAULT_MMPROJ_FILE,
  DEFAULT_MMPROJ_HF,
  DEFAULT_MODEL_HF,
  DEFAULT_OCR_BBOX_PAGE_TIMEOUT_MS,
  DEFAULT_OCR_BBOX_TIMEOUT_MS,
  DEFAULT_OCR_CPU_PIP_PACKAGES,
  DEFAULT_OCR_GPU_CUDA_TAG,
  DEFAULT_OCR_GPU_EXTRA_PACKAGES,
  DEFAULT_OCR_GPU_PADDLE_PACKAGE,
  HF_DOWNLOAD_CHUNK_SIZE,
  MAX_LOG_PREVIEW_LENGTH,
  MM_PROJ_CANDIDATE_NAMES,
  OCR_INSTALL_MARKER_FILE,
  PADDLE_OCR_MODEL_DOWNLOADS,
  PADDLE_OCR_MODEL_PINS,
  resolveAmdRocmMetaPackage,
  resolveAmdRocmSdkPackages,
  resolveAmdRocmSdkWheelPackages,
};
