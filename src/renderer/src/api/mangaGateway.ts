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
      if (property === "onAppOperationActivity") {
        return () => () => undefined;
      }
      if (property === "getActiveAppOperation") {
        return async () => null;
      }
      if (property === "cancelAppOperation") {
        return async () => ({ accepted: false });
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

export function createMangaDomainGateway<const TMethod extends keyof MangaApi>(
  domainName: string,
  methods: readonly TMethod[],
): Pick<MangaApi, TMethod> {
  const allowedMethods = new Set<PropertyKey>(methods);
  return new Proxy({} as Pick<MangaApi, TMethod>, {
    get(_target, property) {
      if (property === Symbol.toStringTag) {
        return `${domainName}MangaGateway`;
      }
      if (!allowedMethods.has(property)) {
        throw new Error(
          `${domainName} gateway does not expose ${String(property)}.`,
        );
      }

      const api = getMangaGateway();
      const value = Reflect.get(api, property);
      if (typeof value !== "function") {
        throw createMissingBridgeError(String(property));
      }
      return value.bind(api);
    },
  });
}
