import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256FileSync } from "../../runtimeSupport/fileProbe";
import {
  resolveFluxRocmPrebuiltRuntimeSha256,
  resolveFluxRocmPrebuiltRuntimeUrl,
} from "./manifests";
import type { FluxPythonBackend } from "./types";

const FLUX_CPU_LOCK = "requirements-flux-cpu-win-py312.lock";
const OCR_BUILD_TOOLS_LOCK = "ocr/requirements-build-tools.lock";

export function resolveFluxPythonIntegrityId(
  backend: FluxPythonBackend,
): string {
  if (process.platform !== "win32") {
    return "system-python-runtime-v1";
  }
  if (backend === "python-rocm") {
    return `prebuilt-sha256:${resolveFluxRocmPrebuiltRuntimeSha256(
      resolveFluxRocmPrebuiltRuntimeUrl(),
    )}`;
  }
  return `lock-sha256:${sha256FileSync(resolveFluxCpuRequirementsLockPath())}`;
}

export function resolveFluxCpuRequirementsLockPath(): string {
  return resolveRuntimeAsset(`python-locks/${FLUX_CPU_LOCK}`);
}

export function resolvePythonBuildToolsLockPath(): string {
  return resolveRuntimeAsset(OCR_BUILD_TOOLS_LOCK);
}

function resolveRuntimeAsset(relativePath: string): string {
  const normalizedParts = relativePath.split("/");
  const candidates = [
    process.resourcesPath
      ? join(process.resourcesPath, "app-runtime", ...normalizedParts)
      : "",
    join(process.cwd(), "out", "app-runtime", ...normalizedParts),
    join(__dirname, "../../runtime", ...normalizedParts),
  ].filter(Boolean);
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(
      `Flux Python integrity lock is missing: ${relativePath}. Checked ${candidates.join(
        ", ",
      )}`,
    );
  }
  return match;
}
