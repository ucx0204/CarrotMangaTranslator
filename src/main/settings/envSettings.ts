export type NumberEnvOptions = {
  min?: number;
  max?: number;
  integer?: boolean;
};

export function readNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: NumberEnvOptions = {},
): number {
  const value = Number(env[name]);
  return normalizeEnvNumber(value, fallback, options);
}

export function readOptionalNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  options: NumberEnvOptions = {},
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value)
    ? normalizeEnvNumber(value, value, options)
    : undefined;
}

export function readOptionalBooleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return readBooleanLikeEnv(raw);
}

export function readBooleanLikeEnv(raw: unknown): boolean | undefined {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeEnvNumber(
  value: number,
  fallback: number,
  options: NumberEnvOptions,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = options.integer ? Math.round(value) : value;
  return clampNumber(
    normalized,
    options.min ?? -Number.MAX_SAFE_INTEGER,
    options.max ?? Number.MAX_SAFE_INTEGER,
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
