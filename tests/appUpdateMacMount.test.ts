import { afterEach, expect, it, vi } from "vitest";

type Image = {
  "image-path": string;
  "system-entities": { "mount-point"?: string; "dev-entry"?: string }[];
};
const { waitForMountedVolume } =
  require("./fixtures/appUpdateMacMount.cjs") as {
    waitForMountedVolume(options: {
      readImages: () => Image[];
      matchesImage: (image: Image) => boolean;
      timeoutMs?: number;
      intervalMs?: number;
    }): Promise<Image>;
  };

afterEach(() => vi.useRealTimers());

it("waits through image registration until the downloaded DMG has a mounted volume", async () => {
  vi.useFakeTimers();
  const registered: Image = {
    "image-path": "/downloads/update.dmg",
    "system-entities": [{ "dev-entry": "/dev/disk4" }],
  };
  const ready: Image = {
    ...registered,
    "system-entities": [
      { "mount-point": "/Volumes/Carrot", "dev-entry": "/dev/disk4s1" },
    ],
  };
  const unrelated: Image = { ...ready, "image-path": "/downloads/other.dmg" };
  const readImages = vi
    .fn<() => Image[]>()
    .mockReturnValueOnce([unrelated])
    .mockReturnValueOnce([unrelated, registered])
    .mockReturnValue([unrelated, ready]);
  const result = waitForMountedVolume({
    readImages,
    matchesImage: (image) => image["image-path"] === registered["image-path"],
  });
  const resolved = vi.fn();
  void result.then(resolved);
  await vi.advanceTimersByTimeAsync(500);
  expect(resolved).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toEqual(ready);
  expect(readImages).toHaveBeenCalledTimes(3);
});

it("still fails when the matching image never exposes a mounted volume", async () => {
  vi.useFakeTimers();
  const registered: Image = {
    "image-path": "/downloads/update.dmg",
    "system-entities": [],
  };
  const result = waitForMountedVolume({
    readImages: () => [registered],
    matchesImage: () => true,
    timeoutMs: 1000,
  });
  const assertion = expect(result).rejects.toThrow(
    "did not expose a mounted volume",
  );
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
});

it("does not hide failures while reading mount state", async () => {
  await expect(
    waitForMountedVolume({
      readImages: () => {
        throw new Error("hdiutil failed");
      },
      matchesImage: () => true,
    }),
  ).rejects.toThrow("hdiutil failed");
});
