import assert from "node:assert/strict";
import { it } from "vitest";
import {
  McpDesktopService,
  type McpDesktopLease,
} from "../src/main/application/mcpDesktopService";
const connection = {
  id: "a",
  clientName: "ChatGPT",
  scope: "carrot.read",
  createdAt: 1,
  revoked: false,
};
function fixture(
  openOverride?: (signal: AbortSignal) => Promise<void>,
  closeOverride?: () => Promise<void>,
) {
  const events: string[] = [];
  let preferences = {
    allowImages: false,
    allowEditing: false,
    autoStart: false,
  };
  const saved = { ...connection };
  let failure = () => {};
  const lease: McpDesktopLease = {
    url: "https://carrot.tail-test.ts.net/mcp",
    stopAccepting: () => {
      events.push("block");
    },
    close: async () => {
      events.push("close");
      await closeOverride?.();
    },
    connections: () => [{ ...saved }],
    pairingStatus: () => ({ pending: [], pairingUntil: null }),
    beginPairing: () => {
      events.push("pair");
    },
    resolvePairing: () => {
      events.push("approve");
    },
    revoke: async () => {
      saved.revoked = true;
    },
  };
  const service = new McpDesktopService({
    reportEditorState: () => {},
    preferences: async () => preferences,
    savePreferences: async (next) => {
      preferences = next;
    },
    savedStatus: async () => ({ url: lease.url, connections: [{ ...saved }] }),
    revokeSaved: async () => {
      saved.revoked = true;
    },
    open: async (_preferences, signal, failed) => {
      events.push("open");
      failure = failed;
      await openOverride?.(signal);
      return lease;
    },
    diagnose: async () => ({ ok: true, checks: [] }),
    reportError: () => {},
    setupUrl: () => null,
  });
  return { service, events, failure: () => failure() };
}
it("loads remembered approvals while off and reuses them after stop/start", async () => {
  const { service, events } = fixture();
  await service.initialize();
  assert.equal((await service.getStatus()).state, "off");
  assert.equal(
    (await service.getStatus()).connections[0].clientName,
    "ChatGPT",
  );
  assert.deepEqual(events, []);
  await service.setEnabled(true);
  await service.setEnabled(false);
  assert.equal((await service.getStatus()).connections[0].revoked, false);
  await service.setEnabled(true);
  assert.equal((await service.getStatus()).state, "online");
  await service.dispose();
  assert.equal(events.filter((item) => item === "open").length, 2);
  assert.equal(events.filter((item) => item === "close").length, 2);
});
it("aborts startup before on/off racing can leak a listener", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (signal) => {
    await gate;
    signal.throwIfAborted();
  });
  const start = f.service.setEnabled(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stop = f.service.setEnabled(false);
  release();
  await Promise.all([start, stop]);
  assert.equal((await f.service.getStatus()).state, "off");
  assert.equal(f.events.includes("close"), false);
});
it("restarts for permission changes but does not revoke approval and supports offline revocation", async () => {
  const f = fixture();
  await f.service.setEnabled(true);
  await f.service.configure({
    allowImages: true,
    allowEditing: false,
    autoStart: false,
  });
  assert.equal(f.events.filter((e) => e === "open").length, 2);
  await f.service.setEnabled(false);
  await f.service.revokeConnection("a");
  assert.equal((await f.service.getStatus()).connections[0].revoked, true);
  await assert.rejects(f.service.beginPairing(), /먼저/);
});
it("blocks immediately when its owned tunnel exits, retaining saved authentication", async () => {
  const f = fixture();
  await f.service.setEnabled(true);
  f.failure();
  assert.ok(f.events.includes("block"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = await f.service.getStatus();
  assert.equal(status.state, "error");
  assert.equal(status.connections[0].revoked, false);
  await f.service.dispose();
});
it("does not open again after terminal disposal", async () => {
  const f = fixture();
  await f.service.dispose();
  await f.service.setEnabled(true);
  assert.equal(f.events.includes("open"), false);
});

it("keeps a failed shutdown blocked and visible until an explicit retry completes", async () => {
  let fail = true;
  const f = fixture(undefined, async () => {
    if (fail) throw new Error("owned tunnel did not exit");
  });
  await f.service.setEnabled(true);
  await assert.rejects(f.service.setEnabled(false), /did not exit/);
  assert.equal((await f.service.getStatus()).state, "stopping");
  assert.equal((await f.service.getStatus()).connections[0].revoked, false);
  assert.ok(f.events.includes("block"));
  fail = false;
  await f.service.setEnabled(false);
  assert.equal((await f.service.getStatus()).state, "off");
});
