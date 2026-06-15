import type { MangaApi } from "../../../shared/mangaApi";

export type MangaGateway = MangaApi;

function createMissingBridgeMethod(property: PropertyKey): unknown {
  const name = String(property);
  if (name === "writeLog") {
    return () => Promise.resolve();
  }
  if (name === "onJobEvent" || name === "onModelTestEvent") {
    return () => () => undefined;
  }
  return () =>
    Promise.reject(new Error(`Manga API bridge is not available for ${name}.`));
}

export const mangaGateway: MangaGateway = new Proxy({} as MangaGateway, {
  get(_target, property) {
    if (property === Symbol.toStringTag) {
      return "MangaGateway";
    }

    const api = window.mangaApi;
    if (!api) {
      return createMissingBridgeMethod(property);
    }
    const value = Reflect.get(api, property);
    return typeof value === "function" ? value.bind(api) : value;
  },
});
