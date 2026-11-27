import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  KOHARU_LAYOUT_INPUT_SIZE,
  KOHARU_LAYOUT_QUERY_COUNT,
} from "../src/main/bubbleLayout/constants";
import type { SparseLayoutTransfer } from "../src/main/bubbleLayout/sparseLayoutWorker";

it("transfers the native bitmap and decodes an empty sparse result without a mask head", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koharu-sparse-test-")),
    path = join(dir, "layout.bin");
  const descriptor = Object.getOwnPropertyDescriptor(process, "parentPort");
  let dispatch:
    ((message: { data: SparseLayoutTransfer }) => Promise<void>) | undefined;
  const postMessage = vi.fn();
  try {
    Object.defineProperty(process, "parentPort", {
      configurable: true,
      value: {
        on: (_name: string, fn: typeof dispatch) => {
          dispatch = fn;
        },
        postMessage,
      },
    });
    await import("../src/main/bubbleLayout/sparseLayoutWorker");
    const handle = dispatch;
    if (!handle) throw new Error("Missing utility listener");
    const call = async (data: SparseLayoutTransfer) => {
      await handle({ data });
      return postMessage.mock.lastCall?.[0];
    };
    const base = { width: 2, height: 1, path };
    expect(
      await call({
        ...base,
        phase: "prepare",
        bitmap: new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255]),
      }),
    ).toEqual({ ok: true, result: null });
    expect((await readFile(path)).length).toBe(
      12 * KOHARU_LAYOUT_INPUT_SIZE ** 2,
    );
    await writeFile(
      path,
      Buffer.alloc(4 * (1 + 9 * KOHARU_LAYOUT_QUERY_COUNT)),
    );
    expect(await call({ ...base, phase: "decode" })).toEqual({
      ok: true,
      result: {
        imageWidth: 2,
        imageHeight: 1,
        executionProvider: "cuda",
        detections: [],
      },
    });
    await writeFile(path, Buffer.from([1, 0, 0, 0]));
    expect(await call({ ...base, phase: "decode" })).toMatchObject({
      ok: false,
      error: "Invalid sparse KoharuLayout output size.",
    });
  } finally {
    if (descriptor) Object.defineProperty(process, "parentPort", descriptor);
    else Reflect.deleteProperty(process, "parentPort");
    await rm(dir, { recursive: true, force: true });
  }
});
