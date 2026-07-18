import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolvePackagedDataRoot } from "./dataRoot";

configurePackagedElectronStorage();
configureDevelopmentElectronStorage();

function bootstrapLogPath(): string {
  if (app.isPackaged || __dirname.includes("app.asar")) {
    return join(resolveBootstrapUserDataDir(), "logs", "bootstrap.log");
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

function configurePackagedElectronStorage(): void {
  if (!isPackagedBootstrap()) {
    return;
  }

  try {
    const dataRoot = resolvePackagedDataRoot(dirname(process.execPath), {
      platform: process.platform,
      appDataDir: app.getPath("appData"),
    });
    const userDataDir = join(dataRoot, "electron-user-data");
    const sessionDataDir = join(dataRoot, "electron-session");
    const tempDir = join(dataRoot, "tmp", "system-temp");
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(sessionDataDir, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    app.setPath("userData", userDataDir);
    app.setPath("sessionData", sessionDataDir);
    app.commandLine.appendSwitch(
      "disk-cache-dir",
      join(sessionDataDir, "Cache"),
    );
    app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
    process.env.TEMP = tempDir;
    process.env.TMP = tempDir;
  } catch (error) {
    writeBootstrapLog("bootstrap:packaged-storage-config-failed", error);
  }
}

function writeBootstrapLog(message: string, detail?: unknown): void {
  try {
    const logPath = bootstrapLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}${detail === undefined ? "" : ` ${serialize(detail)}`}\n`;
    appendFileSync(logPath, line, "utf8");
  } catch (_error) {
    // error-policy-allow: bootstrap logging must not prevent the app from reporting startup errors.
  }
}

function serialize(detail: unknown): string {
  if (detail instanceof Error) {
    return JSON.stringify({
      name: detail.name,
      message: detail.message,
      stack: detail.stack,
    });
  }

  if (typeof detail === "string") {
    return detail;
  }

  try {
    return JSON.stringify(detail);
  } catch (_error) {
    return String(detail);
  }
}

function configureDevelopmentElectronStorage(): void {
  if (isPackagedBootstrap()) {
    return;
  }

  const repoRoot = resolve(__dirname, "../..");
  const userDataDir =
    process.env.MANGA_TRANSLATOR_DEV_USER_DATA?.trim() ||
    join(repoRoot, ".tmp", "electron-dev", "user-data");
  const sessionDataDir =
    process.env.MANGA_TRANSLATOR_DEV_SESSION_DATA?.trim() ||
    join(repoRoot, ".tmp", "electron-dev", "session-data");
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

function isPackagedBootstrap(): boolean {
  return app.isPackaged || __dirname.includes("app.asar");
}

process.on("uncaughtException", (error) => {
  writeBootstrapLog("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  writeBootstrapLog("unhandledRejection", reason);
});

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
}
