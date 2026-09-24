import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { createMcpOwnedRunCompletion } from "../src/main/application/mcpOwnedRunCompletion";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const id = randomUUID();
  const old = { id, version: 1, requestId: randomUUID() };
  const next = { id, version: 2, requestId: randomUUID() };
  const request = (input: typeof old) => ({
    requestId: input.requestId,
    fingerprint: hashStableValue(["run", input]),
  });
  const reference = (input: typeof old) => ({ id, ...request(input) });
  const oldDone = deferred(),
    newDone = deferred();
  const oldRecord = {
    id,
    owner: "owner",
    status: "running",
    requests: [request(old)],
  };
  const newRecord = { ...oldRecord, requests: [request(old), request(next)] };
  const oldRun = {
    record: oldRecord,
    controller: new AbortController(),
    pause: false,
    done: oldDone.promise,
  };
  const newRun = {
    record: newRecord,
    controller: new AbortController(),
    pause: false,
    done: newDone.promise,
  };
  let active: typeof oldRun | undefined = newRun;
  let load = async () => structuredClone(newRecord);
  const completion = createMcpOwnedRunCompletion({
    active: () => active,
    load: () => load(),
    parse: (input: typeof old) => input,
    project: (record: typeof oldRecord) => ({
      id: record.id,
      status: record.status,
      requestId: record.requests.at(-1)?.requestId,
    }),
  });
  return {
    old,
    next,
    reference,
    oldDone,
    newDone,
    oldRun,
    newRun,
    completion,
    setActive: (value: typeof oldRun | undefined) => {
      active = value;
    },
    setLoad: (value: typeof load) => {
      load = value;
    },
  };
}

it("does not let an old historical request inspect, wait on or cancel a newer active action", async () => {
  const f = fixture();
  expect(await f.completion.find("owner", f.reference(f.old))).toBeUndefined();
  await expect(
    f.completion.wait("owner", f.old, AbortSignal.abort()),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    f.completion.control("owner", f.reference(f.old), "cancel"),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(f.newRun.controller.signal.aborted).toBe(false);
  expect(await f.completion.find("owner", f.reference(f.next))).toMatchObject({
    requestId: f.next.requestId,
  });
});

it("rechecks active identity if a newer action appears during retained loading", async () => {
  const f = fixture();
  const reading = deferred(),
    release = deferred();
  f.setActive(undefined);
  f.setLoad(async () => {
    reading.resolve();
    await release.promise;
    return structuredClone(f.oldRun.record);
  });
  const finding = f.completion.find("owner", f.reference(f.old));
  await reading.promise;
  f.setActive(f.newRun);
  release.resolve();
  expect(await finding).toBeUndefined();
  expect(f.newRun.controller.signal.aborted).toBe(false);
});

it("keeps a captured physical completion wait attached to its original active object", async () => {
  const f = fixture();
  f.setActive(f.oldRun);
  const cancellation = new AbortController();
  let settled = false;
  const waiting = f.completion
    .wait("owner", f.old, cancellation.signal)
    .finally(() => {
      settled = true;
    });
  await Promise.resolve();
  f.setActive(f.newRun);
  cancellation.abort();
  expect(f.oldRun.controller.signal.aborted).toBe(true);
  expect(f.newRun.controller.signal.aborted).toBe(false);
  expect(settled).toBe(false);
  f.oldRun.record.status = "cancelled";
  f.oldDone.resolve();
  expect(await waiting).toMatchObject({
    requestId: f.old.requestId,
    status: "cancelled",
  });
});
