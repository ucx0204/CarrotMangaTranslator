import assert from "node:assert/strict";
import { it } from "vitest";
import {
  McpDesktopService,
  type McpDesktopLease,
} from "../src/main/application/mcpDesktopService";
import {
  readTailscaleOrigin,
  assertTailscaleListenerFree,
  readTailscaleSetupUrl,
} from "../src/main/mcp/mcpTailscalePolicy";
const prefs = { allowImages: false, allowEditing: false, autoStart: false };
function setup(open?: (signal: AbortSignal) => Promise<McpDesktopLease>) {
  let stops = 0,
    closes = 0,
    starts = 0,
    saves = 0;
  const errors: unknown[] = [];
  const lease: McpDesktopLease = {
    url: "https://carrot.tail-test.ts.net/mcp",
    stopAccepting: () => {
      stops++;
    },
    close: async () => {
      closes++;
    },
    pairingStatus: () => ({ pairingUntil: null, pending: [] }),
    beginPairing: () => undefined,
    resolvePairing: () => undefined,
    connections: () => [],
    revoke: async () => undefined,
  };
  const service = new McpDesktopService({
    reportEditorState: () => {},
    savedStatus: async () => ({ url: null, connections: [] }),
    revokeSaved: async () => {},
    diagnose: async () => ({ ok: true, checks: [] }),
    setupUrl: () => null,
    preferences: async () => ({ ...prefs }),
    savePreferences: async () => {
      saves++;
    },
    reportError: (error) => errors.push(error),
    open: async (_prefs, signal) => {
      starts++;
      return open ? open(signal) : lease;
    },
  });
  return {
    service,
    lease,
    errors,
    counts: () => ({ stops, closes, starts, saves }),
  };
}
it("stays off by default, serializes repeated on/off and preserves the fixed address", async () => {
  const f = setup();
  await f.service.initialize();
  assert.equal(f.counts().starts, 0);
  const on = await f.service.setEnabled(true);
  assert.equal(on.state, "online");
  await f.service.setEnabled(true);
  assert.equal(f.counts().starts, 1);
  const configured = await f.service.configure({ ...prefs, allowImages: true });
  assert.equal(configured.state, "online");
  assert.equal(f.counts().starts, 2);
  const off = await f.service.setEnabled(false);
  assert.equal(off.state, "off");
  assert.equal(off.url, on.url);
  await f.service.configure({ ...prefs, allowImages: true });
  assert.equal(f.counts().saves, 2);
  await f.service.setEnabled(true);
  await f.service.dispose();
  assert.equal(f.counts().closes, 3);
  assert.equal((await f.service.setEnabled(true)).state, "off");
});
it("off aborts pending setup immediately and a superseded queued on never publishes", async () => {
  let signal: AbortSignal | undefined;
  let reached: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const f = setup(async (s) => {
    signal = s;
    reached();
    await new Promise<void>((_, reject) =>
      s.addEventListener("abort", () => reject(s.reason), { once: true }),
    );
    throw new Error("unreachable");
  });
  const on = f.service.setEnabled(true);
  await started;
  const off = f.service.setEnabled(false);
  assert.equal(signal?.aborted, true);
  await Promise.all([on, off]);
  assert.equal((await f.service.getStatus()).state, "off");
  const next = setup();
  await Promise.all([
    next.service.setEnabled(true),
    next.service.setEnabled(false),
  ]);
  assert.equal(next.counts().starts, 0);
  await next.service.dispose();
});
it("reports a real startup failure rather than a false online state", async () => {
  const f = setup(async () => {
    throw new Error("No Tailscale login");
  });
  const status = await f.service.setEnabled(true);
  assert.equal(status.state, "error");
  assert.match(status.message ?? "", /Tailscale/);
  await assert.rejects(f.service.beginPairing());
  await f.service.dispose();
});
it("only accepts online Tailscale node identities", () => {
  const status = {
    BackendState: "Running",
    Self: { Online: true, DNSName: "Carrot.tail-test.ts.net." },
  };
  assert.equal(readTailscaleOrigin(status), "https://carrot.tail-test.ts.net");
  for (const bad of [
    null,
    {},
    { ...status, BackendState: "NeedsLogin" },
    { ...status, Self: { DNSName: "evil.ts.net.example" } },
  ])
    assert.throws(() => readTailscaleOrigin(bad));
});
it("accepts empty sharing status and rejects occupied foreground/background HTTPS routes", () => {
  for (const value of [null, {}, { TCP: { "8443": { HTTPS: true } } }])
    assert.doesNotThrow(() => assertTailscaleListenerFree(value));
  for (const value of [
    { TCP: { "443": { HTTPS: true } } },
    { Web: { "a.ts.net:443": {} } },
    { Foreground: { a: { TCP: { "443": {} } } } },
  ])
    assert.throws(() => assertTailscaleListenerFree(value));
  assert.equal(
    readTailscaleSetupUrl("go https://login.tailscale.com/f/funnel?node=123"),
    "https://login.tailscale.com/f/funnel?node=123",
  );
  assert.equal(
    readTailscaleSetupUrl("https://login.tailscale.com.evil.example/foo"),
    undefined,
  );
});
