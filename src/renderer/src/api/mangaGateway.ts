import type { MangaApi } from "../../../preload";

export type MangaGateway = MangaApi;

function createMissingPreloadMethod(property: PropertyKey): unknown {
  const name = String(property);
  if (name === "writeLog") {
    return () => Promise.resolve();
  }
  if (name === "onJobEvent" || name === "onModelTestEvent") {
    return () => () => undefined;
  }
  return () =>
    Promise.reject(
      new Error(`mangaApi preload bridge is not available for ${name}.`),
    );
}

export const mangaGateway: MangaGateway = new Proxy({} as MangaGateway, {
  get(_target, property) {
    if (property === Symbol.toStringTag) {
      return "MangaGateway";
    }

    const api = window.mangaApi;
    if (!api) {
      return createMissingPreloadMethod(property);
    }
    const value = Reflect.get(api, property);
    return typeof value === "function" ? value.bind(api) : value;
  },
});
