import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type DevSessionMaintenanceModule = {
  pruneLegacyDevSessions: (storageRoot: string) => {
    removedDirectories: number;
  };
  resetDevSessionData: (storageRoot: string) => void;
};

const maintenance =
  require("../scripts/dev-session-maintenance.cjs") as DevSessionMaintenanceModule;
const temporaryRoots: string[] = [];
const temporaryPrefix = join(tmpdir(), "manga-dev-session-test-");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(temporaryPrefix)) {
      throw new Error(`Refusing to clean unexpected test path: ${root}`);
    }
    rmSync(root, { force: true, recursive: true });
  }
});

function createFixture() {
  const fixtureRoot = mkdtempSync(temporaryPrefix);
  temporaryRoots.push(fixtureRoot);
  const storageRoot = join(fixtureRoot, "electron-dev");
  mkdirSync(storageRoot);
  return { fixtureRoot, storageRoot };
}

function createDirectoryMarker(parent: string, name: string) {
  const directory = join(parent, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "marker.txt"), name, "utf8");
  return directory;
}

describe("development session maintenance", () => {
  it("prunes only exact legacy session directories", () => {
    const { storageRoot } = createFixture();
    const legacyDirectories = [
      createDirectoryMarker(storageRoot, "session-1-2"),
      createDirectoryMarker(storageRoot, "session-999-1234567890"),
    ];
    const preservedDirectories = [
      "user-data",
      "session-data",
      "settings",
      "library",
      "session-1",
      "session-a-2",
      "session-1-2-backup",
      "session-1-2.txt",
    ].map((name) => createDirectoryMarker(storageRoot, name));
    const matchingFile = join(storageRoot, "session-3-4");
    writeFileSync(matchingFile, "not a directory", "utf8");

    expect(maintenance.pruneLegacyDevSessions(storageRoot)).toEqual({
      removedDirectories: 2,
    });

    for (const directory of legacyDirectories) {
      expect(existsSync(directory)).toBe(false);
    }
    for (const directory of preservedDirectories) {
      expect(existsSync(join(directory, "marker.txt"))).toBe(true);
    }
    expect(existsSync(matchingFile)).toBe(true);
    expect(maintenance.pruneLegacyDevSessions(storageRoot)).toEqual({
      removedDirectories: 0,
    });
  });

  it("resets only the derived session-data child", () => {
    const { storageRoot } = createFixture();
    const sessionData = createDirectoryMarker(storageRoot, "session-data");
    const userData = createDirectoryMarker(storageRoot, "user-data");
    const sessionBackup = createDirectoryMarker(
      storageRoot,
      "session-data-backup",
    );

    maintenance.resetDevSessionData(storageRoot);

    expect(existsSync(sessionData)).toBe(false);
    expect(existsSync(join(userData, "marker.txt"))).toBe(true);
    expect(existsSync(join(sessionBackup, "marker.txt"))).toBe(true);
  });

  it("does not follow links or junctions out of disposable sessions", () => {
    const { fixtureRoot, storageRoot } = createFixture();
    const externalTarget = createDirectoryMarker(
      fixtureRoot,
      "external-target",
    );
    const legacyDirectory = createDirectoryMarker(storageRoot, "session-7-8");
    symlinkSync(
      externalTarget,
      join(legacyDirectory, "external-link"),
      "junction",
    );

    expect(maintenance.pruneLegacyDevSessions(storageRoot)).toEqual({
      removedDirectories: 1,
    });
    expect(existsSync(legacyDirectory)).toBe(false);
    expect(existsSync(join(externalTarget, "marker.txt"))).toBe(true);

    const sessionExternalTarget = createDirectoryMarker(
      fixtureRoot,
      "session-external-target",
    );
    symlinkSync(
      sessionExternalTarget,
      join(storageRoot, "session-data"),
      "junction",
    );
    maintenance.resetDevSessionData(storageRoot);
    expect(existsSync(join(storageRoot, "session-data"))).toBe(false);
    expect(existsSync(join(sessionExternalTarget, "marker.txt"))).toBe(true);
  });

  it("removes deep and high-entry-count Chromium-style trees iteratively", () => {
    const { storageRoot } = createFixture();
    const legacyDirectory = join(storageRoot, "session-42-1700000000000");
    mkdirSync(legacyDirectory);
    let deepestDirectory = legacyDirectory;
    for (let depth = 0; depth < 256; depth += 1) {
      deepestDirectory = join(deepestDirectory, `d${depth % 10}`);
      mkdirSync(deepestDirectory);
    }
    writeFileSync(join(deepestDirectory, "deep-cache-entry"), "deep", "utf8");
    for (let index = 0; index < 2500; index += 1) {
      writeFileSync(
        join(legacyDirectory, `cache-entry-${index}.bin`),
        `${index}`,
        "utf8",
      );
    }

    expect(maintenance.pruneLegacyDevSessions(storageRoot)).toEqual({
      removedDirectories: 1,
    });
    expect(existsSync(legacyDirectory)).toBe(false);
  }, 60_000);

  it("refuses cleanup outside an exact electron-dev root", () => {
    const { fixtureRoot } = createFixture();
    const unexpectedRoot = join(fixtureRoot, "not-electron-dev");
    const legacyDirectory = createDirectoryMarker(
      unexpectedRoot,
      "session-5-6",
    );
    const sessionData = createDirectoryMarker(unexpectedRoot, "session-data");

    expect(() => maintenance.pruneLegacyDevSessions(unexpectedRoot)).toThrow(
      "Refusing maintenance outside electron-dev",
    );
    expect(() => maintenance.resetDevSessionData(unexpectedRoot)).toThrow(
      "Refusing maintenance outside electron-dev",
    );
    expect(existsSync(join(legacyDirectory, "marker.txt"))).toBe(true);
    expect(existsSync(join(sessionData, "marker.txt"))).toBe(true);
  });

  it("treats a missing exact storage root as an empty cleanup", () => {
    const { fixtureRoot } = createFixture();
    const missingStorageRoot = join(fixtureRoot, "nested", "electron-dev");

    expect(maintenance.pruneLegacyDevSessions(missingStorageRoot)).toEqual({
      removedDirectories: 0,
    });
    expect(() =>
      maintenance.resetDevSessionData(missingStorageRoot),
    ).not.toThrow();
    expect(existsSync(missingStorageRoot)).toBe(false);
  });
});
