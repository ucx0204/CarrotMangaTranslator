import { beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  mkdirCalls: [] as unknown[][],
  renameCalls: [] as unknown[][],
  unlinkCalls: [] as unknown[][],
  writeFileCalls: [] as unknown[][],
  renameErrors: [] as NodeJS.ErrnoException[]
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async (...args: unknown[]) => {
    fsState.mkdirCalls.push(args);
  }),
  readFile: vi.fn(),
  rename: vi.fn(async (...args: unknown[]) => {
    fsState.renameCalls.push(args);
    const error = fsState.renameErrors.shift();
    if (error) {
      throw error;
    }
  }),
  stat: vi.fn(),
  unlink: vi.fn(async (...args: unknown[]) => {
    fsState.unlinkCalls.push(args);
  }),
  writeFile: vi.fn(async (...args: unknown[]) => {
    fsState.writeFileCalls.push(args);
  })
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("library storage", () => {
  beforeEach(() => {
    fsState.mkdirCalls = [];
    fsState.renameCalls = [];
    fsState.unlinkCalls = [];
    fsState.writeFileCalls = [];
    fsState.renameErrors = [];
    vi.resetModules();
  });

  it("retries transient atomic rename failures without deleting the destination file", async () => {
    fsState.renameErrors = [errno("EPERM"), errno("EBUSY")];
    const { writeJsonFile } = await import("../src/main/libraryStore/storage");

    await writeJsonFile("C:/library/work/chapter.json", { ok: true });

    expect(fsState.writeFileCalls).toHaveLength(1);
    expect(fsState.renameCalls).toHaveLength(3);
    expect(fsState.unlinkCalls).toHaveLength(0);
    expect(String(fsState.renameCalls[0][1])).toBe("C:/library/work/chapter.json");
  });

  it("does not retry non-transient rename failures and removes only the temp file", async () => {
    fsState.renameErrors = [errno("ENOENT")];
    const { writeJsonFile } = await import("../src/main/libraryStore/storage");

    await expect(writeJsonFile("C:/library/work/chapter.json", { ok: true })).rejects.toMatchObject({ code: "ENOENT" });

    expect(fsState.renameCalls).toHaveLength(1);
    expect(fsState.unlinkCalls).toHaveLength(1);
    expect(String(fsState.unlinkCalls[0][0])).toContain(".chapter.json.");
  });
});
