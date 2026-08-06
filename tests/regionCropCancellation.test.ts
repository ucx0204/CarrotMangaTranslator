import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRegionCropPage } from "../src/main/regionCrop";
import type { MangaPage } from "../src/shared/libraryTypes";

const electronMock = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
  createFromPath: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: electronMock.createFromBuffer,
    createFromPath: electronMock.createFromPath,
  },
}));

vi.mock("node:fs/promises", () => ({
  mkdir: fsMock.mkdir,
  rm: fsMock.rm,
  writeFile: fsMock.writeFile,
}));

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  electronMock.createFromBuffer.mockReset();
  electronMock.createFromPath.mockReset();
  fsMock.mkdir.mockReset().mockResolvedValue(undefined);
  fsMock.rm.mockReset().mockResolvedValue(undefined);
  fsMock.writeFile.mockReset().mockResolvedValue(undefined);
  electronMock.createFromPath.mockReturnValue(makeSourceImage());
  electronMock.createFromBuffer.mockReturnValue(makeSourceImage());
});

describe("region crop cancellation", () => {
  it("does not decode or write a crop when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const decodeFallback = vi.fn();

    await expect(
      createRegionCropPage(
        makePage("C:/page.webp"),
        { x: 100, y: 100, w: 400, h: 400 },
        "job-1",
        "C:/run",
        decodeFallback,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(decodeFallback).not.toHaveBeenCalled();
    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("passes the signal to fallback decode and stops before file creation when aborted there", async () => {
    const controller = new AbortController();
    const decodeGate = createDeferred<Buffer | null>();
    const decodeFallback = vi.fn(() => decodeGate.promise);

    const promise = createRegionCropPage(
      makePage("C:/page.webp"),
      { x: 100, y: 100, w: 400, h: 400 },
      "job-2",
      "C:/run",
      decodeFallback,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    decodeGate.resolve(Buffer.from("png"));

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(decodeFallback).toHaveBeenCalledWith(
      "C:/page.webp",
      controller.signal,
    );
    expect(electronMock.createFromBuffer).not.toHaveBeenCalled();
    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("removes only its incomplete crop when abort interrupts write", async () => {
    const controller = new AbortController();
    const decodeFallback = vi.fn();
    fsMock.writeFile.mockImplementation(
      async (
        _path: string,
        _data: Buffer,
        options: { signal?: AbortSignal },
      ) => {
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );

    const promise = createRegionCropPage(
      makePage("C:/page.png"),
      { x: 100, y: 100, w: 400, h: 400 },
      "job-3",
      "C:/run",
      decodeFallback,
      controller.signal,
    );
    await waitForCall(fsMock.writeFile);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("region-crops"),
      expect.any(Buffer),
      { signal: controller.signal },
    );
    const cropPath = fsMock.writeFile.mock.calls[0]?.[0];
    expect(fsMock.rm).toHaveBeenCalledWith(cropPath, { force: true });
    expect(fsMock.rm).toHaveBeenCalledTimes(1);
  });
});

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let index = 0; index < 10 && mock.mock.calls.length === 0; index += 1) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalled();
}

function makeSourceImage() {
  const crop = {
    isEmpty: () => false,
    toPNG: () => Buffer.from("png"),
  };
  return {
    isEmpty: () => false,
    crop: () => crop,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePage(imagePath: string): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath,
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}
