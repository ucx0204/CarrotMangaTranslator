import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  McpOutputDeliveryObserver,
  MCP_DELIVERY_IDENTITY_LIMIT,
} from "../src/main/mcp/mcpOutputDeliveryObserver";
import { McpOutputDeliveryObservationSchema } from "../src/shared/mcpOutputDelivery";

function fixture() {
  let now = 1000;
  const observer = new McpOutputDeliveryObserver(() => now);
  const create = (
    artifactKey: string,
    retainedOutputId?: string,
    reissued = false,
  ) =>
    observer.created({
      artifactKey,
      retainedOutputId,
      origin: reissued ? "reissued" : "generated",
      expiresAt: 5000,
    });
  return {
    observer,
    create,
    advance: (value: number) => {
      now = value;
    },
  };
}

it("separates generation, reissue, response preparation and completed GET/HEAD evidence", () => {
  const f = fixture();
  const outputId = randomUUID();
  f.create("first", outputId);
  f.create("first", outputId);
  f.observer.disclosed("first", { includeAttachment: true });
  const get = f.observer.beginHttp("first", "GET");
  get.bytesQueued(7);
  get.complete();
  get.interrupt();
  get.bytesQueued(50);
  f.advance(1200);
  f.create("second", outputId, true);
  const head = f.observer.beginHttp("second", "HEAD");
  head.bytesQueued(1000);
  head.complete();
  const result = McpOutputDeliveryObservationSchema.parse(
    f.observer.inspect({ retainedOutputId: outputId }),
  );
  expect(result).toMatchObject({
    state: "observed",
    historyComplete: false,
    capabilities: { generated: 1, reissued: 1, latestCreatedAt: 1200 },
    toolResponsesPrepared: { text: 1, attachment: 1 },
    http: {
      getStarted: 1,
      headStarted: 1,
      getCompleted: 1,
      headCompleted: 1,
      bytesQueued: 7,
      inFlight: 0,
      interrupted: 0,
    },
  });
  expect(JSON.stringify(result)).not.toContain(outputId);
  expect(JSON.stringify(result)).not.toContain("artifactKey");
});

it("keeps equal-content identities separate and binds a late retained ID without double counting", () => {
  const f = fixture();
  const id = randomUUID();
  f.create("a");
  f.create("a", id);
  f.create("b", randomUUID());
  f.observer.beginHttp("b", "GET").complete();
  expect(f.observer.inspect({ retainedOutputId: id })).toMatchObject({
    capabilities: { generated: 1 },
    http: { getStarted: 0 },
  });
  expect(f.observer.inspect({ artifactKey: "a" })).toEqual(
    f.observer.inspect({ retainedOutputId: id }),
  );
});

it("bounds recent events, preserves aggregates and returns detached observations", () => {
  const f = fixture();
  f.create("a");
  for (let index = 0; index < 12; index++) {
    f.advance(1100 + index);
    const transfer = f.observer.beginHttp("a", "GET");
    transfer.bytesQueued(index + 1);
    if (index % 2) transfer.interrupt();
    else transfer.fail();
  }
  const observed = f.observer.inspect({ artifactKey: "a" });
  if (observed.state !== "observed")
    throw new Error("Expected observed output");
  expect(observed.recentEvents).toHaveLength(8);
  expect(observed.recentEvents[0].startedAt).toBe(1104);
  expect(observed).toMatchObject({
    recentEventsTruncated: true,
    http: { getStarted: 12, interrupted: 6, failed: 6, bytesQueued: 78 },
  });
  observed.http.getStarted = 999;
  observed.recentEvents[0].bytesQueued = 999;
  expect(f.observer.inspect({ artifactKey: "a" })).toMatchObject({
    http: { getStarted: 12 },
  });
  expect(f.observer.inspect({ artifactKey: "a" })).not.toEqual(observed);
});

it("bounds identities without resurrecting an evicted in-flight transfer", () => {
  const f = fixture();
  f.create("old");
  const old = f.observer.beginHttp("old", "GET");
  for (let index = 0; index < MCP_DELIVERY_IDENTITY_LIMIT; index++)
    f.create(`new-${index}`);
  old.bytesQueued(100);
  old.complete();
  expect(f.observer.inspect({ artifactKey: "old" })).toMatchObject({
    state: "not_observed",
    historyComplete: false,
  });
  expect(f.observer.inspect({ artifactKey: "new-0" })).toMatchObject({
    state: "observed",
  });
  expect(f.observer.inspect({ artifactKey: "new-511" })).toMatchObject({
    http: { getCompleted: 0 },
  });
});

it("prunes expired settled identities and ignores callbacks after endpoint closure", () => {
  const f = fixture();
  f.create("a");
  const active = f.observer.beginHttp("a", "GET");
  f.advance(5001);
  expect(f.observer.inspect({ artifactKey: "a" })).toMatchObject({
    http: { inFlight: 1 },
  });
  active.interrupt();
  expect(f.observer.inspect({ artifactKey: "a" }).state).toBe("not_observed");
  f.advance(1200);
  f.create("b");
  const late = f.observer.beginHttp("b", "GET");
  f.observer.close();
  late.complete();
  f.create("c");
  expect(f.observer.inspect({ artifactKey: "b" }).state).toBe("not_observed");
  expect(f.observer.inspect({ artifactKey: "c" }).state).toBe("not_observed");
});

it("does not turn invalid byte counts, overflow or unknown capabilities into receipt evidence", () => {
  const f = fixture();
  f.create("a");
  const transfer = f.observer.beginHttp("a", "GET");
  for (const value of [-1, 0.5, NaN, Infinity]) transfer.bytesQueued(value);
  transfer.bytesQueued(Number.MAX_SAFE_INTEGER);
  transfer.bytesQueued(10);
  transfer.complete();
  f.observer.beginHttp("missing", "GET").complete();
  expect(f.observer.inspect({ artifactKey: "a" })).toMatchObject({
    countsSaturated: true,
    http: { bytesQueued: Number.MAX_SAFE_INTEGER },
  });
  expect(f.observer.inspect({ artifactKey: "missing" }).state).toBe(
    "not_observed",
  );
});
