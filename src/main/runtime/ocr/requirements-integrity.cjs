// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { runtimeOverrideEnv } = require("./host-services.cjs");
const {
  isHayaiOcrPipeline,
  resolveOcrRuntimeVariant,
} = require("../simple-page-ocr-runtime-config.cjs");

const OCR_REQUIREMENTS_LOCK_OVERRIDE_NAMES = [
  "MANGA_TRANSLATOR_OCR_REQUIREMENTS_LOCK",
  "MGT_OCR_REQUIREMENTS_LOCK",
];
const HAYAI_OCR_PACKAGE_OVERRIDE_NAMES = [
  "MANGA_TRANSLATOR_HAYAI_OCR_PIP_PACKAGES",
  "MANGA_TRANSLATOR_HAYAI_OCR_CPU_PIP_PACKAGES",
  "MANGA_TRANSLATOR_HAYAI_OCR_CUDA_PIP_PACKAGES",
  "MANGA_TRANSLATOR_HAYAI_OCR_ROCM_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_TORCH_INDEX_URL",
];
const LEGACY_OCR_PACKAGE_OVERRIDE_NAMES = [
  "MANGA_TRANSLATOR_OCR_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_CPU_TRANSFORMERS_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_AMD_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_ROCM_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_GPU_PADDLE_WHEEL",
  "MANGA_TRANSLATOR_OCR_GPU_PADDLE_PACKAGE",
  "MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL",
  "MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL",
  "MANGA_TRANSLATOR_OCR_TORCH_INDEX_URL",
];

const CUDA_126_TORCH_HASH =
  "sha256:f2f1c68c7957ed8b6b56fc450482eb3fa53947fb74838b03834a1760451cf60f";
const CUDA_126_TORCHVISION_HASH =
  "sha256:54c1902bad62bd113f66dd3cc0368aa4d0005837100d3ab9dc823aebf945ead0";
const CUDA_130_TORCH_HASH =
  "sha256:cd3232a562ad2a2699d48130255e1b24c07dfe694a40dcd24fad683c752de121";
const CUDA_130_TORCHVISION_HASH =
  "sha256:d31ceaded0d9b737471fa680ccd9e1acb6d5f0f70f03ef3a8d786a99c79da7cf";
const CPU_TORCH_HASH =
  "sha256:01b1884f724977a20c7da2f640f1c7b37f4a2c117a7f4a6c1c0424d14cb86322";
const CPU_TORCHVISION_HASH =
  "sha256:0a3fecbadc155e7bf378178029215bfcd86f2cf453fbb1d9a474f375b3d475ae";

/** @type {Record<string, { required: string[]; forbidden: string[] }>} */
const OCR_BUILTIN_LOCK_CONTRACTS = {
  cpu: {
    required: ["paddlepaddle==3.3.1", "paddleocr==3.7.0"],
    forbidden: [
      "paddlepaddle-gpu @",
      "download.pytorch.org/whl/cu",
      "repo.radeon.com/rocm",
    ],
  },
  "hayai-cpu": {
    required: [
      "--index-url https://download.pytorch.org/whl/cpu",
      "torch==2.9.1+cpu",
      CPU_TORCH_HASH,
      "torchvision==0.24.1+cpu",
      CPU_TORCHVISION_HASH,
      "huggingface-hub==1.29.0",
      "transformers==5.13.1",
      "tokenizers==0.23.0rc0",
    ],
    forbidden: [
      "paddleocr==",
      "paddlex==",
      "paddlepaddle==",
      "paddlepaddle-gpu @",
      "download.pytorch.org/whl/cu",
      "repo.radeon.com/rocm",
    ],
  },
  "gpu-cu126": {
    required: [
      "paddlepaddle-gpu @ https://paddle-whl.bj.bcebos.com/stable/cu126/paddlepaddle-gpu/paddlepaddle_gpu-3.3.1-cp312-cp312-win_amd64.whl",
      "paddleocr==3.7.0",
    ],
    forbidden: [
      "paddlepaddle==3.3.1 \\",
      "/stable/cu129/",
      "download.pytorch.org/whl/",
      "repo.radeon.com/rocm",
    ],
  },
  "gpu-cu129": {
    required: [
      "paddlepaddle-gpu @ https://paddle-whl.bj.bcebos.com/stable/cu129/paddlepaddle-gpu/paddlepaddle_gpu-3.3.1-cp312-cp312-win_amd64.whl",
      "paddleocr==3.7.0",
    ],
    forbidden: [
      "paddlepaddle==3.3.1 \\",
      "/stable/cu126/",
      "download.pytorch.org/whl/",
      "repo.radeon.com/rocm",
    ],
  },
  "gpu-cuda-transformers-cu126": {
    required: [
      "--index-url https://download.pytorch.org/whl/cu126",
      "torch==2.9.1+cu126",
      CUDA_126_TORCH_HASH,
      "torchvision==0.24.1+cu126",
      CUDA_126_TORCHVISION_HASH,
      "paddleocr==3.7.0",
      "paddlex==3.7.2",
    ],
    forbidden: [
      "torch==2.9.1 \\",
      "+cu130",
      "paddlepaddle-gpu @",
      "repo.radeon.com/rocm",
    ],
  },
  "gpu-cuda-transformers-cu130": {
    required: [
      "--index-url https://download.pytorch.org/whl/cu130",
      "torch==2.9.1+cu130",
      CUDA_130_TORCH_HASH,
      "torchvision==0.24.1+cu130",
      CUDA_130_TORCHVISION_HASH,
      "paddleocr==3.7.0",
      "paddlex==3.7.2",
    ],
    forbidden: [
      "torch==2.9.1 \\",
      "+cu126",
      "paddlepaddle-gpu @",
      "repo.radeon.com/rocm",
    ],
  },
  "gpu-rocm-transformers": {
    required: [
      "torch @ https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
      "torchvision @ https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
      "paddleocr==3.7.0",
    ],
    forbidden: [
      "torch==2.9.1",
      "download.pytorch.org/whl/cu",
      "paddlepaddle-gpu @",
    ],
  },
  "hayai-cuda-cu126": {
    required: [
      "--index-url https://download.pytorch.org/whl/cu126",
      "torch==2.9.1+cu126",
      CUDA_126_TORCH_HASH,
      "torchvision==0.24.1+cu126",
      CUDA_126_TORCHVISION_HASH,
      "huggingface-hub==1.29.0",
      "transformers==5.13.1",
      "tokenizers==0.23.0rc0",
    ],
    forbidden: [
      "paddleocr==",
      "paddlex==",
      "paddlepaddle==",
      "paddlepaddle-gpu @",
      "+cu130",
      "repo.radeon.com/rocm",
    ],
  },
  "hayai-cuda-cu130": {
    required: [
      "--index-url https://download.pytorch.org/whl/cu130",
      "torch==2.9.1+cu130",
      CUDA_130_TORCH_HASH,
      "torchvision==0.24.1+cu130",
      CUDA_130_TORCHVISION_HASH,
      "huggingface-hub==1.29.0",
      "transformers==5.13.1",
      "tokenizers==0.23.0rc0",
    ],
    forbidden: [
      "paddleocr==",
      "paddlex==",
      "paddlepaddle==",
      "paddlepaddle-gpu @",
      "+cu126",
      "repo.radeon.com/rocm",
    ],
  },
  "hayai-rocm": {
    required: [
      "torch @ https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
      "torchvision @ https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
      "huggingface-hub==1.29.0",
      "transformers==5.13.1",
      "tokenizers==0.23.0rc0",
    ],
    forbidden: [
      "paddleocr==",
      "paddlex==",
      "paddlepaddle==",
      "paddlepaddle-gpu @",
      "download.pytorch.org/whl/cu",
    ],
  },
};

/**
 * Windows managed Python executes downloaded package code, so every built-in
 * package tree is installed from a generated, hash-complete lock. Custom
 * package/index overrides must supply their own lock instead of silently
 * downgrading the integrity boundary.
 *
 * @param {string[][]} installBatches
 * @param {RuntimeOptions} [options]
 * @returns {string[][]}
 */
function resolveIntegrityPinnedOcrInstallBatches(installBatches, options = {}) {
  if (process.platform !== "win32") {
    return installBatches;
  }
  const customLock = readFirstRuntimeOverride(
    OCR_REQUIREMENTS_LOCK_OVERRIDE_NAMES,
    options,
  );
  if (customLock) {
    const lockPath = path.resolve(customLock);
    if (!existsSync(lockPath)) {
      throw new Error(`OCR requirements lock을 찾지 못했습니다: ${lockPath}`);
    }
    return [buildHashedRequirementsBatch(lockPath, false)];
  }
  const activePackageOverrideNames = isHayaiOcrPipeline(options)
    ? HAYAI_OCR_PACKAGE_OVERRIDE_NAMES
    : LEGACY_OCR_PACKAGE_OVERRIDE_NAMES;
  const customPackageOverride = activePackageOverrideNames.find((name) =>
    Boolean(runtimeOverrideEnv(name, options)),
  );
  if (customPackageOverride) {
    throw new Error(
      `${customPackageOverride} override requires MGT_OCR_REQUIREMENTS_LOCK with a complete --require-hashes lock.`,
    );
  }

  return buildBuiltinIntegrityBatches(resolveOcrRuntimeVariant(options));
}

/** @param {string[]} names @param {RuntimeOptions} options @returns {string} */
function readFirstRuntimeOverride(names, options) {
  for (const name of names) {
    const value = String(runtimeOverrideEnv(name, options) ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** @param {string} variant @returns {string[][]} */
function buildBuiltinIntegrityBatches(variant) {
  const lockFile = resolveBuiltinOcrRequirementsLock(variant);
  const lockPath = path.join(__dirname, lockFile);
  validateBuiltinOcrRequirementsLock(lockPath, variant);
  return [
    buildHashedRequirementsBatch(
      lockPath,
      !isRocmRuntimeVariant(variant),
      isRocmRuntimeVariant(variant),
    ),
  ];
}

/** @param {string} variant @returns {boolean} */
function isRocmRuntimeVariant(variant) {
  return variant === "gpu-rocm-transformers" || variant === "hayai-rocm";
}

/** @param {string} lockPath @param {string} variant */
function validateBuiltinOcrRequirementsLock(lockPath, variant) {
  const contract = OCR_BUILTIN_LOCK_CONTRACTS[variant];
  if (!contract) {
    throw new Error(`OCR requirements lock contract is missing: ${variant}`);
  }
  let contents = "";
  try {
    contents = readFileSync(lockPath, "utf8");
  } catch (error) {
    throw new Error(`OCR requirements lock을 읽지 못했습니다: ${lockPath}`, {
      cause: error,
    });
  }
  const missing = contract.required.filter(
    (marker) => !contents.includes(marker),
  );
  const forbidden = contract.forbidden.filter((marker) =>
    contents.includes(marker),
  );
  if (missing.length === 0 && forbidden.length === 0) {
    return;
  }
  throw new Error(
    [
      `OCR requirements lock backend contract mismatch (${variant}).`,
      missing.length > 0 ? `missing=${missing.join(", ")}` : "",
      forbidden.length > 0 ? `forbidden=${forbidden.join(", ")}` : "",
      `lock=${lockPath}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/** @param {string} variant @returns {string} */
function resolveBuiltinOcrRequirementsLock(variant) {
  const locks = {
    cpu: "requirements-ocr-cpu-win-py312.lock",
    "hayai-cpu": "requirements-hayai-cpu-win.lock",
    "gpu-cu126": "requirements-ocr-gpu-cu126-win-py312.lock",
    "gpu-cu129": "requirements-ocr-gpu-cu129-win-py312.lock",
    "gpu-cuda-transformers-cu126": "requirements-ocr-cuda-tf-cu126-win.lock",
    "gpu-cuda-transformers-cu130": "requirements-ocr-cuda-tf-cu130-win.lock",
    "gpu-rocm-transformers": "requirements-ocr-rocm-win-py312.lock",
    "hayai-cuda-cu126": "requirements-hayai-cuda-cu126-win.lock",
    "hayai-cuda-cu130": "requirements-hayai-cuda-cu130-win.lock",
    "hayai-rocm": "requirements-hayai-rocm-win.lock",
  };
  const lockFile = /** @type {Record<string, string>} */ (locks)[variant];
  if (!lockFile) {
    throw new Error(
      `OCR runtime variant has no built-in integrity lock: ${variant}`,
    );
  }
  return lockFile;
}

/** @param {string} lockPath @param {boolean} onlyBinary @param {boolean} [noBuildIsolation] @returns {string[]} */
function buildHashedRequirementsBatch(
  lockPath,
  onlyBinary,
  noBuildIsolation = false,
) {
  return [
    "--require-hashes",
    ...(onlyBinary ? ["--only-binary=:all:"] : []),
    ...(noBuildIsolation ? ["--no-build-isolation"] : []),
    "--requirement",
    lockPath,
  ];
}

module.exports = {
  resolveIntegrityPinnedOcrInstallBatches,
  validateBuiltinOcrRequirementsLock,
};
