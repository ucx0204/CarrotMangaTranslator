const bridgeTemplate = `(() => {
  const runtimeErrors = [];
  const stringifyReason = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  Object.defineProperty(window, "__mangaQaRuntimeErrors", {
    configurable: true,
    value: runtimeErrors,
  });
  window.addEventListener("error", (event) => {
    runtimeErrors.push(
      event.error
        ? stringifyReason(event.error)
        : event.message || "Unknown window error",
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    runtimeErrors.push(
      "Unhandled promise rejection: " + stringifyReason(event.reason),
    );
  });

  const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
    <defs>
      <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#f7f1e5"/>
        <stop offset="1" stop-color="#d8d0c2"/>
      </linearGradient>
      <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
        <path d="M80 0H0V80" fill="none" stroke="#9d9487" stroke-width="2" opacity=".35"/>
      </pattern>
    </defs>
    <rect width="1200" height="1600" fill="url(#paper)"/>
    <rect width="1200" height="1600" fill="url(#grid)"/>
    <rect x="72" y="72" width="1056" height="1456" rx="36" fill="none" stroke="#c86548" stroke-width="18"/>
    <path d="M130 1180L410 780l210 230 180-270 270 440z" fill="#403b39" opacity=".82"/>
    <circle cx="830" cy="410" r="170" fill="#c86548" opacity=".85"/>
    <rect x="185" y="210" width="650" height="210" rx="105" fill="#fff" stroke="#252326" stroke-width="12"/>
    <path d="M320 410l-55 125 145-105" fill="#fff" stroke="#252326" stroke-width="12" stroke-linejoin="round"/>
    <text x="510" y="335" text-anchor="middle" font-family="Arial, sans-serif" font-size="68" font-weight="700" fill="#252326">QA PAGE IMAGE</text>
    <text x="600" y="1430" text-anchor="middle" font-family="Arial, sans-serif" font-size="42" fill="#403b39">mangaApi · getPageImageDataUrl</text>
  </svg>\`;
  const pageImageDataUrl =
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  const defaultFontPreferences = {
    favoriteIds: [],
    orderedIds: [],
    defaultFontId: "default",
  };
  const fontSnapshot = {
    customFonts: [],
    preferences: defaultFontPreferences,
  };
  const implementations = {
    getFontLibrary: async () => fontSnapshot,
    getLibrary: async () => ({ workOrder: [], works: [] }),
    getPageImageDataUrl: async () => pageImageDataUrl,
    getPanelState: async () => null,
    getRuntimeCapabilities: async () => ({
      buildChannel: "__BUILD_CHANNEL__",
      platform: "darwin",
      arch: "arm64",
      appleSilicon: true,
      gpuVendor: "apple",
      gpuName: "Apple M2 (QA)",
      supportsMetal: true,
      unifiedMemoryMb: 24576,
      localGemma: {
        available: true,
        metal: true,
        minimumUnifiedMemoryMb: {
          minimum12b: 16384,
          economy26b: 24576,
          full31b: 32768,
        },
      },
      inpainting: {
        fluxKlein: {
          available: true,
          metal: true,
          cpuFallback: false,
          minimumUnifiedMemoryMb: 16384,
        },
        lamaManga: { available: true, metal: true, cpuFallback: true },
        aotInpainting: { available: true, metal: true, cpuFallback: true },
      },
      ocr: { cpu: true, gpu: false },
    }),
    getUiLocale: async () => "ko",
    listCustomFonts: async () => [],
    registerCustomFont: async () => null,
    removeCustomFont: async () => [],
    saveFontPreferences: async (preferences) => ({
      customFonts: [],
      preferences: {
        ...defaultFontPreferences,
        ...(preferences || {}),
      },
    }),
  };
  const mangaApi = new Proxy(implementations, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === "string" && property.startsWith("on")) {
        return () => () => {};
      }
      return async () => null;
    },
  });
  Object.defineProperty(window, "mangaApi", {
    configurable: true,
    value: mangaApi,
    writable: true,
  });
})();`;

/** @param {"stable" | "mac-alpha"} buildChannel */
export function qaBridgeSource(buildChannel) {
  return bridgeTemplate.replace(
    '"__BUILD_CHANNEL__"',
    JSON.stringify(buildChannel),
  );
}
