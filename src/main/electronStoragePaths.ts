import { join } from "node:path";

export type PackagedElectronStoragePaths = {
  userDataDir: string;
  sessionDataDir: string;
  tempDir: string;
  diskCacheDir: string;
};

export function resolvePackagedElectronStoragePaths(
  dataRoot: string,
): PackagedElectronStoragePaths {
  const userDataDir = join(dataRoot, "electron-user-data");
  const sessionDataDir = join(dataRoot, "electron-session");
  const tempDir = join(dataRoot, "tmp", "system-temp");
  return {
    userDataDir,
    sessionDataDir,
    tempDir,
    diskCacheDir: join(sessionDataDir, "Cache"),
  };
}

export function resolvePackagedBootstrapLogPath(userDataDir: string): string {
  return join(userDataDir, "logs", "bootstrap.log");
}
