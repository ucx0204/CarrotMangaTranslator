import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyFileAtomically,
  writeBinaryFileAtomically,
} from "../src/main/linkedWorkspace/linkedWorkspacePaths";
import {
  serializeJsonFile,
  writeJsonFile,
  writeTextFileAtomically,
  type AtomicFilePublication,
} from "../src/main/libraryStore/storage";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "mgt-reviewed-writer-"));
  roots.push(root);
  return root;
}

describe("native atomic writer publication hooks", () => {
  it.each(["binary", "copy", "text", "json"] as const)(
    "preserves %s writer bytes and records intent only after its owned temp is ready",
    async (kind) => {
      const root = await directory();
      const target = join(root, "target");
      const source = join(root, "source");
      await writeFile(target, "old");
      await writeFile(source, "copied");
      const expected =
        kind === "json"
          ? serializeJsonFile({ unicode: "번역" })
          : kind === "copy"
            ? "copied"
            : "new";
      const legacy = vi.fn();
      const events: string[] = [];
      const publication: AtomicFilePublication = {
        prepared: async (temporary, actual) => {
          expect(actual).toBe(target);
          expect(await readFile(target, "utf8")).toBe("old");
          expect(await readFile(temporary, "utf8")).toBe(expected);
          events.push("intent");
        },
        beforeAttempt: async () => {
          events.push("attempt");
        },
        committed: async () => {
          expect(await readFile(target, "utf8")).toBe(expected);
          events.push("effect");
        },
      };
      if (kind === "binary")
        await writeBinaryFileAtomically(
          target,
          Buffer.from("new"),
          legacy,
          publication,
        );
      if (kind === "copy")
        await copyFileAtomically(source, target, legacy, publication);
      if (kind === "text")
        await writeTextFileAtomically(target, "new", legacy, publication);
      if (kind === "json")
        await writeJsonFile(target, { unicode: "번역" }, legacy, publication);
      expect(legacy).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["intent", "attempt", "effect"]);
      expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      );
    },
  );

  it("removes only its own temp and preserves the previous target if intent verification fails", async () => {
    const root = await directory();
    const target = join(root, "target");
    await writeFile(target, "old");
    await writeFile(join(root, "user.tmp"), "keep");
    const committed = vi.fn();
    await expect(
      writeBinaryFileAtomically(target, Buffer.from("new"), undefined, {
        prepared: async () => {
          throw new Error("receipt rejected");
        },
        committed,
      }),
    ).rejects.toThrow("receipt rejected");
    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readFile(join(root, "user.tmp"), "utf8")).toBe("keep");
    expect(await readdir(root)).toEqual(
      expect.arrayContaining(["target", "user.tmp"]),
    );
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".target.")),
    ).toEqual([]);
    expect(committed).not.toHaveBeenCalled();
  });

  it("checks cancellation after an asynchronous per-attempt guard before rename", async () => {
    const root = await directory();
    const target = join(root, "target");
    await writeFile(target, "old");
    const controller = new AbortController();
    const entered = deferred();
    const proceed = deferred();
    const committed = vi.fn();
    const writing = writeTextFileAtomically(target, "new", undefined, {
      signal: controller.signal,
      beforeAttempt: async () => {
        entered.resolve();
        await proceed.promise;
      },
      committed,
    });
    const rejected = expect(writing).rejects.toMatchObject({
      name: "AbortError",
    });
    await entered.promise;
    controller.abort();
    proceed.resolve();
    await rejected;
    expect(await readFile(target, "utf8")).toBe("old");
    expect(committed).not.toHaveBeenCalled();
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("keeps a committed target when the effect callback fails instead of claiming rollback", async () => {
    const root = await directory();
    const target = join(root, "target");
    await writeFile(target, "old");
    await expect(
      writeBinaryFileAtomically(target, Buffer.from("new"), undefined, {
        prepared: async () => undefined,
        committed: async () => {
          throw new Error("effect receipt failed");
        },
      }),
    ).rejects.toThrow("effect receipt failed");
    expect(await readFile(target, "utf8")).toBe("new");
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
