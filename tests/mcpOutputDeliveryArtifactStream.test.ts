import { createReadStream, type ReadStream } from "node:fs";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { deliveryArtifactFixture } from "./mcpOutputDeliveryArtifact.fixture";

vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

/** Substitute only the disk boundary; capability access and the entire HTTP pipeline stay real. */
function controlledDisk(input: PassThrough) {
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const disk: ReadStream = Object.assign(input, {
    bytesRead: 0,
    path: "synthetic-output-stream",
    pending: false,
    close(callback?: (error?: NodeJS.ErrnoException | null) => void) {
      input.destroy();
      callback?.();
    },
  });
  vi.mocked(createReadStream).mockImplementationOnce(() => {
    started();
    return disk;
  });
  return ready;
}

it("records a native read failure before pipeline teardown and preserves the existing error report", async () => {
  const f = await deliveryArtifactFixture();
  const bytes = Buffer.from("synthetic streamed workfile bytes");
  const input = new PassThrough();
  try {
    const output = await f.workFile(bytes);
    const reference = await f.store.observation(output.url);
    const ready = controlledDisk(input);
    const pending = f.send(output.url);
    await ready;
    input.write(bytes.subarray(0, 1));
    const response = await pending;
    const rejected = expect(response.arrayBuffer()).rejects.toThrow();
    const failure = Object.assign(new Error("private source filename.psd"), {
      code: "EIO",
    });
    input.destroy(failure);
    await rejected;
    expect(await f.reported).toBe(failure);
    expect(f.observer.inspect(reference)).toMatchObject({
      http: {
        getCompleted: 0,
        failed: 1,
        interrupted: 0,
        inFlight: 0,
        bytesQueued: 1,
      },
    });
    expect(JSON.stringify(f.observer.inspect(reference))).not.toContain(
      "filename.psd",
    );
    expect(input.destroyed).toBe(true);
  } finally {
    input.destroy();
    await f.close();
  }
});

it("stops counting output chunks when the real per-chunk access guard is revoked", async () => {
  const f = await deliveryArtifactFixture();
  const bytes = Buffer.from("synthetic streamed workfile bytes");
  const input = new PassThrough();
  try {
    const output = await f.workFile(bytes);
    const reference = await f.store.observation(output.url);
    const ready = controlledDisk(input);
    const pending = f.send(output.url);
    await ready;
    input.write(bytes.subarray(0, 1));
    const response = await pending;
    const rejected = expect(response.arrayBuffer()).rejects.toThrow();
    f.revoke();
    input.end(bytes.subarray(1));
    await rejected;
    expect(await f.reported).toBe(f.revoked);
    expect(f.observer.inspect(reference)).toMatchObject({
      http: { getCompleted: 0, failed: 1, inFlight: 0, bytesQueued: 1 },
    });
    expect(input.destroyed).toBe(true);
  } finally {
    input.destroy();
    await f.close();
  }
});
