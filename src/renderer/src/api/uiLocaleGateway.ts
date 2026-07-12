import type { MangaApi } from "../../../shared/mangaApi";

export type UiLocaleGateway = Pick<
  MangaApi,
  "getUiLocale" | "onUiLocaleChanged"
>;

const missingBridgeMessage =
  "UI locale API bridge is not available. Check that the preload script exposed window.mangaApi.";

function readWindowUiLocaleBridge(): Partial<UiLocaleGateway> | undefined {
  return typeof window === "undefined" ? undefined : window.mangaApi;
}

function getRequiredMethod<K extends keyof UiLocaleGateway>(
  methodName: K,
): UiLocaleGateway[K] {
  const bridge = readWindowUiLocaleBridge();
  const method = bridge?.[methodName];
  if (typeof method !== "function") {
    throw new Error(`${missingBridgeMessage} Missing method: ${methodName}.`);
  }
  return method.bind(bridge) as UiLocaleGateway[K];
}

export const uiLocaleGateway: UiLocaleGateway = {
  getUiLocale: () => getRequiredMethod("getUiLocale")(),
  onUiLocaleChanged: (callback) =>
    getRequiredMethod("onUiLocaleChanged")(callback),
};
