import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { commitSettingsPair } from "../src/main/settingsSecretStore";
import { getAppSettings, saveAppSettings } from "../src/main/settingsStore";
import { recoverSettingsCredentials } from "../src/main/settingsCredentialRecovery";
import { isSettingsSecretDecryptionError } from "../src/main/settingsSecretErrors";

const cryptoState = vi.hoisted(() => ({ fail: false, available: true }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => cryptoState.available,
    encryptString: (value: string) => Buffer.from(`fixture:${value}`),
    decryptString: (value: Buffer) => {
      if (cryptoState.fail) throw new Error("fixture profile key mismatch");
      return value.toString().replace(/^fixture:/, "");
    },
  },
}));

const roots: string[] = [];
afterEach(async () => {
  cryptoState.fail = false;
  cryptoState.available = true;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "carrot-credential-recovery-"));
  roots.push(root);
  const paths = { settingsPath: join(root, "settings.json") } as AppPaths;
  const defaults = resolveDefaultAppSettings({});
  const settings = {
    ...defaults,
    ui: { ...defaults.ui, locale: "ja" as const },
  };
  await commitSettingsPair(paths, settings, {
    tavilyApiKey: "fixture-previous",
  });
  await commitSettingsPair(paths, settings, {
    tavilyApiKey: "fixture-current",
  });
  const pointerText = await readFile(
    join(root, "settings.commit.json"),
    "utf8",
  );
  const pointer = JSON.parse(pointerText) as {
    generation: string;
    previous: { generation: string };
  };
  const generations = [pointer.generation, pointer.previous.generation];
  const original = new Map<string, string>();
  for (const generation of generations) {
    for (const name of ["settings.json", "settings.secrets.json"]) {
      const relative = join(".settings-pairs", generation, name);
      original.set(relative, await readFile(join(root, relative), "utf8"));
    }
  }
  return { root, paths, pointer, pointerText, original };
}

describe("explicit settings credential recovery", () => {
  it("backs up both generations and preserves non-secret settings without silently resetting on read", async () => {
    const data = await fixture();
    const before = await getAppSettings(data.paths, {}, async () => null);
    cryptoState.fail = true;
    await expect(
      getAppSettings(data.paths, {}, async () => null),
    ).rejects.toSatisfy(isSettingsSecretDecryptionError);
    expect(
      await readFile(join(data.root, "settings.commit.json"), "utf8"),
    ).toBe(data.pointerText);
    const [recovered, replay] = await Promise.all([
      recoverSettingsCredentials(data.paths, {}, async () => null),
      recoverSettingsCredentials(data.paths, {}, async () => null),
    ]);
    expect(recovered.ui).toEqual(before.ui);
    expect(recovered.translation).toEqual(before.translation);
    expect(recovered.blockFormatDefaults).toEqual(before.blockFormatDefaults);
    expect(recovered.internetResearch.tavilyApiKey).toBeFalsy();
    expect(replay).toEqual(recovered);
    const backups = await readdir(
      join(data.root, ".settings-credential-backups"),
    );
    expect(backups).toHaveLength(1);
    const backup = join(data.root, ".settings-credential-backups", backups[0]);
    expect(await readFile(join(backup, "settings.commit.json"), "utf8")).toBe(
      data.pointerText,
    );
    await saveAppSettings(recovered, data.paths, {}, async () => null);
    for (const [relative, contents] of data.original) {
      expect(await readFile(join(backup, relative), "utf8")).toBe(contents);
    }
  });

  it("does not reset readable credentials or create a backup", async () => {
    const data = await fixture();
    const recovered = await recoverSettingsCredentials(
      data.paths,
      {},
      async () => null,
    );
    expect(recovered.internetResearch.tavilyApiKey).toBe("fixture-current");
    expect(
      await readFile(join(data.root, "settings.commit.json"), "utf8"),
    ).toBe(data.pointerText);
    expect(await readdir(data.root)).not.toContain(
      ".settings-credential-backups",
    );
  });

  it("keeps the authoritative pair untouched when backup cannot be written", async () => {
    const data = await fixture();
    await writeFile(join(data.root, ".settings-credential-backups"), "blocked");
    cryptoState.fail = true;
    await expect(
      recoverSettingsCredentials(data.paths, {}, async () => null),
    ).rejects.toThrow();
    expect(
      await readFile(join(data.root, "settings.commit.json"), "utf8"),
    ).toBe(data.pointerText);
    for (const [relative, contents] of data.original)
      expect(await readFile(join(data.root, relative), "utf8")).toBe(contents);
  });

  it("refuses recovery when integrity checks fail", async () => {
    const data = await fixture();
    await writeFile(
      join(
        data.root,
        ".settings-pairs",
        data.pointer.generation,
        "settings.json",
      ),
      "{}",
    );
    cryptoState.fail = true;
    await expect(
      recoverSettingsCredentials(data.paths, {}, async () => null),
    ).rejects.toThrow();
    expect(
      await readFile(join(data.root, "settings.commit.json"), "utf8"),
    ).toBe(data.pointerText);
    expect(await readdir(data.root)).not.toContain(
      ".settings-credential-backups",
    );
  });

  it("does not discard credentials just because OS encryption is temporarily unavailable", async () => {
    const data = await fixture();
    cryptoState.available = false;
    await expect(
      recoverSettingsCredentials(data.paths, {}, async () => null),
    ).rejects.toThrow();
    expect(
      await readFile(join(data.root, "settings.commit.json"), "utf8"),
    ).toBe(data.pointerText);
  });
});
