const SETTINGS_GENERATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function isSettingsGeneration(value: string): boolean {
  return SETTINGS_GENERATION_PATTERN.test(value);
}

export function assertSettingsGeneration(generation: string): void {
  if (!isSettingsGeneration(generation)) {
    throw new Error("Settings generation identifier is invalid.");
  }
}

export function parseSettingsJsonRecord(
  rawText: string,
  label: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(rawText) as unknown;
  } catch (error) {
    throw new SyntaxError(`${label} is not valid JSON.`, { cause: error });
  }
  if (!isSettingsJsonRecord(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

export function serializeSettingsJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function isSettingsJsonRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
