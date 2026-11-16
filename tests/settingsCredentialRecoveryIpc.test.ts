import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcContext } from "../src/main/ipc/context";
import type { AppSettings } from "../src/shared/settingsTypes";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { commitSettingsPair } from "../src/main/settingsSecretStore";
import { registerSettingsIpc } from "../src/main/ipc/settingsIpc";
import { SETTINGS_CREDENTIALS_UNAVAILABLE } from "../src/shared/settingsSecrets";

const host = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  decryptFails: false,
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "3.8.11-test" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (
      channel: string,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => host.handlers.set(channel, handler),
  },
  dialog: {},
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => {
      if (host.decryptFails) throw new Error("fixture key mismatch");
      return value.toString();
    },
  },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn((_file: string, ...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== "function")
      throw new Error("Missing probe callback");
    callback(null, "", "");
  }),
}));

const roots: string[] = [];
afterEach(async () => {
  host.decryptFails = false;
  host.handlers.clear();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("reports undecryptable settings and requires explicit confirmation through trusted IPC", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "settings-recovery-ipc-"));
  roots.push(dataRoot);
  const url = "http://127.0.0.1:5173/";
  const context = {
    appPaths: { dataRoot, settingsPath: join(dataRoot, "settings.json") },
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { id: 1, getURL: () => url },
    }),
  } as IpcContext;
  const event = { sender: { id: 1 }, senderFrame: { url } };
  await commitSettingsPair(context.appPaths, resolveDefaultAppSettings({}), {
    tavilyApiKey: "fixture-private-key",
  });
  host.decryptFails = true;
  registerSettingsIpc(context);
  const read = host.handlers.get("settings:get");
  const recover = host.handlers.get("settings:recover-credentials");
  if (!read || !recover) throw new Error("Missing recovery handlers");
  await expect(read(event)).rejects.toThrow(SETTINGS_CREDENTIALS_UNAVAILABLE);
  for (const args of [[], [false], ["true"]])
    await expect(recover(event, ...args)).rejects.toThrow();
  await expect(read(event)).rejects.toThrow(SETTINGS_CREDENTIALS_UNAVAILABLE);
  const recovered = (await recover(event, true)) as AppSettings;
  expect(recovered.internetResearch.tavilyApiKey).toBeFalsy();
  expect(JSON.stringify(recovered)).not.toContain("fixture-private-key");
  await expect(read(event)).resolves.toEqual(recovered);
});
