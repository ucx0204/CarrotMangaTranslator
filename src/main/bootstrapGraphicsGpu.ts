import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeGraphicsGpuPreference,
  type GraphicsGpuPreference,
} from "../shared/gpuSettings";

export const FORCE_HIGH_PERFORMANCE_GPU_SWITCH = "force_high_performance_gpu";

export function resolveBootstrapSettingsPath(dataRoot: string): string {
  return join(dataRoot, "settings.json");
}

export function parseBootstrapGraphicsGpuPreference(
  rawText: string,
  fallback: GraphicsGpuPreference = "auto",
): GraphicsGpuPreference {
  try {
    const settings: unknown = JSON.parse(rawText);
    return resolveBootstrapGraphicsGpuPreference(settings, fallback);
  } catch (_error) {
    return fallback;
  }
}

export function resolveBootstrapGraphicsGpuPreference(
  settings: unknown,
  fallback: GraphicsGpuPreference = "auto",
): GraphicsGpuPreference {
  const record = asRecord(settings);
  const hardware = asRecord(record?.hardware);
  return normalizeGraphicsGpuPreference(
    hardware?.graphicsGpuPreference,
    fallback,
  );
}

export function readBootstrapGraphicsGpuPreference(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): GraphicsGpuPreference {
  const fallback = resolveBootstrapGraphicsGpuPreferenceFromEnv(env);
  try {
    return parseBootstrapGraphicsGpuPreference(
      readFileSync(settingsPath, "utf8"),
      fallback,
    );
  } catch (_error) {
    return fallback;
  }
}

export function resolveBootstrapGraphicsGpuPreferenceFromEnv(
  env: NodeJS.ProcessEnv,
): GraphicsGpuPreference {
  return normalizeGraphicsGpuPreference(
    env.MANGA_TRANSLATOR_GRAPHICS_GPU_PREFERENCE ??
      env.MGT_GRAPHICS_GPU_PREFERENCE,
  );
}

export function resolveGraphicsGpuSwitch(
  preference: GraphicsGpuPreference,
  platform: NodeJS.Platform = process.platform,
): typeof FORCE_HIGH_PERFORMANCE_GPU_SWITCH | null {
  return preference === "high-performance" && platform !== "darwin"
    ? FORCE_HIGH_PERFORMANCE_GPU_SWITCH
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
