import type { MangaApi } from "../../../shared/mangaApi";

export type MangaGateway = MangaApi;

export type MangaGatewayOptions = {
  allowMissingBridgeForTests?: boolean;
};

const missingBridgeMessage =
  "Manga API bridge is not available. Check that the preload script exposed window.mangaApi.";

function readWindowMangaApi(): MangaApi | undefined {
  return typeof window === "undefined" ? undefined : window.mangaApi;
}

function createMissingBridgeError(methodName?: string): Error {
  return new Error(
    methodName
      ? `${missingBridgeMessage} Missing method: ${methodName}.`
      : missingBridgeMessage,
  );
}

export function createTestMangaGatewayStub(
  overrides: Partial<MangaApi> = {},
): MangaGateway {
  return new Proxy({} as MangaGateway, {
    get(_target, property) {
      if (property === Symbol.toStringTag) {
        return "TestMangaGatewayStub";
      }
      const value = Reflect.get(overrides, property);
      if (typeof value === "function") {
        return value.bind(overrides);
      }
      if (value !== undefined) {
        return value;
      }
      return () => Promise.reject(createMissingBridgeError(String(property)));
    },
  });
}

export function createMangaGateway(
  api: MangaApi | undefined,
  options: MangaGatewayOptions = {},
): MangaGateway {
  if (api) {
    return api;
  }
  if (options.allowMissingBridgeForTests) {
    return createTestMangaGatewayStub();
  }
  throw createMissingBridgeError();
}

export function getMangaGateway(): MangaGateway {
  return createMangaGateway(readWindowMangaApi());
}

export const mangaGateway: MangaGateway = new Proxy({} as MangaGateway, {
  get(_target, property) {
    if (property === Symbol.toStringTag) {
      return "MangaGateway";
    }

    const api = getMangaGateway();
    const value = Reflect.get(api, property);
    return typeof value === "function" ? value.bind(api) : value;
  },
});
