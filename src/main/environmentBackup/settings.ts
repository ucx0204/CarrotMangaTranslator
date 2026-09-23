import type { AppPaths } from "../appPaths";
import type {
  ApiProviderProfileSettings,
  AppSettings,
} from "../../shared/settingsTypes";
import { AppSettingsSchema } from "../../shared/ipcSettingsSchemas";
import {
  getAppSettings,
  getDefaultAppSettings,
  normalizeAppSettingsForRuntime,
} from "../settingsStore";
import {
  commitSettingsPair,
  separateSettingsSecrets,
} from "../settingsSecretStore";

function portableProfile(
  profile: ApiProviderProfileSettings,
): ApiProviderProfileSettings {
  const result = { ...profile };
  delete result.apiKey;
  delete result.apiKeyCount;
  delete result.vertexServiceAccountPath;
  // Custom payloads can contain provider-specific credentials, with no reliable key classifier.
  result.customHeadersJson = "{}";
  result.extraBodyJson = "{}";
  try {
    const url = new URL(result.baseUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    result.baseUrl = url.toString();
  } catch (error) {
    void error;
    result.baseUrl = "";
  }
  return result;
}

export function portableSettings(
  settings: AppSettings,
  defaults: AppSettings,
): AppSettings {
  const clean = separateSettingsSecrets(
    structuredClone(settings),
  ).persistentSettings;
  clean.api = {
    ...portableProfile(clean.api),
    provider: clean.api.provider,
    profiles: Object.fromEntries(
      Object.entries(clean.api.profiles ?? {}).map(([id, profile]) => [
        id,
        portableProfile(profile),
      ]),
    ),
  };
  delete clean.runtimeHardware;
  clean.hardware = defaults.hardware;
  clean.gemma = {
    ...clean.gemma,
    localModelPath: undefined,
    localMmprojPath: undefined,
    llamaRuntimeProfile: defaults.gemma.llamaRuntimeProfile,
    llamaRocmTarget: undefined,
    vramMode: defaults.gemma.vramMode,
    fitTargetMb: defaults.gemma.fitTargetMb,
    mmprojOffload: defaults.gemma.mmprojOffload,
    allowUnsafeUnifiedMemory: false,
  };
  clean.ocr = {
    ...clean.ocr,
    device: defaults.ocr.device,
    gpuBackend: defaults.ocr.gpuBackend,
    gpuCudaTag: defaults.ocr.gpuCudaTag,
  };
  clean.inpainting = {
    ...clean.inpainting,
    fluxBackend: defaults.inpainting?.fluxBackend,
    koharuBackend: defaults.inpainting?.koharuBackend,
    allowUnsafeLowMemoryFlux: false,
  };
  return clean;
}

export async function exportPortableSettings(
  paths: AppPaths,
): Promise<AppSettings> {
  return portableSettings(
    await getAppSettings(paths),
    await getDefaultAppSettings(),
  );
}

export async function importPortableSettings(
  value: unknown,
  paths: AppPaths,
): Promise<void> {
  const parsed = AppSettingsSchema.parse(value);
  const settings = await normalizeAppSettingsForRuntime(
    portableSettings(parsed, await getDefaultAppSettings({})),
    {},
  );
  delete settings.runtimeHardware;
  await commitSettingsPair(paths, { ...settings }, {});
}
