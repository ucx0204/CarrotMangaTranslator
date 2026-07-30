import { app } from "electron";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

const bootstrapDataRoot = resolveBootstrapDataRoot();
configurePackagedElectronStorage(bootstrapDataRoot);
configureDevelopmentElectronStorage(bootstrapDataRoot);
configureGraphicsGpu(bootstrapDataRoot);

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

  try {
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
  } catch (error) {
    writeBootstrapLog("bootstrap:packaged-storage-config-failed", error);
  }
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
  try {
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(sessionDataDir, { recursive: true });
    app.setPath("userData", userDataDir);
    app.setPath("sessionData", sessionDataDir);
    app.commandLine.appendSwitch(
      "disk-cache-dir",
      join(sessionDataDir, "Cache"),
    );
    app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  } catch (error) {
    writeBootstrapLog("bootstrap:dev-storage-config-failed", error);
  }
}

function configureGraphicsGpu(dataRoot: string | null): void {
  if (!dataRoot) {
    return;
  }

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

process.on("uncaughtException", logBootstrapUncaughtException);
process.on("unhandledRejection", logBootstrapUnhandledRejection);

writeBootstrapLog("bootstrap:start", {
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  dirname: __dirname,
});

try {
  require("./index");
  writeBootstrapLog("bootstrap:loaded-main");
} catch (error) {
  writeBootstrapLog("bootstrap:load-failed", error);
  throw error;
} finally {
  process.removeListener("uncaughtException", logBootstrapUncaughtException);
  process.removeListener("unhandledRejection", logBootstrapUnhandledRejection);
}
