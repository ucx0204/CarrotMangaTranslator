import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import {
  commitSettingsPairFiles,
  loadCommittedSettingsPairFiles,
  settingsCommitPath,
  settingsPairDirectory,
  type SettingsPairFiles,
} from "../src/main/settingsPairStorage";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("settings pair recovery and commit serialization", () => {
  it("keeps a newer commit authoritative after a paused fallback recovery", async () => {
    const paths = await makePaths();
    const previous = pair("B");
    const corrupted = pair("A");
    const newest = pair("C");
    await commitSettingsPairFiles(paths, previous);
    await commitSettingsPairFiles(paths, corrupted);
    await rm(
      join(settingsPairDirectory(paths, corrupted.generation), "settings.json"),
    );
    const validationStarted = deferred();
    const resumeValidation = deferred();
    const recovery = loadCommittedSettingsPairFiles(paths, async (files) => {
      expect([previous.generation, newest.generation]).toContain(
        files.generation,
      );
      validationStarted.resolve();
      await resumeValidation.promise;
      return files;
    });
    await validationStarted.promise;

    vi.mocked(mkdir).mockClear();
    const commit = commitSettingsPairFiles(paths, newest);
    // A commit's first filesystem call is synchronous when its queued task starts.
    // Two microtask turns expose an unguarded commit without relying on disk speed.
    await Promise.resolve();
    await Promise.resolve();
    const wroteWhileRecoveryPaused = vi.mocked(mkdir).mock.calls.length > 0;
    try {
      if (wroteWhileRecoveryPaused) await commit;
    } finally {
      resumeValidation.resolve();
    }
    const [recovered, committed] = await Promise.all([recovery, commit]);

    expect([previous.generation, newest.generation]).toContain(
      recovered?.generation,
    );
    expect(committed).toBe(newest.generation);
    const pointer = JSON.parse(
      await readFile(settingsCommitPath(paths), "utf8"),
    ) as {
      generation: string;
      previous?: { generation: string };
    };
    expect(pointer.generation).toBe(newest.generation);
    expect([previous.generation, corrupted.generation]).toContain(
      pointer.previous?.generation,
    );
    await expect(readFile(paths.settingsPath, "utf8")).resolves.toBe(
      newest.rawSettingsText,
    );
    await expect(
      readFile(
        join(dirname(paths.settingsPath), "settings.secrets.json"),
        "utf8",
      ),
    ).resolves.toBe(newest.vaultText);
    await expect(
      loadCommittedSettingsPairFiles(paths, (files) => files),
    ).resolves.toEqual(newest);
    expect(
      (
        await readdir(dirname(settingsPairDirectory(paths, newest.generation)))
      ).sort(),
    ).toEqual([newest.generation, pointer.previous?.generation].sort());
  });

  it("does not leave later commits blocked after both generations fail validation", async () => {
    const paths = await makePaths();
    await commitSettingsPairFiles(paths, pair("B"));
    await commitSettingsPairFiles(paths, pair("A"));
    const rejected = loadCommittedSettingsPairFiles(paths, () => {
      throw new Error("fixture validation rejected");
    });
    await expect(rejected).rejects.toThrow(
      "Current and previous settings pairs are both invalid",
    );
    const newest = pair("C");
    await expect(commitSettingsPairFiles(paths, newest)).resolves.toBe(
      newest.generation,
    );
    await expect(
      loadCommittedSettingsPairFiles(paths, (files) => files),
    ).resolves.toEqual(newest);
  });
});

function pair(label: string): SettingsPairFiles {
  return {
    generation: randomUUID(),
    rawSettingsText: JSON.stringify({ label }),
    vaultText: JSON.stringify({ fixtureSecret: `secret-${label}` }),
  };
}

async function makePaths(): Promise<AppPaths> {
  const directory = await mkdtemp(join(tmpdir(), "manga-settings-race-test-"));
  temporaryDirectories.push(directory);
  // This pair-storage port consumes only settingsPath; no app path resolver runs.
  return { settingsPath: join(directory, "settings.json") } as AppPaths;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
