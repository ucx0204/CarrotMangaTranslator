const DEFAULT_MODEL_HF = "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
const DEFAULT_HF_FILE = "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf";
const DEFAULT_MMPROJ_HF = "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
const DEFAULT_MMPROJ_FILE = "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_REASONING_EFFORT = "low";
const DEFAULT_API_KEY = "local-llama-server";
const DEFAULT_OCR_CPU_PIP_PACKAGES = ["paddlepaddle==3.3.1", "paddleocr[doc-parser]==3.5.0"];
const DEFAULT_OCR_GPU_PADDLE_PACKAGE = "paddlepaddle-gpu==3.3.1";
const DEFAULT_OCR_GPU_EXTRA_PACKAGES = ["paddleocr[doc-parser]==3.5.0"];
const DEFAULT_OCR_GPU_CUDA_TAG = "cu126";
const RTX_50_WINDOWS_PADDLE_GPU_WHEEL_CP312 =
  "https://paddle-qa.bj.bcebos.com/paddle-pipeline/Develop-TagBuild-Training-Windows-Gpu-Cuda12.9-Cudnn9.9-Trt10.5-Mkl-Avx-VS2019-SelfBuiltPypiUse/86d658f56ebf3a5a7b2b33ace48f22d10680d311/paddlepaddle_gpu-3.0.0.dev20250717-cp312-cp312-win_amd64.whl";
const OCR_INSTALL_MARKER_FILE = "install-complete.json";
const MAX_LOG_PREVIEW_LENGTH = 8000;
const MM_PROJ_CANDIDATE_NAMES = ["mmproj-BF16.gguf", "mmproj-F16.gguf", "mmproj-F32.gguf", "mmproj.gguf"];
const DEFAULT_OCR_BBOX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_OCR_BBOX_PAGE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS = 30000;
const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DOWNLOAD_RETRY_COUNT = 3;
const HF_DOWNLOAD_CHUNK_SIZE = 10 * 1024 * 1024;
const CROP_RETRY_MIN_SIDE_PX = 192;
const CROP_RETRY_MIN_MARGIN_PX = 64;
const CROP_RETRY_MARGIN_RATIO = 0.5;
const PADDLE_OCR_MODEL_DOWNLOADS = [
  {
    name: "PP-DocLayoutV3",
    repo: "PaddlePaddle/PP-DocLayoutV3",
    files: [".gitattributes", "README.md", "inference.json", "inference.pdiparams", "inference.yml"]
  },
  {
    name: "PaddleOCR-VL-1.5",
    repo: "PaddlePaddle/PaddleOCR-VL-1.5",
    files: [
      ".gitattributes",
      "LICENSE",
      "README.md",
      "added_tokens.json",
      "chat_template.jinja",
      "config.json",
      "configuration_paddleocr_vl.py",
      "generation_config.json",
      "image_processing_paddleocr_vl.py",
      "inference.yml",
      "model.safetensors",
      "modeling_paddleocr_vl.py",
      "preprocessor_config.json",
      "processing_paddleocr_vl.py",
      "processor_config.json",
      "special_tokens_map.json",
      "tokenizer.json",
      "tokenizer.model",
      "tokenizer_config.json"
    ]
  },
  {
    name: "PP-OCRv5_server_det",
    repo: "PaddlePaddle/PP-OCRv5_server_det",
    files: [".gitattributes", "README.md", "config.json", "inference.json", "inference.pdiparams", "inference.yml"]
  },
  {
    name: "PP-OCRv5_server_rec",
    repo: "PaddlePaddle/PP-OCRv5_server_rec",
    files: [".gitattributes", "README.md", "config.json", "inference.json", "inference.pdiparams", "inference.yml"]
  }
];

module.exports = {
  CROP_RETRY_MARGIN_RATIO,
  CROP_RETRY_MIN_MARGIN_PX,
  CROP_RETRY_MIN_SIDE_PX,
  DEFAULT_API_KEY,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS,
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
  RTX_50_WINDOWS_PADDLE_GPU_WHEEL_CP312
};
