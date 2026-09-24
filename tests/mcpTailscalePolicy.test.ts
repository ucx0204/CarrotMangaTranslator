import { spawnTailscale } from "../src/main/mcp/mcpTailscaleProcess";
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  assertTailscaleListenerFree,
  readTailscaleOrigin,
  readTailscaleSetupUrl,
  tailscaleRouteReady,
} from "../src/main/mcp/mcpTailscalePolicy";
const origin = "https://carrot.tail-test.ts.net";
const config = {
  TCP: { "443": { HTTPS: true } },
  Web: {
    "carrot.tail-test.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:38475" } },
    },
  },
  AllowFunnel: { "carrot.tail-test.ts.net:443": true },
};
it("reads the stable identity only from a running node", () => {
  assert.equal(
    readTailscaleOrigin({
      BackendState: "Running",
      Self: { DNSName: "CARROT.tail-test.ts.net.", Online: true },
    }),
    origin,
  );
  for (const DNSName of [
    "evil.example",
    "carrot.ts.net.evil.example",
    "x@carrot.tail.ts.net",
    "carrot.tail.ts.net/path",
  ]) {
    assert.throws(() =>
      readTailscaleOrigin({ BackendState: "Running", Self: { DNSName } }),
    );
  }
  assert.throws(() => readTailscaleOrigin({ BackendState: "NeedsLogin" }));
});
it("never replaces existing background or foreground sharing routes", () => {
  assertTailscaleListenerFree(null);
  assertTailscaleListenerFree({});
  assertTailscaleListenerFree({ TCP: { "8443": { HTTPS: true } } });
  for (const value of [
    config,
    { Foreground: { lease: config } },
    { Services: { service: config } },
  ]) {
    assert.throws(() => assertTailscaleListenerFree(value));
    assert.equal(tailscaleRouteReady(value, origin, 38475), true);
    assert.equal(tailscaleRouteReady(value, origin, 38476), false);
  }
});
it("requires public exposure and refuses extra handlers or a different target", () => {
  assert.equal(
    tailscaleRouteReady({ ...config, AllowFunnel: {} }, origin, 38475),
    false,
  );
  assert.equal(
    tailscaleRouteReady(config, "https://other.tail-test.ts.net", 38475),
    false,
  );
  const extra = structuredClone(config);
  Object.assign(extra.Web["carrot.tail-test.ts.net:443"].Handlers, {
    "/other": { Path: "/private" },
  });
  assert.equal(tailscaleRouteReady(extra, origin, 38475), false);
});
it("only offers setup links on the exact Tailscale login host", () => {
  assert.equal(
    readTailscaleSetupUrl(
      "visit https://login.tailscale.com/f/funnel?node=123",
    ),
    "https://login.tailscale.com/f/funnel?node=123",
  );
  assert.equal(
    readTailscaleSetupUrl("https://login.tailscale.com.evil.example/f"),
    undefined,
  );
});

it("rejects invalid ports and relative executables before starting Funnel", () => {
  for (const port of [0, -1, 65536, 1.5])
    assert.throws(() => spawnTailscale("/nonexistent/tailscale", port));
  assert.throws(() => spawnTailscale("tailscale", 38475));
});
