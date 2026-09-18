import { randomUUID } from "node:crypto";
import { readFile, writeFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { letteringResourcesFixture } from "./mcpLetteringResources.fixture";

it("reads legacy public presets without migrating, decrypting or repairing settings", async () => {
  const f = await letteringResourcesFixture();
  try {
    await f.setPresets([
      f.preset("legacy", "Legacy", ["color"], { textColor: "#123456" }),
    ]);
    const files = await readdir(f.app.appPaths.dataRoot);
    const before = await readFile(f.app.appPaths.settingsPath);
    expect(
      (await f.resources.list({ resourceKind: "preset" }, () => {}))
        .resources[0].id,
    ).toBe("legacy");
    expect(await readFile(f.app.appPaths.settingsPath)).toEqual(before);
    expect(await readdir(f.app.appPaths.dataRoot)).toEqual(files);
  } finally {
    await f.close();
  }
});

it("uses the committed generation but leaves stale mirrors untouched and never opens the secret codec", async () => {
  const f = await letteringResourcesFixture();
  const { commitSettingsPairFiles, settingsCommitPath } =
    await import("../src/main/settingsPairStorage");
  try {
    const generation = randomUUID();
    const preset = f.preset("committed", "Committed", ["color"], {
      textColor: "#abcdef",
    });
    await commitSettingsPairFiles(f.app.appPaths, {
      generation,
      rawSettingsText: JSON.stringify({
        secretGeneration: generation,
        blockStylePresets: [preset],
      }),
      vaultText: "OPAQUE_FIXTURE_BYTES_NOT_DECRYPTED",
    });
    await writeFile(
      f.app.appPaths.settingsPath,
      "STALE_MIRROR_MUST_NOT_BE_REPAIRED",
    );
    const pointer = await readFile(settingsCommitPath(f.app.appPaths));
    const result = await f.resources.list({ resourceKind: "preset" }, () => {});
    expect(result.resources[0].id).toBe("committed");
    expect(JSON.stringify(result)).not.toMatch(
      /OPAQUE_|secretGeneration|STALE_/,
    );
    expect(await readFile(f.app.appPaths.settingsPath, "utf8")).toBe(
      "STALE_MIRROR_MUST_NOT_BE_REPAIRED",
    );
    expect(await readFile(settingsCommitPath(f.app.appPaths))).toEqual(pointer);
    const nextGeneration = randomUUID();
    await commitSettingsPairFiles(f.app.appPaths, {
      generation: nextGeneration,
      rawSettingsText: JSON.stringify({
        secretGeneration: nextGeneration,
        blockStylePresets: [{ ...preset, name: "New generation" }],
      }),
      vaultText: "OTHER_OPAQUE_BYTES",
    });
    expect(
      (await f.resources.list({ resourceKind: "preset" }, () => {}))
        .resources[0].name,
    ).toBe("New generation");
  } finally {
    await f.close();
  }
});

it("does not roll back a corrupt current generation to an old preset or repair its pointer", async () => {
  const f = await letteringResourcesFixture();
  const { commitSettingsPairFiles, settingsPairDirectory, settingsCommitPath } =
    await import("../src/main/settingsPairStorage");
  try {
    const preset = f.preset("current", "Current", ["color"], {
      textColor: "#123456",
    });
    for (let i = 0; i < 2; i++) {
      const generation = randomUUID();
      await commitSettingsPairFiles(f.app.appPaths, {
        generation,
        rawSettingsText: JSON.stringify({
          secretGeneration: generation,
          blockStylePresets: [preset],
        }),
        vaultText: "OPAQUE_BYTES",
      });
    }
    const pointerText = await readFile(
      settingsCommitPath(f.app.appPaths),
      "utf8",
    );
    const pointer = JSON.parse(pointerText);
    await writeFile(
      join(
        settingsPairDirectory(f.app.appPaths, pointer.generation),
        "settings.json",
      ),
      "CORRUPT_CURRENT",
    );
    await expect(
      f.resources.list({ resourceKind: "preset" }, () => {}),
    ).rejects.toThrow("hash verification");
    expect(await readFile(settingsCommitPath(f.app.appPaths), "utf8")).toBe(
      pointerText,
    );
  } finally {
    await f.close();
  }
});

it("rejects malformed legacy JSON and inconsistent generation metadata without backup writes", async () => {
  const f = await letteringResourcesFixture();
  const { commitSettingsPairFiles } =
    await import("../src/main/settingsPairStorage");
  try {
    await writeFile(f.app.appPaths.settingsPath, "[not valid JSON");
    const files = await readdir(f.app.appPaths.dataRoot);
    await expect(
      f.resources.list({ resourceKind: "preset" }, () => {}),
    ).rejects.toThrow();
    expect(await readdir(f.app.appPaths.dataRoot)).toEqual(files);
    const generation = randomUUID();
    await commitSettingsPairFiles(f.app.appPaths, {
      generation,
      rawSettingsText: JSON.stringify({
        secretGeneration: randomUUID(),
        blockStylePresets: [],
      }),
      vaultText: "OPAQUE",
    });
    await expect(
      f.resources.list({ resourceKind: "preset" }, () => {}),
    ).rejects.toThrow("generation is inconsistent");
    await expect(
      access(join(f.app.appPaths.dataRoot, "unexpected-backup")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});
