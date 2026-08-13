import { beforeAll, beforeEach } from "vitest";

export function setupRendererI18n(): void {
  let rendererI18n: typeof import("../src/renderer/src/appI18n") | undefined;

  beforeAll(async () => {
    rendererI18n = await import("../src/renderer/src/appI18n");
    await rendererI18n.initializeAppI18n("ko");
  });

  beforeEach(async () => {
    const appI18n = rendererI18n?.appI18n;
    if (!appI18n) {
      throw new Error("Renderer i18n was not initialized for this test suite.");
    }
    if (appI18n.language !== "ko") {
      await appI18n.changeLanguage("ko");
    }
  });
}

if (typeof document !== "undefined") {
  setupRendererI18n();
}
