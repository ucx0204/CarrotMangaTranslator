const { resolve } = require("node:path");

const rootDir = resolve(__dirname, "..", "..");
const rocmVersion = "7.2.1";
const pythonVersion = "3.12.7";
const workerFile = "flux-klein-sdcpp-worker.py";
const manifestFile = "mgt-flux-rocm-runtime.json";
const outputFileName = `mgt-flux-rocm-win-x64-rocm${rocmVersion}-py${pythonVersion}-sdcpp.zip`;
const pythonUrl = `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`;
const getPipUrl = "https://bootstrap.pypa.io/get-pip.py";
const rocmBaseUrl = `https://repo.radeon.com/rocm/windows/rocm-rel-${rocmVersion}`;
const rocmPackageUrls = [
  `${rocmBaseUrl}/rocm_sdk_core-${rocmVersion}-py3-none-win_amd64.whl`,
  `${rocmBaseUrl}/rocm_sdk_devel-${rocmVersion}-py3-none-win_amd64.whl`,
  `${rocmBaseUrl}/rocm_sdk_libraries_custom-${rocmVersion}-py3-none-win_amd64.whl`,
  `${rocmBaseUrl}/rocm-${rocmVersion}.tar.gz`,
];
const buildPackages = [
  "scikit-build-core>=0.11.0",
  "cmake>=3.29.0",
  "ninja>=1.11.1",
  "packaging>=24.0",
  "setuptools>=69.0.0",
  "wheel>=0.43.0",
];
const fluxPackages = [
  "--no-build-isolation",
  "--no-cache-dir",
  "--force-reinstall",
  "stable-diffusion-cpp-python",
  "huggingface_hub>=0.36.0",
  "pillow>=10.0.0",
];
const windowsMsvcCompilerTarget = "x86_64-pc-windows-msvc";
const recommendedBuildFreeBytes = 80 * 1024 * 1024 * 1024;
const minimumBuildFreeBytes = 35 * 1024 * 1024 * 1024;
const minimumOutputFreeBytes = 8 * 1024 * 1024 * 1024;
// GitHub release assets must be under 2 GiB. Keep enough margin for service
// metadata and reassemble the exact ZIP in the app before verifying its hash.
const releasePartBytes = 1_900_000_000;
const defaultAmdGpuTargets = [
  "gfx908",
  "gfx90a",
  "gfx1030",
  "gfx1031",
  "gfx1032",
  "gfx1033",
  "gfx1034",
  "gfx1035",
  "gfx1036",
  "gfx1100",
  "gfx1101",
  "gfx1102",
  "gfx1103",
  "gfx1150",
  "gfx1151",
  "gfx1152",
  "gfx1153",
  "gfx1200",
  "gfx1201",
];

module.exports = {
  buildPackages,
  defaultAmdGpuTargets,
  fluxPackages,
  getPipUrl,
  manifestFile,
  minimumBuildFreeBytes,
  minimumOutputFreeBytes,
  outputFileName,
  pythonUrl,
  pythonVersion,
  recommendedBuildFreeBytes,
  releasePartBytes,
  rocmPackageUrls,
  rocmVersion,
  rootDir,
  windowsMsvcCompilerTarget,
  workerFile,
};
