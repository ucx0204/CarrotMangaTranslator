/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { WEB_IMPORT_COLLECT_SCRIPT } from "../src/main/webImportPageDiscovery";

afterEach(() => {
  document.body.replaceChildren();
});

describe("web import page collection script", () => {
  it("collects img, lazy, srcset, background, direct-link, and open-shadow URLs", () => {
    document.body.innerHTML = `
      <img src="https://cdn.example/current.jpg"
           srcset="https://cdn.example/small.jpg 1x, https://cdn.example/large.jpg 2x"
           data-original="https://cdn.example/lazy.jpg">
      <div style="background-image: url('https://cdn.example/background.png')"></div>
      <a href="https://cdn.example/direct.webp">image</a>
      <div id="shadow-host"></div>
    `;
    const host = document.getElementById("shadow-host");
    if (!host) throw new Error("Shadow host fixture is missing.");
    host.attachShadow({ mode: "open" }).innerHTML =
      '<img src="https://cdn.example/shadow.jpg">';

    const payload = window.eval(WEB_IMPORT_COLLECT_SCRIPT) as {
      candidates: Array<{ url: string }>;
    };
    const urls = payload.candidates.map((candidate) => candidate.url);

    expect(urls).toEqual(
      expect.arrayContaining([
        "https://cdn.example/current.jpg",
        "https://cdn.example/small.jpg",
        "https://cdn.example/large.jpg",
        "https://cdn.example/lazy.jpg",
        "https://cdn.example/background.png",
        "https://cdn.example/direct.webp",
        "https://cdn.example/shadow.jpg",
      ]),
    );
  });
});
