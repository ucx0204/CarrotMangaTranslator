import { beforeAll, beforeEach } from "vitest";

function ensureTestLocalStorage(): void {
  if (typeof window === "undefined") return;
  try {
    if (typeof window.localStorage?.getItem === "function") return;
  } catch (_error) {
    // error-policy-allow: an unavailable Node 26 getter is the condition this
    // test-only in-memory localStorage fallback is designed to replace.
    // Node 26 exposes an unavailable localStorage getter unless a backing file
    // is configured. Renderer tests need the same in-memory semantics as jsdom.
  }

  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(String(key)) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(String(key));
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

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
  ensureTestLocalStorage();
  setupRendererI18n();
}
