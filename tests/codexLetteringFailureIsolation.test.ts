import { expect, it, vi } from "vitest";
import { generateStyleGroups } from "../src/main/pipeline/codexLetteringGroups";
import { ImageCheckpointError } from "../src/main/pipeline/imageJobFailure";
import { translatedPageReading } from "../src/main/codexImageEditing";
import { makePage, makeBlock } from "./unifiedInpaintingUiFixtures";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
function fixture() {
  const regions = translatedPageReading(
    {
      ...makePage(),
      blocks: ["a", "b", "c"].map((id) => ({
        ...makeBlock(),
        id,
        sourceText: id,
      })),
    },
    "image",
  ).regions;
  return {
    regions,
    context: {
      attempt: 1,
      issues: [],
      plan: {
        groups: [
          {
            id: "family",
            description: "",
            members: regions.map((region) => ({
              regionId: region.id,
              bold: false,
              italic: false,
            })),
          },
        ],
        fonts: [],
        sfxRendering: "image" as const,
      },
    },
  };
}
it("continues within the same family and preserves the first successful style anchor", async () => {
  const { regions, context } = fixture();
  const generate = vi.fn(
    async (region: (typeof regions)[number], _anchor?: string) => {
      if (region.id === "b") throw new Error("bad dimensions");
      return region.id;
    },
  );
  const failures = await generateStyleGroups(
    regions,
    context,
    new AbortController().signal,
    generate,
    vi.fn(),
  );
  expect(
    generate.mock.calls.map(([region, anchor]) => [region.id, anchor]),
  ).toEqual([
    ["a", undefined],
    ["b", "a"],
    ["c", "a"],
  ]);
  expect(failures).toMatchObject([
    { source: "b", error: { message: "bad dimensions" } },
  ]);
});
it.each(["checkpoint", "disk", "cancel"])(
  "stops new image calls on %s failure",
  async (kind) => {
    const { regions, context } = fixture();
    const controller = new AbortController();
    const generate = vi.fn(async () => {
      if (kind === "cancel") {
        controller.abort();
        throw controller.signal.reason;
      }
      if (kind === "disk")
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      throw new ImageCheckpointError(new Error("save failed"));
    });
    await expect(
      generateStyleGroups(
        regions,
        context,
        controller.signal,
        generate,
        vi.fn(),
      ),
    ).rejects.toThrow();
    expect(generate).toHaveBeenCalledOnce();
  },
);

it("settles another in-flight family without starting its next image after a storage failure", async () => {
  const { regions, context } = fixture();
  context.plan.groups = [];
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const generate = vi.fn(async (region: (typeof regions)[number]) => {
    if (region.id === "a")
      throw new ImageCheckpointError(new Error("disk full"));
    await pending;
    return region.id;
  });
  const result = generateStyleGroups(
    regions,
    context,
    new AbortController().signal,
    generate,
    vi.fn(),
  );
  const failed = expect(result).rejects.toBeInstanceOf(ImageCheckpointError);
  await Promise.resolve();
  release();
  await failed;
  expect(generate.mock.calls.map(([region]) => region.id)).toEqual(["a", "b"]);
});
