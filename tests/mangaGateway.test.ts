import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMangaGateway,
  createTestMangaGatewayStub,
  getMangaGateway,
  mangaGateway,
} from "../src/renderer/src/api/mangaGateway";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mangaGateway", () => {
  it("fails fast when the bridge is missing", () => {
    expect(() => createMangaGateway(undefined)).toThrow(/bridge/i);
    expect(() => getMangaGateway()).toThrow(/bridge/i);
    expect(() => mangaGateway.writeLog).toThrow(/bridge/i);
  });

  it("allows an explicit test stub only through the test option", async () => {
    const gateway = createMangaGateway(undefined, {
      allowMissingBridgeForTests: true,
    });

    await expect(gateway.writeLog("info", "hello")).rejects.toThrow(/writeLog/);
  });

  it("uses the exposed bridge when window.mangaApi exists", async () => {
    const expectedLibrary = { workOrder: [], works: [] };
    const api = createTestMangaGatewayStub({
      getLibrary: async () => expectedLibrary,
    });
    vi.stubGlobal("window", { mangaApi: api });

    await expect(mangaGateway.getLibrary()).resolves.toBe(expectedLibrary);
  });
});
