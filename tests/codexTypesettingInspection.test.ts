import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import { prepareTypesettingInspection } from "../src/main/pipeline/codexTypesettingInspection";
import { askAstraJson } from "../src/main/pipeline/codexTypesettingRequest";

function fixture() {
  const raster = new PNG({ width: 4, height: 1 });
  raster.data.set([
    0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 128, 0, 200, 80, 0,
  ]);
  return {
    label: "opaque-region-id",
    dataUrl: `data:image/png;base64,${PNG.sync.write(raster).toString("base64")}`,
  };
}

function pixels(dataUrl: string) {
  return [...PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64")).data];
}

describe("opaque blind lettering inspection", () => {
  it("preserves dark and light ink and composites alpha without exposing hidden RGB", () => {
    const asset = fixture();
    const before = structuredClone(asset);
    const result = prepareTypesettingInspection(
      "readback-page-0",
      "Transcribe",
      [asset],
    );
    expect(result.images).toHaveLength(2);
    expect(pixels(result.images[0].dataUrl)).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255, 255, 127, 127, 255, 255, 255, 255, 255,
    ]);
    expect(pixels(result.images[1].dataUrl)).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255, 128, 0, 0, 255, 0, 0, 0, 255,
    ]);
    expect(result.images.map((image) => image.label)).toEqual([
      asset.label,
      asset.label,
    ]);
    expect(result.prompt).toContain("ONCE per distinct ID");
    expect(asset).toEqual(before);
  });

  it("leaves source, layout, review and erasure requests untouched", () => {
    const images = [{ label: "source", dataUrl: "unmodified-other-format" }];
    for (const stage of [
      "read-page",
      "erase-page",
      "layout-page",
      "review-page",
    ]) {
      const result = prepareTypesettingInspection(stage, "unchanged", images);
      expect(result.prompt).toBe("unchanged");
      expect(result.images).toBe(images);
    }
    const empty: typeof images = [];
    expect(
      prepareTypesettingInspection("readback-page", "none", empty),
    ).toEqual({ prompt: "none", images: empty });
  });

  it.each([
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,bm90IGEgcG5n",
    "data:image/png;base64,!!!!",
  ])(
    "rejects invalid readback rasters before any paid request: %s",
    async (dataUrl) => {
      const runEphemeralTurn = vi.fn();
      await expect(
        askAstraJson({
          client: { runEphemeralTurn },
          stage: "readback-page-0",
          prompt: "Transcribe",
          images: [{ label: "id", dataUrl }],
          cwd: "unused",
          signal: new AbortController().signal,
          evidence: vi.fn(),
          onRetry: vi.fn(),
        }),
      ).rejects.toThrow();
      expect(runEphemeralTurn).not.toHaveBeenCalled();
    },
  );

  it("records and transmits the same inspection bytes without changing independent answers", async () => {
    const asset = fixture();
    const original = asset.dataUrl;
    const evidence = vi.fn();
    const runEphemeralTurn = vi.fn().mockResolvedValue({
      text: '{"regions":[{"regionId":"opaque-region-id","text":"□"}]}',
      threadId: "thread",
      turnId: "turn",
      itemId: null,
    });
    const result = await askAstraJson({
      client: { runEphemeralTurn },
      stage: "readback-page-0",
      prompt: "Transcribe only",
      images: [asset],
      cwd: "unused",
      signal: new AbortController().signal,
      evidence,
      onRetry: vi.fn(),
    });
    expect(result).toEqual({ regions: [{ regionId: asset.label, text: "□" }] });
    const input = runEphemeralTurn.mock.calls[0][0].input;
    const images = input.filter(
      (item: { type: string }) => item.type === "image",
    );
    expect(images).toHaveLength(2);
    const metadata = evidence.mock.calls[0][1];
    expect(metadata.sourceImages).toEqual([
      {
        label: asset.label,
        sha256: createHash("sha256").update(original).digest("hex"),
      },
    ]);
    expect(
      metadata.images.map((item: { sha256: string }) => item.sha256),
    ).toEqual(
      images.map((item: { url: string }) =>
        createHash("sha256").update(item.url).digest("hex"),
      ),
    );
    expect(asset.dataUrl).toBe(original);
    expect(input[0].text).not.toContain("□");
  });
});
