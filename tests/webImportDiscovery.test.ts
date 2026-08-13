import { describe, expect, it } from "vitest";
import {
  discoverWebImages,
  sortAndDedupeDiscoveredImages,
  type WebImportFrame,
} from "../src/main/webImportPageDiscovery";

describe("web import position ordering", () => {
  it("sorts top-to-bottom, then left-to-right, and keeps the earliest URL", () => {
    const sorted = sortAndDedupeDiscoveredImages([
      { url: "https://example.com/c.png", y: 10, x: 30, discoveryIndex: 2 },
      { url: "https://example.com/b.png", y: 10, x: 10, discoveryIndex: 1 },
      { url: "https://example.com/a.png#old", y: 20, x: 0, discoveryIndex: 0 },
      { url: "https://example.com/a.png#new", y: 30, x: 0, discoveryIndex: 3 },
    ]);

    expect(sorted.map((candidate) => candidate.url)).toEqual([
      "https://example.com/b.png",
      "https://example.com/c.png",
      "https://example.com/a.png",
    ]);
  });

  it("offsets loaded child-frame candidates into page coordinates", async () => {
    const child = fakeFrame({
      title: "",
      candidates: [
        {
          url: "https://cdn.example/frame.jpg",
          y: 20,
          x: 3,
          discoveryIndex: 0,
        },
      ],
      truncated: false,
    });
    const main = fakeFrame(
      {
        title: "Fixture chapter",
        candidates: [
          {
            url: "https://cdn.example/main.jpg",
            y: 10,
            x: 2,
            discoveryIndex: 0,
          },
        ],
        truncated: false,
      },
      [child],
      [{ x: 5, y: 100 }],
    );

    const result = await discoverWebImages(main);

    expect(result.title).toBe("Fixture chapter");
    expect(result.candidates).toEqual([
      {
        url: "https://cdn.example/main.jpg",
        y: 10,
        x: 2,
        discoveryIndex: 0,
      },
      {
        url: "https://cdn.example/frame.jpg",
        y: 120,
        x: 8,
        discoveryIndex: 5_000,
      },
    ]);
  });
});

function fakeFrame(
  payload: unknown,
  frames: WebImportFrame[] = [],
  rects: Array<{ x: number; y: number }> = [],
): WebImportFrame {
  return {
    frames,
    isDestroyed: () => false,
    executeJavaScript: async (script: string) =>
      script.includes('querySelectorAll("iframe, frame")') ? rects : payload,
  };
}
