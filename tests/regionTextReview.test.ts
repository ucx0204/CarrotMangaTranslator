import { expect, it, vi } from "vitest";
import {
  waitForRegionTextReview,
  confirmRegionTranslation,
} from "../src/main/jobs/regionTranslationReview";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
const sessionId = "11111111-1111-4111-8111-111111111111";
const reading: CodexPageReading = {
  summary: "context",
  regions: ["a", "b", "c", "keep"].map((id) => ({
    id,
    action: id === "keep" ? "keep" : "image",
    sourceText: "ゴ",
    translatedText: "고오",
    sourceBbox: { x: 0, y: 0, w: 100, h: 100 },
    renderBbox: { x: 0, y: 0, w: 100, h: 100 },
    role: "sound",
    direction: "horizontal",
    background: "artwork",
    reason: "effect",
  })),
};
function setup(jobId = "job") {
  const controller = new AbortController();
  const show = vi.fn();
  const promise = waitForRegionTextReview({
    jobId,
    sessionId,
    reading,
    signal: controller.signal,
    show,
  });
  return { controller, show, promise };
}
const translations = ["a", "b", "c"].map((regionId) => ({
  regionId,
  text: "고",
}));
it("rejects masks attached to unknown, removed or duplicate regions without consuming the review", async () => {
  const { promise } = setup("scoped-protection");
  const maskDataUrl = "data:image/png;base64,AA==";
  const request = { jobId: "scoped-protection", sessionId, translations };
  for (const regionId of ["unknown", "keep"]) {
    expect(() =>
      confirmRegionTranslation({
        ...request,
        protection: {
          strokes: [],
          maskDataUrl,
          regions: [{ regionId, maskDataUrl }],
        },
      }),
    ).toThrow();
  }
  expect(() =>
    confirmRegionTranslation({
      ...request,
      translations: translations.map((row) => ({
        ...row,
        excluded: row.regionId === "a",
      })),
      protection: {
        strokes: [],
        maskDataUrl,
        regions: [{ regionId: "a", maskDataUrl }],
      },
    }),
  ).toThrow();
  expect(() =>
    confirmRegionTranslation({
      ...request,
      protection: {
        strokes: [],
        maskDataUrl,
        regions: Array(2).fill({ regionId: "a", maskDataUrl }),
      },
    }),
  ).toThrow();
  const protection = {
    strokes: [],
    maskDataUrl,
    regions: [{ regionId: "a", maskDataUrl }],
  };
  confirmRegionTranslation({ ...request, protection });
  expect((await promise).editProtection).toEqual(protection);
});
it("keeps deleted targets protected and binds user-added areas to an existing source parent", async () => {
  const { promise } = setup("edited-groups");
  expect(() =>
    confirmRegionTranslation({
      jobId: "edited-groups",
      sessionId,
      translations: translations.map((row) => ({ ...row, excluded: true })),
    }),
  ).toThrow(/하나 이상/);
  confirmRegionTranslation({
    jobId: "edited-groups",
    sessionId,
    translations: [
      { ...translations[0], excluded: true },
      translations[1],
      translations[2],
      {
        regionId: "new",
        parentRegionId: "b",
        text: "new text",
        sourceText: "",
        sourceBbox: { x: 300, y: 200, w: 400, h: 500 },
        styleGroupId: "family",
      },
    ],
  });
  const result = await promise;
  expect(result.regions[0].action).toBe("keep");
  expect(result.regions.at(-1)).toMatchObject({
    id: "new",
    parentRegionId: "b",
    translatedText: "new text",
    styleGroupId: "family",
    translationLocked: true,
    renderBbox: { x: 300, y: 200, w: 400, h: 500 },
  });
});
it("pauses with all three targets and applies exact user text while retaining omitted boxes", async () => {
  const { show, promise } = setup();
  const done = vi.fn();
  void promise.then(done);
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  expect(show.mock.calls[0][0].regions).toHaveLength(3);
  expect(
    confirmRegionTranslation({ jobId: "job", sessionId, translations }),
  ).toBe(true);
  const result = await promise;
  expect(
    result.regions
      .slice(0, 3)
      .map((r) => [r.translatedText, r.translationLocked]),
  ).toEqual([
    ["고", true],
    ["고", true],
    ["고", true],
  ]);
  expect(result.regions[3]).toEqual(reading.regions[3]);
  expect(reading.regions[0].translatedText).toBe("고오");
  expect(() =>
    confirmRegionTranslation({ jobId: "job", sessionId, translations }),
  ).toThrow(/만료/);
});

it("accepts explicit reviewed bounds, locks placement, and rejects boxes outside the crop", async () => {
  const { promise } = setup("bounds");
  const invalid = translations.map((row) => ({
    ...row,
    sourceBbox: { x: 900, y: 0, w: 200, h: 100 },
  }));
  expect(() =>
    confirmRegionTranslation({
      jobId: "bounds",
      sessionId,
      translations: invalid,
    }),
  ).toThrow();
  const sourceBbox = { x: 0, y: 0, w: 950, h: 1000 };
  confirmRegionTranslation({
    jobId: "bounds",
    sessionId,
    translations: translations.map((row) => ({ ...row, sourceBbox })),
  });
  const result = await promise;
  expect(result.regions[0]).toMatchObject({
    sourceBbox,
    renderBbox: sourceBbox,
    translationLocked: true,
  });
  expect(result.regions[3]).toEqual(reading.regions[3]);
});
it("rejects stale, missing, duplicate, extra and empty answers while keeping the pending input", async () => {
  const { promise } = setup();
  for (const input of [
    { sessionId: "22222222-2222-4222-8222-222222222222", translations },
    { sessionId, translations: translations.slice(0, 2) },
    {
      sessionId,
      translations: [translations[0], translations[0], translations[1]],
    },
    {
      sessionId,
      translations: [...translations, { regionId: "keep", text: "고" }],
    },
    {
      sessionId,
      translations: translations.map((t) => ({ ...t, text: "  " })),
    },
  ])
    expect(() =>
      confirmRegionTranslation({ jobId: "job", ...input }),
    ).toThrow();
  confirmRegionTranslation({ jobId: "job", sessionId, translations });
  await promise;
});
it("cancels a pending review and rejects late submissions", async () => {
  const { controller, promise } = setup();
  const rejection = expect(promise).rejects.toThrow("stopped");
  controller.abort(new Error("stopped"));
  await rejection;
  expect(() =>
    confirmRegionTranslation({ jobId: "job", sessionId, translations }),
  ).toThrow(/만료/);
});
it("cleans up a failed delivery, rejects duplicate review and handles pre-cancelled or empty readings", async () => {
  const first = setup();
  await expect(
    waitForRegionTextReview({
      jobId: "job",
      sessionId,
      reading,
      signal: first.controller.signal,
      show: vi.fn(),
    }),
  ).rejects.toThrow(/이미/);
  first.controller.abort(new Error("done"));
  await expect(first.promise).rejects.toThrow("done");
  await expect(
    waitForRegionTextReview({
      jobId: "job",
      sessionId,
      reading,
      signal: first.controller.signal,
      show: vi.fn(),
    }),
  ).rejects.toThrow("done");
  await expect(
    waitForRegionTextReview({
      jobId: "job",
      sessionId,
      reading: { summary: "", regions: [] },
      signal: new AbortController().signal,
      show: vi.fn(),
    }),
  ).rejects.toThrow(/찾지/);
  await expect(
    waitForRegionTextReview({
      jobId: "job",
      sessionId,
      reading,
      signal: new AbortController().signal,
      show: () => {
        throw Error("delivery");
      },
    }),
  ).rejects.toThrow("delivery");
  const last = setup();
  confirmRegionTranslation({ jobId: "job", sessionId, translations });
  await last.promise;
});

it("retains unchanged render placement and carries the confirmed exclusion contract", async () => {
  const custom = {
    ...reading,
    regions: reading.regions.map((r) => ({
      ...r,
      renderBbox: { x: 100, y: 100, w: 200, h: 200 },
    })),
  };
  const promise = waitForRegionTextReview({
    jobId: "protected",
    sessionId,
    reading: custom,
    signal: new AbortController().signal,
    show: () => {},
  });
  const protection = {
    maskDataUrl: "data:image/png;base64,AA==",
    strokes: [
      {
        space: "page" as const,
        mode: "hide" as const,
        shape: "square" as const,
        softness: 0,
        radiusX: 20,
        radiusY: 30,
        points: [{ x: 100, y: 200 }],
      },
    ],
  };
  confirmRegionTranslation({
    jobId: "protected",
    sessionId,
    translations: translations.map((row) => ({
      ...row,
      sourceBbox: reading.regions[0].sourceBbox,
    })),
    protection,
  });
  const result = await promise;
  expect(result.editProtection).toEqual(protection);
  expect(result.regions[0].renderBbox).toEqual(custom.regions[0].renderBbox);
});
