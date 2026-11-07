import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withFontChapterC18Job } from "../src/main/pipeline/fontChapterC18Lifecycle";
import { releaseModelResource } from "../src/main/runtimeSupport/modelCleanupBarrier";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "carrot-font-cleanup-"));
  roots.push(root);
  const preserved = [
    "library/original.png",
    "outputs/page.png",
    "cache/font-chapter-c18/other-job/keep.json",
    "models/font/model.bin",
  ];
  for (const name of preserved) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), `keep:${name}`);
  }
  return { root, preserved };
}

it.each(["success", "failure", "cancel", "prepare-failure"])(
  "cleans only its own job after %s and preserves returned choices",
  async (mode) => {
    const { root, preserved } = await fixture();
    let directory = "";
    const failure = new Error(mode);
    const choices = new Map([
      ["page/block", { fontId: "font", fontWeight: 700 }],
    ]);
    const dispose = vi.fn(async () => {
      expect(
        await readFile(join(directory, "analysis/choices.json"), "utf8"),
      ).toBe("choices");
    });
    const run = withFontChapterC18Job(root, async (job) => {
      directory = job;
      await mkdir(join(job, "analysis"));
      await writeFile(join(job, "analysis/choices.json"), "choices");
      await writeFile(join(job, "request.json"), "request");
      if (mode === "prepare-failure") throw failure;
      return {
        worker: { dispose },
        read: async () => {
          if (mode !== "success") throw failure;
          return choices;
        },
      };
    });
    if (mode === "success") expect(await run).toBe(choices);
    else await expect(run).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(mode === "prepare-failure" ? 0 : 1);
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of preserved)
      expect(await readFile(join(root, name), "utf8")).toBe(`keep:${name}`);
  },
);

it("waits for termination before removing files and keeps files if termination fails", async () => {
  const { root } = await fixture();
  let directory = "";
  let reject!: (reason: Error) => void;
  const worker = {
    dispose: vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    ),
  };
  const run = withFontChapterC18Job(root, async (job) => {
    directory = job;
    await writeFile(join(job, "request.json"), "keep while running");
    return { worker, read: async () => "choices" };
  });
  const failed = expect(run).rejects.toMatchObject({
    code: "MODEL_CLEANUP_INCOMPLETE",
  });
  try {
    await vi.waitFor(() => expect(worker.dispose).toHaveBeenCalledOnce());
    expect(await readFile(join(directory, "request.json"), "utf8")).toBe(
      "keep while running",
    );
    reject(new Error("worker still alive"));
    await failed;
    expect(await readFile(join(directory, "request.json"), "utf8")).toBe(
      "keep while running",
    );
  } finally {
    await releaseModelResource(worker, async () => {});
  }
});

it("rejects a nested junction before deleting any scratch file or following it to originals", async () => {
  const { root } = await fixture();
  let link = "",
    directory = "";
  try {
    await expect(
      withFontChapterC18Job(root, async (job) => {
        directory = job;
        link = join(job, "source");
        await writeFile(join(job, "request.json"), "keep on unsafe tree");
        await symlink(join(root, "library"), link, "junction");
        return {
          worker: { dispose: async () => {} },
          read: async () => "choices",
        };
      }),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(join(root, "library/original.png"), "utf8")).toBe(
      "keep:library/original.png",
    );
    expect(await readFile(join(directory, "request.json"), "utf8")).toBe(
      "keep on unsafe tree",
    );
  } finally {
    if (link) await unlink(link);
  }
});

it("rejects a redirected cache before creating a job in the library", async () => {
  const root = await mkdtemp(join(tmpdir(), "carrot-font-parent-"));
  roots.push(root);
  await mkdir(join(root, "library"));
  await mkdir(join(root, "cache"));
  const link = join(root, "cache/font-chapter-c18");
  await symlink(join(root, "library"), link, "junction");
  try {
    const prepare = vi.fn();
    await expect(withFontChapterC18Job(root, prepare)).rejects.toThrow(
      /symlink/,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(await readdir(join(root, "library"))).toEqual([]);
  } finally {
    await unlink(link);
  }
});

it("reports preparation and cleanup failures together while preserving a linked original", async () => {
  const { root } = await fixture();
  const failure = new Error("runtime startup failed");
  let link = "";
  try {
    await expect(
      withFontChapterC18Job(root, async (job) => {
        link = join(job, "source");
        await symlink(join(root, "library"), link, "junction");
        throw failure;
      }),
    ).rejects.toMatchObject({
      errors: [failure, expect.any(Error)],
      cause: expect.any(Error),
    });
    expect(await readFile(join(root, "library/original.png"), "utf8")).toBe(
      "keep:library/original.png",
    );
  } finally {
    if (link) await unlink(link);
  }
});
