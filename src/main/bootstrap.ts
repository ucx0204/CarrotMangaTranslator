import { app, dialog } from "electron";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  establishBootstrapInstanceGuard,
  type BootstrapInstanceGuardRuntime,
} from "./bootstrapInstanceGuard";
import {
  acquireDataRootInstanceLock,
  canonicalizeDataRoot,
  createProductionDataRootInstanceLockRuntime,
} from "./dataRootInstanceLock";
import {
  installDataRootInstanceLockLease,
  releaseDataRootInstanceLockLease,
} from "./dataRootInstanceLockState";
import { createBootstrapLogger } from "./bootstrapLogger";
import { resolvePackagedDataRoot } from "./dataRoot";
import {
  resolvePackagedBootstrapLogPath,
  resolvePackagedElectronStoragePaths,
} from "./electronStoragePaths";
import {
  readBootstrapGraphicsGpuPreference,
  resolveBootstrapSettingsPath,
  resolveGraphicsGpuSwitch,
} from "./bootstrapGraphicsGpu";

const bootstrapLogger = createBootstrapLogger({
  resolveLogPath: bootstrapLogPath,
});

bootstrap();

function bootstrap(): void {
  const dataRoot = resolveBootstrapDataRoot();
  try {
    configurePackagedElectronStorage(dataRoot);
    configureDevelopmentElectronStorage(dataRoot);
  } catch (error) {
    writeBootstrapLog("bootstrap:storage-config-failed", error);
    reportEarlyStartupFailure(
      "Carrot Manga Translator 저장 경로 오류",
      `Electron 저장 경로를 설정하지 못해 시작을 중단했습니다.\n\n${formatError(error)}`,
    );
    app.exit(2);
    return;
  }

  const guard = establishBootstrapInstanceGuard(
    dataRoot,
    productionBootstrapInstanceGuardRuntime(),
  );
  if (guard.status !== "primary") {
    return;
  }

  configureGraphicsGpu(guard.dataRoot);
  installBootstrapErrorListeners();
  writeBootstrapLog("bootstrap:start", {
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    dirname: __dirname,
    dataRoot: guard.dataRoot,
  });

  try {
    require("./index");
    writeBootstrapLog("bootstrap:loaded-main");
  } catch (error) {
    writeBootstrapLog("bootstrap:load-failed", error);
    releaseAfterMainImportFailure();
    throw error;
  } finally {
    removeBootstrapErrorListeners();
  }
}

function productionBootstrapInstanceGuardRuntime(): BootstrapInstanceGuardRuntime {
  return {
    canonicalizeDataRoot,
    requestSingleInstanceLock: (additionalData) =>
      app.requestSingleInstanceLock(additionalData),
    releaseSingleInstanceLock: () => app.releaseSingleInstanceLock(),
    quitSecondaryInstance: () => app.quit(),
    exitStartupFailure: (code) => app.exit(code),
    reportStartupFailure: reportEarlyStartupFailure,
    acquireDataRootLock: (dataRoot) =>
      acquireDataRootInstanceLock(
        dataRoot,
        createProductionDataRootInstanceLockRuntime(app.getVersion()),
      ),
    installDataRootLockLease: installDataRootInstanceLockLease,
  };
}

function releaseAfterMainImportFailure(): void {
  try {
    releaseDataRootInstanceLockLease();
  } catch (error) {
    writeBootstrapLog("bootstrap:data-root-lock-release-failed", error);
    console.error(
      "Failed to release data-root lock after main import failure",
      error,
    );
  }
  try {
    app.releaseSingleInstanceLock();
  } catch (error) {
    writeBootstrapLog("bootstrap:electron-lock-release-failed", error);
    console.error(
      "Failed to release Electron single-instance lock after main import failure",
      error,
    );
  }
}

function reportEarlyStartupFailure(title: string, detail: string): void {
  console.error(`${title}\n${detail}`);
  try {
    dialog.showErrorBox(title, detail);
  } catch (error) {
    console.error("Failed to show the early startup error dialog", error);
  }
}

function bootstrapLogPath(): string {
  if (app.isPackaged || __dirname.includes("app.asar")) {
    return resolvePackagedBootstrapLogPath(resolveBootstrapUserDataDir());
  }
  return join(resolve(__dirname, "../.."), "logs", "bootstrap.log");
}

function resolveBootstrapUserDataDir(): string {
  try {
    return app.getPath("userData");
  } catch (_error) {
    const dataRoot =
      process.env.LOCALAPPDATA?.trim() ||
      process.env.APPDATA?.trim() ||
      tmpdir();
    return join(dataRoot, "manga-gemma-translator");
  }
}

function resolveBootstrapDataRoot(): string | null {
  try {
    return isPackagedBootstrap()
      ? resolvePackagedDataRoot(dirname(process.execPath), {
          platform: process.platform,
          appDataDir: app.getPath("appData"),
        })
      : resolve(__dirname, "../..");
  } catch (error) {
    writeBootstrapLog("bootstrap:data-root-resolution-failed", error);
    return null;
  }
}

function configurePackagedElectronStorage(dataRoot: string | null): void {
  if (!isPackagedBootstrap() || !dataRoot) {
    return;
  }

  const { userDataDir, sessionDataDir, tempDir, diskCacheDir } =
    resolvePackagedElectronStoragePaths(dataRoot);
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(sessionDataDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  app.setPath("userData", userDataDir);
  app.setPath("sessionData", sessionDataDir);
  app.commandLine.appendSwitch("disk-cache-dir", diskCacheDir);
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;
}

function writeBootstrapLog(message: string, detail?: unknown): void {
  bootstrapLogger.write(message, detail);
}

function configureDevelopmentElectronStorage(dataRoot: string | null): void {
  if (isPackagedBootstrap() || !dataRoot) {
    return;
  }

  const userDataDir =
    process.env.MANGA_TRANSLATOR_DEV_USER_DATA?.trim() ||
    join(dataRoot, ".tmp", "electron-dev", "user-data");
  const sessionDataDir =
    process.env.MANGA_TRANSLATOR_DEV_SESSION_DATA?.trim() ||
    join(dataRoot, ".tmp", "electron-dev", "session-data");
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(sessionDataDir, { recursive: true });
  app.setPath("userData", userDataDir);
  app.setPath("sessionData", sessionDataDir);
  app.commandLine.appendSwitch("disk-cache-dir", join(sessionDataDir, "Cache"));
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
}

function configureGraphicsGpu(dataRoot: string): void {
  try {
    const settingsPath = resolveBootstrapSettingsPath(dataRoot);
    const preference = readBootstrapGraphicsGpuPreference(settingsPath);
    const gpuSwitch = resolveGraphicsGpuSwitch(preference);
    if (!gpuSwitch) {
      return;
    }
    app.commandLine.appendSwitch(gpuSwitch);
    writeBootstrapLog("bootstrap:graphics-gpu-preference-applied", {
      preference,
      platform: process.platform,
    });
  } catch (error) {
    writeBootstrapLog("bootstrap:graphics-gpu-preference-failed", error);
  }
}

function isPackagedBootstrap(): boolean {
  return app.isPackaged || __dirname.includes("app.asar");
}

const logBootstrapUncaughtException = (error: Error): void => {
  writeBootstrapLog("uncaughtException", error);
};

const logBootstrapUnhandledRejection = (reason: unknown): void => {
  writeBootstrapLog("unhandledRejection", reason);
};

function installBootstrapErrorListeners(): void {
  process.on("uncaughtException", logBootstrapUncaughtException);
  process.on("unhandledRejection", logBootstrapUnhandledRejection);
}

function removeBootstrapErrorListeners(): void {
  process.removeListener("uncaughtException", logBootstrapUncaughtException);
  process.removeListener("unhandledRejection", logBootstrapUnhandledRejection);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
