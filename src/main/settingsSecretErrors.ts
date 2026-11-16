import { SETTINGS_CREDENTIALS_UNAVAILABLE } from "../shared/settingsSecrets";

export class SettingsSecretDecryptionError extends Error {
  constructor(cause: unknown) {
    super(SETTINGS_CREDENTIALS_UNAVAILABLE, { cause });
    this.name = "SettingsSecretDecryptionError";
  }
}

export function isSettingsSecretDecryptionError(error: unknown): boolean {
  if (error instanceof SettingsSecretDecryptionError) return true;
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every(isSettingsSecretDecryptionError)
    );
  }
  return error instanceof Error && error.cause !== undefined
    ? isSettingsSecretDecryptionError(error.cause)
    : false;
}
