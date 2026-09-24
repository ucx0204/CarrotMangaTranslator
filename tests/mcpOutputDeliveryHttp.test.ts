import { get } from "node:http";
import { expect, it } from "vitest";
import {
  deliveryDeferred,
  outputDeliveryHttpFixture,
} from "./mcpOutputDeliveryHttp.fixture";

it("observes actual buffered response finish and does not treat body preparation as completion", async () => {
  const end = deliveryDeferred();
  const wrote = deliveryDeferred();
  const bytes = Buffer.from("synthetic delivered bytes");
  const f = await outputDeliveryHttpFixture(async ({ response, transfer }) => {
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Content-Length", bytes.length);
    transfer.bytesQueued(bytes.length);
    response.write(bytes);
    wrote.resolve();
    await end.promise;
    response.end();
  });
  try {
    const received = fetch(f.url);
    await wrote.promise;
    expect(f.inspect()).toMatchObject({
      http: {
        getStarted: 1,
        getCompleted: 0,
        inFlight: 1,
        bytesQueued: bytes.length,
      },
    });
    end.resolve();
    const response = await received;
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    await f.settled;
    expect(f.inspect()).toMatchObject({
      http: { getCompleted: 1, inFlight: 0, interrupted: 0, failed: 0 },
    });
    expect(f.listeners()).toEqual({
      finishCalls: 1,
      externalFinishPreserved: true,
      remainingMonitors: 0,
    });
  } finally {
    end.resolve();
    await f.close();
  }
});

it("records HEAD separately without treating its declared content length as body bytes", async () => {
  const f = await outputDeliveryHttpFixture(({ response, transfer }) => {
    response.setHeader("Content-Length", 24);
    transfer.bytesQueued(24);
    response.end(Buffer.alloc(24));
  });
  try {
    const response = await fetch(f.url, { method: "HEAD" });
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    await f.settled;
    expect(f.inspect()).toMatchObject({
      http: { headStarted: 1, headCompleted: 1, getStarted: 0, bytesQueued: 0 },
    });
    expect(f.listeners().remainingMonitors).toBe(0);
  } finally {
    await f.close();
  }
});

it("records a client disconnect during a body as incomplete and ignores a late producer continuation", async () => {
  const continuation = deliveryDeferred();
  const first = Buffer.from("first body chunk");
  const f = await outputDeliveryHttpFixture(async ({ response, transfer }) => {
    response.flushHeaders();
    transfer.bytesQueued(first.length);
    response.write(first);
    await continuation.promise;
    transfer.bytesQueued(100);
    transfer.complete();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let received = false;
      const request = get(f.url, (response) => {
        response.once("data", () => {
          received = true;
          response.destroy();
          request.destroy();
          resolve();
        });
        response.on("error", (error) => {
          if (!received) reject(error);
        });
      });
      request.on("error", (error) => {
        if (!received) reject(error);
      });
    });
    await f.settled;
    continuation.resolve();
    await f.sent;
    expect(f.inspect()).toMatchObject({
      http: {
        getCompleted: 0,
        interrupted: 1,
        failed: 0,
        inFlight: 0,
        bytesQueued: first.length,
      },
    });
    expect(f.listeners()).toEqual({
      finishCalls: 0,
      externalFinishPreserved: true,
      remainingMonitors: 0,
    });
  } finally {
    continuation.resolve();
    await f.close();
  }
});

it("observes server failure without consuming its error handler or retaining the private error text", async () => {
  const fail = deliveryDeferred();
  const error = new Error("private native path C:\\user\\manuscript.png");
  const f = await outputDeliveryHttpFixture(
    async ({ response, transfer, pipe }) => {
      response.flushHeaders();
      await pipe(
        (async function* () {
          transfer.bytesQueued(1);
          yield Buffer.from("a");
          await fail.promise;
          throw error;
        })(),
      );
    },
  );
  try {
    const response = await fetch(f.url);
    const body = response.arrayBuffer();
    fail.resolve();
    await expect(body).rejects.toThrow();
    await f.settled;
    await f.sent;
    expect(f.errors).toEqual([error]);
    expect(f.inspect()).toMatchObject({
      http: { getCompleted: 0, failed: 1, interrupted: 0, inFlight: 0 },
    });
    expect(JSON.stringify(f.inspect())).not.toContain("manuscript");
    expect(f.listeners().remainingMonitors).toBe(0);
  } finally {
    fail.resolve();
    await f.close();
  }
});
