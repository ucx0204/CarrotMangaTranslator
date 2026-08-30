import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMangaGateway,
  createMangaDomainGateway,
  createTestMangaGatewayStub,
  getMangaGateway,
} from "../src/renderer/src/api/mangaGateway";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mangaGateway", () => {
  it("fails fast when the bridge is missing", () => {
    expect(() => createMangaGateway(undefined)).toThrow(/bridge/i);
    expect(() => getMangaGateway()).toThrow(/bridge/i);
    const appGateway = createMangaDomainGateway("App", ["writeLog"]);
    expect(() => appGateway.writeLog).toThrow(/bridge/i);
  });

  it("allows an explicit test stub only through the test option", async () => {
    const gateway = createMangaGateway(undefined, {
      allowMissingBridgeForTests: true,
    });

    await expect(gateway.writeLog("info", "hello")).rejects.toThrow(/writeLog/);
  });

  it("provides inert defaults for background operation activity in test stubs", async () => {
    const gateway = createTestMangaGatewayStub();
    const unsubscribe = gateway.onAppOperationActivity(vi.fn());

    expect(Object.prototype.toString.call(gateway)).toBe(
      "[object TestMangaGatewayStub]",
    );
    expect(unsubscribe()).toBeUndefined();
    await expect(gateway.getActiveAppOperation()).resolves.toBeNull();
    await expect(gateway.cancelAppOperation("operation-1")).resolves.toEqual({
      accepted: false,
    });
  });

  it("uses the exposed bridge when window.mangaApi exists", async () => {
    const expectedLibrary = { workOrder: [], works: [] };
    const api = createTestMangaGatewayStub({
      getLibrary: async () => expectedLibrary,
    });
    vi.stubGlobal("window", { mangaApi: api });

    const libraryGateway = createMangaDomainGateway("Library", ["getLibrary"]);
    await expect(libraryGateway.getLibrary()).resolves.toBe(expectedLibrary);
  });

  it("does not expose methods outside a domain contract", () => {
    const libraryGateway = createMangaDomainGateway("Library", ["getLibrary"]);

    expect(() => Reflect.get(libraryGateway, "writeLog")).toThrow(
      /does not expose writeLog/,
    );
  });
});
