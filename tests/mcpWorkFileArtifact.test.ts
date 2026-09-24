import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import type { McpArtifactRetention } from "../src/main/mcp/mcpArtifactTypes";

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const MAX_WORK_FILE_BYTES = 128 * 1024 * 1024;
const binding = {
  chapterId: "chapter",
  pageId: "page",
  revision: "page-v1:0000000000000000",
};
const workFileBinding = {
  workId: "work",
  chapterIds: ["chapter"],
  snapshot: "0".repeat(16),
};
const token = (url: string) => new URL(url).pathname.split("/")[2];
function barrier() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([0, -1, 1.5, NaN, Infinity, MAX_WORK_FILE_BYTES + 1])(
  "rejects an invalid workfile reservation (%s) before invoking the native writer",
  async (reserved) => {
    const store = new McpArtifactStore("https://workfile.test");
    const writer = vi.fn(async () => {});
    try {
      await expect(
        store.putWorkFile(
          writer,
          reserved,
          async () => {},
          new AbortController().signal,
          [binding],
          workFileBinding,
        ),
      ).rejects.toThrow();
      expect(writer).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  },
);

it("hashes the native file and retains its exact bytes and work binding", async () => {
  const bytes = Buffer.from("native workfile fixture\u0000with binary bytes");
  const retain = vi.fn<McpArtifactRetention>(async (entry, guard) => {
    await guard();
    expect(readFile).not.toHaveBeenCalled();
    expect(await readFile(entry.file)).toEqual(bytes);
    return "retained-workfile-id";
  });
  const store = new McpArtifactStore("https://workfile.test", Date.now, retain);
  let file = "";
  try {
    vi.mocked(readFile).mockClear();
    const output = await store.putWorkFile(
      async (path, signal) => {
        file = path;
        signal.throwIfAborted();
        await writeFile(path, bytes, { flag: "wx" });
      },
      MAX_WORK_FILE_BYTES,
      async () => {},
      new AbortController().signal,
      [binding],
      workFileBinding,
    );
    expect(output).toMatchObject({
      retainedOutputId: "retained-workfile-id",
      mimeType: "application/vnd.carrot.mgtshare",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(output.url).toMatch(
      /^https:\/\/workfile.test\/mcp-artifacts\/[A-Za-z0-9_-]{43}\/work\.mgtshare$/,
    );
    expect(output.url).not.toContain(file);
    expect(retain).toHaveBeenCalledOnce();
    expect(retain.mock.calls[0][0]).toMatchObject({
      bindings: [binding],
      workFileBinding,
      size: bytes.length,
      mimeType: "application/vnd.carrot.mgtshare",
    });
    const opened = await store.open(token(output.url), "work.mgtshare");
    expect(opened.filename).toBe("carrot-work.mgtshare");
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    await expect(store.assertAvailable(output.url)).resolves.toBeUndefined();
    await expect(
      store.open(token(output.url), "pages.zip"),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await store.close();
  }
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([0, 9])(
  "rejects a native writer's invalid actual length (%s) and removes only its file",
  async (length) => {
    const retain = vi.fn<McpArtifactRetention>(async () => "unexpected");
    const store = new McpArtifactStore(
      "https://workfile.test",
      Date.now,
      retain,
    );
    let file = "",
      sibling = "";
    try {
      await expect(
        store.putWorkFile(
          async (path) => {
            file = path;
            sibling = join(dirname(path), "unrelated-session-output.bin");
            await writeFile(sibling, "preserve until session closure");
            await writeFile(path, Buffer.alloc(length));
          },
          8,
          async () => {},
          new AbortController().signal,
          [binding],
          workFileBinding,
        ),
      ).rejects.toThrow();
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(sibling, "utf8")).toBe(
        "preserve until session closure",
      );
      expect(retain).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  },
);

it("preserves a native writer failure while removing its partial output", async () => {
  const store = new McpArtifactStore("https://workfile.test");
  const failure = new Error("native archive failed");
  let file = "";
  try {
    await expect(
      store.putWorkFile(
        async (path) => {
          file = path;
          await writeFile(path, "partial");
          throw failure;
        },
        32,
        async () => {},
        new AbortController().signal,
        [binding],
        workFileBinding,
      ),
    ).rejects.toBe(failure);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await store.close();
  }
});

it("does not start native writing for an already cancelled operation", async () => {
  const store = new McpArtifactStore("https://workfile.test");
  const operation = new AbortController();
  const failure = new Error("cancelled before export");
  operation.abort(failure);
  const writer = vi.fn(async () => {});
  try {
    await expect(
      store.putWorkFile(
        writer,
        32,
        async () => {},
        operation.signal,
        [binding],
        workFileBinding,
      ),
    ).rejects.toBe(failure);
    expect(writer).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});

it("checks cancellation after retention completes before returning a workfile link", async () => {
  const started = barrier(),
    finish = barrier();
  const operation = new AbortController();
  let file = "";
  const retain = vi.fn<McpArtifactRetention>(async () => {
    started.release();
    await finish.promise;
    return "late-retained-workfile-id";
  });
  const store = new McpArtifactStore("https://workfile.test", Date.now, retain);
  const pending = store.putWorkFile(
    async (path) => {
      file = path;
      await writeFile(path, "native output");
    },
    32,
    async () => {},
    operation.signal,
    [binding],
    workFileBinding,
  );
  const rejected = expect(pending).rejects.toThrow();
  try {
    await started.promise;
    operation.abort(new Error("cancelled during retention"));
    finish.release();
    await rejected;
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    finish.release();
    await Promise.allSettled([pending]);
    await store.close();
  }
});

it.each(["operation", "session"] as const)(
  "rejects a late native writer after %s cancellation and cleans up before returning",
  async (cancel) => {
    const retain = vi.fn<McpArtifactRetention>(async () => "unexpected");
    const store = new McpArtifactStore(
      "https://workfile.test",
      Date.now,
      retain,
    );
    const operation = new AbortController();
    const started = barrier(),
      finish = barrier();
    let file = "",
      writerSignal: AbortSignal | undefined;
    const pending = store.putWorkFile(
      async (path, signal) => {
        file = path;
        writerSignal = signal;
        await writeFile(path, "partial");
        started.release();
        await finish.promise;
        // A native writer may finish after its cancellation request.
        await writeFile(path, "late result");
      },
      32,
      async () => {},
      operation.signal,
      [binding],
      workFileBinding,
    );
    const rejected = expect(pending).rejects.toThrow();
    try {
      await started.promise;
      if (cancel === "operation")
        operation.abort(new Error("caller cancelled"));
      else store.stop();
      expect(writerSignal?.aborted).toBe(true);
      finish.release();
      await rejected;
      expect(retain).not.toHaveBeenCalled();
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finish.release();
      await Promise.allSettled([pending]);
      await store.close();
    }
  },
);

it("reserves concurrent workfiles before writing and releases unused and failed reservations", async () => {
  const store = new McpArtifactStore("https://workfile.test");
  const first = barrier(),
    second = barrier(),
    finish = barrier();
  const failure = new Error("second writer failed");
  const start = (started: ReturnType<typeof barrier>, fail: boolean) =>
    store.putWorkFile(
      async (path) => {
        await writeFile(path, "small native output");
        started.release();
        await finish.promise;
        if (fail) throw failure;
      },
      MAX_WORK_FILE_BYTES,
      async () => {},
      new AbortController().signal,
      [binding],
      workFileBinding,
    );
  const a = start(first, false),
    b = start(second, true);
  const failed = expect(b).rejects.toBe(failure);
  try {
    await Promise.all([first.promise, second.promise]);
    const deniedWriter = vi.fn(async () => {});
    await expect(
      store.putWorkFile(
        deniedWriter,
        1,
        async () => {},
        new AbortController().signal,
        [binding],
        workFileBinding,
      ),
    ).rejects.toThrow(/256 MiB/);
    expect(deniedWriter).not.toHaveBeenCalled();
    finish.release();
    const admitted = await a;
    await failed;
    const next = await store.putWorkFile(
      (path) => writeFile(path, "next"),
      MAX_WORK_FILE_BYTES,
      async () => {},
      new AbortController().signal,
      [binding],
      workFileBinding,
    );
    await expect(store.assertAvailable(admitted.url)).resolves.toBeUndefined();
    await expect(store.assertAvailable(next.url)).resolves.toBeUndefined();
  } finally {
    finish.release();
    await Promise.allSettled([a, b]);
    await store.close();
  }
});
