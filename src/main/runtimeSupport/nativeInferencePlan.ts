import catalog from "../runtime/native-inference-manifest.json";

export type NativeInferenceEngine =
  "torch" | "diffusion" | "rocm-probe" | "qwen-image";
export type NativeInferenceBackend =
  "cpu" | "cuda" | "rocm" | "metal" | "vulkan";
type NativeInferencePackage = {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  format: "zip" | "tar";
  preservePaths: boolean;
  only?: string[];
};

const CUDA_PACKAGES = [
  "nvidia-cuda-runtime",
  "nvidia-nvjitlink",
  "nvidia-cuda-nvrtc",
  "nvidia-cublas",
  "nvidia-cufft",
  "nvidia-curand",
  "nvidia-cusparse",
  "nvidia-cusolver",
  "nvidia-cudnn-cu13",
];
const CUDA_LIBRARIES = [
  "cudart64_13.dll",
  "nvJitLink_130_0.dll",
  "nvrtc-builtins64_134.dll",
  "nvrtc64_130_0.dll",
  "cublasLt64_13.dll",
  "cublas64_13.dll",
  "cufft64_12.dll",
  "curand64_10.dll",
  "cusparse64_12.dll",
  "cusolver64_12.dll",
  "cudnn64_9.dll",
];
const ROCM_CORE_LIBRARIES = [
  "amd_comgr.dll",
  "rocm_kpack.dll",
  "rocm-openblas.dll",
  "amdhip64_7.dll",
  "hiprtc-builtins0715.dll",
  "hiprtc0715.dll",
].map((name) => `_rocm_sdk_core/bin/${name}`);
const ROCM_LIBRARIES = [
  "rocrand.dll",
  "hiprand.dll",
  "origami.dll",
  "libhipblaslt.dll",
  "rocblas.dll",
  "hipblas.dll",
  "rocfft.dll",
  "hipfft.dll",
  "rocsolver.dll",
  "hipsolver.dll",
  "rocsparse.dll",
  "hipsparse.dll",
  "MIOpen.dll",
].map((name) => `_rocm_sdk_libraries/bin/${name}`);

type PlanOptions = {
  engine: NativeInferenceEngine;
  backend: NativeInferenceBackend;
  platform: NodeJS.Platform;
  arch: string;
  rocmTarget?: string;
  qwenRocmProbe?: boolean;
};
type Plan = {
  version: string;
  packages: NativeInferencePackage[];
  libraries: string[];
  pathDirectories: string[];
  executable?: string;
};

function addPackage(plan: Plan, id: string, only?: string[]): void {
  const value = (
    catalog.packages as Record<string, Omit<NativeInferencePackage, "id">>
  )[id];
  if (!value) throw new Error(`지원하지 않는 네이티브 런타임 패키지: ${id}`);
  plan.packages.push({ ...value, id, only });
}

function assertEnginePlatform({
  engine,
  backend,
  platform,
  arch,
}: PlanOptions) {
  const target = `${platform}/${arch}/${backend}`;
  if (engine === "rocm-probe" && target !== "win32/x64/rocm") {
    throw new Error("ROCm probe requires Windows x64 and the ROCm backend");
  }
  if (
    engine === "qwen-image" &&
    ![
      "win32/x64/cuda",
      "win32/x64/vulkan",
      "win32/x64/rocm",
      "darwin/arm64/metal",
    ].includes(target)
  )
    throw new Error(
      "Qwen Image 2.1에는 Windows x64의 CUDA, ROCm, Vulkan 또는 Apple Silicon의 Metal이 필요합니다.",
    );
}

export function nativeInferencePlan(options: PlanOptions): Plan {
  assertEnginePlatform(options);
  const { engine, backend, platform, arch, rocmTarget } = options;
  const plan: Plan = {
    version: `${catalog.version}-${platform}-${arch}-${backend}-${engine}-${rocmTarget ?? "generic"}`,
    packages: [],
    libraries: [],
    pathDirectories: ["."],
  };
  if (
    platform === "darwin" &&
    arch === "arm64" &&
    (backend === "metal" || backend === "cpu")
  ) {
    if (engine === "qwen-image") {
      plan.executable = "sd-cli";
      plan.version = "qwen-image-2.1-sdcpp-532d2c1-darwin-arm64-metal";
      plan.libraries.push("libstable-diffusion.dylib");
      addPackage(plan, "qwen-image-sdcpp-darwin-metal", [
        plan.executable,
        ...plan.libraries,
      ]);
      return plan;
    }
    addPackage(plan, `${engine}-darwin-metal`);
    plan.libraries.push(
      ...(engine === "torch"
        ? [
            "libtorch.dylib",
            "libtorch_global_deps.dylib",
            "libtorch_cpu.dylib",
            "libc10.dylib",
            "libkoharu-torch.dylib",
          ]
        : ["libstable-diffusion.dylib"]),
    );
  } else if (platform === "win32" && arch === "x64" && backend !== "metal") {
    addWindowsRuntime(plan, options);
  } else {
    throw new Error(
      `지원하지 않는 네이티브 런타임: ${platform}/${arch}/${backend}`,
    );
  }
  return plan;
}

function addWindowsRuntime(plan: Plan, options: PlanOptions): void {
  const { engine, backend } = options;
  if (backend === "vulkan" && !["diffusion", "qwen-image"].includes(engine))
    throw new Error("Vulkan is supported only for diffusion");
  addPackage(plan, "msvc-win32");
  plan.libraries.push(
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "vcruntime140_threads.dll",
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll",
    "vcomp140.dll",
  );
  if (engine === "qwen-image") return addWindowsQwen(plan, options);
  if (engine === "rocm-probe") return addWindowsProbe(plan, options);
  if (engine === "torch") {
    addPackage(
      plan,
      "torch-win32-cpu",
      backend === "cpu" ? undefined : ["libiomp5md.dll"],
    );
    plan.libraries.push("libiomp5md.dll");
  }
  addWindowsAccelerator(plan, options);
  if (backend === "vulkan") {
    plan.executable = "mgt-flux-klein-vulkan.exe";
    plan.version += "-vulkan-r1";
  }
  if (!(engine === "torch" && backend === "cpu"))
    addPackage(
      plan,
      `${engine}-win32-${backend}`,
      backend === "vulkan"
        ? ["stable-diffusion.dll", "mgt-flux-klein-vulkan.exe"]
        : undefined,
    );
  if (engine === "diffusion") plan.libraries.push("stable-diffusion.dll");
  else addTorchLibraries(plan, backend);
}

function addWindowsProbe(plan: Plan, options: PlanOptions): void {
  if (options.qwenRocmProbe) {
    const files = ["amd_comgr.dll", "rocm_kpack.dll", "amdhip64_7.dll"];
    addPackage(plan, "qwen-image-sdcpp-win32-rocm", files);
    plan.libraries.push(...files);
    plan.version = "qwen-image-2.1-sdcpp-532d2c1-win32-x64-rocm-probe";
    return;
  }
  addPackage(plan, "rocm-core");
  plan.libraries.push(...ROCM_CORE_LIBRARIES);
  plan.pathDirectories.push("_rocm_sdk_core/bin");
  plan.version = `${catalog.version}-win32-x64-rocm-probe`;
}

function addWindowsQwen(plan: Plan, options: PlanOptions): void {
  const { backend } = options;
  const shared = [
    "ggml-base.dll",
    "ggml.dll",
    backend === "vulkan" ? "ggml-vulkan.dll" : "ggml-cuda.dll",
    "stable-diffusion.dll",
    "libsharpyuv.dll",
    "libwebp.dll",
    "libwebpmux.dll",
    "webm.dll",
    ...[
      "x64",
      "sse42",
      "sandybridge",
      "haswell",
      "skylakex",
      "cannonlake",
      "cascadelake",
      "icelake",
      "alderlake",
    ].map((cpu) => `ggml-cpu-${cpu}.dll`),
  ];
  const cuda = ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"];
  plan.executable = "sd-cli.exe";
  const libraries =
    backend === "rocm"
      ? [
          "stable-diffusion.dll",
          "amdhip64_7.dll",
          "amd_comgr.dll",
          "rocm_kpack.dll",
        ]
      : shared;
  plan.version = `qwen-image-2.1-sdcpp-532d2c1-win32-x64-${backend === "cuda" ? "cuda12" : backend}`;
  addPackage(plan, `qwen-image-sdcpp-win32-${backend}`, [
    ...libraries,
    plan.executable,
  ]);
  plan.libraries.push(...libraries);
  if (backend === "rocm") {
    const target = options.rocmTarget;
    if (
      !target ||
      !Object.hasOwn(catalog.packages, "qwen-rocm-device-" + target)
    )
      throw new Error(
        "선택한 GPU의 Qwen ROCm 커널이 없습니다. Vulkan을 선택하세요.",
      );
    for (const id of [
      "qwen-rocm-core",
      "qwen-rocm-libraries",
      "qwen-rocm-device-" + target,
    ])
      addPackage(plan, id);
    plan.pathDirectories.push("_rocm_sdk_core/bin", "_rocm_sdk_libraries/bin");
    plan.libraries.push(
      ...["rocblas.dll", "hipblas.dll", "libhipblaslt.dll"].map(
        (name) => "_rocm_sdk_libraries/bin/" + name,
      ),
    );
    plan.version += "-" + target;
  }
  if (backend === "cuda") {
    addPackage(plan, "qwen-image-cuda12-runtime", cuda);
    plan.libraries.push(...cuda);
  }
}

function addWindowsAccelerator(
  plan: Plan,
  { backend, rocmTarget }: PlanOptions,
): void {
  if (backend === "cuda") {
    for (const id of CUDA_PACKAGES) addPackage(plan, id);
    plan.libraries.push(...CUDA_LIBRARIES);
  } else if (backend === "rocm") {
    if (!rocmTarget || !/^gfx[0-9a-f]+$/.test(rocmTarget))
      throw new Error(
        "ROCm 런타임에는 선택한 GPU의 정확한 gfx 대상이 필요합니다.",
      );
    for (const id of [
      "rocm-core",
      "rocm-libraries",
      `rocm-device-${rocmTarget}`,
    ])
      addPackage(plan, id);
    plan.libraries.push(...ROCM_CORE_LIBRARIES, ...ROCM_LIBRARIES);
    plan.pathDirectories.push("_rocm_sdk_core/bin", "_rocm_sdk_libraries/bin");
  }
}

function addTorchLibraries(plan: Plan, backend: NativeInferenceBackend): void {
  plan.libraries.push("c10.dll");
  if (backend !== "cpu")
    plan.libraries.push(
      backend === "cuda" ? "c10_cuda.dll" : "c10_hip.dll",
      "caffe2_nvrtc.dll",
    );
  plan.libraries.push("torch_global_deps.dll", "torch_cpu.dll");
  if (backend !== "cpu")
    plan.libraries.push(
      backend === "cuda" ? "torch_cuda.dll" : "torch_hip.dll",
    );
  plan.libraries.push("torch.dll", "koharu-torch.dll");
}
