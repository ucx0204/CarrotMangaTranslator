import { describe, expect, it, vi } from "vitest";
import { createSessionDnsLookup } from "../src/main/webImportSessionManager";

describe("createSessionDnsLookup", () => {
  it("uses and caches the isolated Chromium session resolver", async () => {
    const resolveHost = vi.fn(async () => ({
      endpoints: [
        { address: "203.0.113.10", family: "ipv4" as const },
        { address: "2001:db8::10", family: "ipv6" as const },
      ],
    }));
    const lookup = createSessionDnsLookup({ resolveHost });

    const [first, second] = await Promise.all([
      lookup("CDN.EXAMPLE"),
      lookup("cdn.example"),
    ]);

    expect(first).toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ]);
    expect(second).toBe(first);
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(resolveHost).toHaveBeenCalledWith("cdn.example", {
      cacheUsage: "allowed",
    });
  });
});
