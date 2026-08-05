import { createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLibraryImageUrlCodec,
  createNodeLibraryImageUrlFiles,
  type LibraryImageUrlFiles,
} from "../src/main/imageUrlCodec";
import {
  createProtocolFileResponse,
  isProtocolFileUnavailableError,
} from "../src/main/protocolFileResponse";

const SECRET = Buffer.alloc(32, 0x5a);

type VirtualEntry = {
  size: bigint;
  mtimeNs: bigint;
  canonicalPath?: string;
  isFile?: boolean;
};

type TestProtocolHandler = (request: {
  url: string;
}) => Response | Promise<Response>;

function createVirtualLibrary(relativePaths: string[]) {
  const libraryRoot = resolve("virtual-image-library");
  const entries = new Map<string, VirtualEntry>();
  for (const [index, relativePath] of relativePaths.entries()) {
    entries.set(resolve(libraryRoot, relativePath), {
      size: BigInt(index + 1),
      mtimeNs: BigInt(10_000 + index),
    });
  }
  const files: LibraryImageUrlFiles = {
    libraryRoot,
    realpath(path) {
      const resolvedPath = resolve(path);
      if (resolvedPath === libraryRoot) {
        return libraryRoot;
      }
      const entry = entries.get(resolvedPath);
      if (!entry) {
        throw fileError("ENOENT");
      }
      return entry.canonicalPath ?? resolvedPath;
    },
    stat(path) {
      const entry = entries.get(resolve(path));
      if (!entry) {
        throw fileError("ENOENT");
      }
      return {
        size: entry.size,
        mtimeNs: entry.mtimeNs,
        isFile: () => entry.isFile !== false,
      };
    },
  };
  return {
    files,
    entries,
    paths: relativePaths.map((relativePath) =>
      resolve(libraryRoot, relativePath),
    ),
  };
}

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function createSignedUrl(
  relativePath: string,
  size = "1",
  mtimeNs = "1",
): string {
  const payload = Buffer.from(relativePath, "utf8").toString("base64url");
  return createSignedPayloadUrl(payload, size, mtimeNs);
}

function createSignedPayloadUrl(
  payload: string,
  size: string,
  mtimeNs: string,
): string {
  const signature = createHmac("sha256", SECRET)
    .update(`v1\0${payload}\0${size}\0${mtimeNs}`)
    .digest("base64url");
  return `mgt-image://library/v1/${payload}?s=${size}&m=${mtimeNs}&sig=${signature}`;
}

describe("library image URL codec", () => {
  it("canonicalizes the stable library root only once per codec", () => {
    const virtual = createVirtualLibrary([
      "pages/first.png",
      "pages/second.png",
    ]);
    const realpath = vi.spyOn(virtual.files, "realpath");
    const codec = createLibraryImageUrlCodec({
      secret: SECRET,
      files: virtual.files,
    });

    const urls = virtual.paths.map((path) => codec.createUrl(path));
    urls.forEach((url) => codec.resolveUrl(url));

    const rootCalls = realpath.mock.calls.filter(
      ([path]) => resolve(path) === resolve(virtual.files.libraryRoot),
    );
    expect(rootCalls).toHaveLength(1);
  });

  it("keeps 2,000 stateless URLs valid across repeated issuance", () => {
    const relativePaths = Array.from(
      { length: 2_000 },
      (_, index) => `works/work/chapter/pages/page-${index + 1}.png`,
    );
    const virtual = createVirtualLibrary(relativePaths);
    const codec = createLibraryImageUrlCodec({
      secret: SECRET,
      files: virtual.files,
    });

    const firstRound = virtual.paths.map((path) => codec.createUrl(path));
    const secondRound = virtual.paths.map((path) => codec.createUrl(path));
    const thirdRound = virtual.paths.map((path) => codec.createUrl(path));

    expect(new Set(firstRound).size).toBe(2_000);
    expect(secondRound).toEqual(firstRound);
    expect(thirdRound).toEqual(firstRound);
    for (const index of [0, 999, 1_999]) {
      expect(codec.resolveUrl(firstRound[index])).toBe(virtual.paths[index]);
    }
    expect(codec.resolveRequest(firstRound[0])).toEqual({
      imagePath: virtual.paths[0],
      size: "1",
      mtimeNs: "10000",
      contentType: "image/png",
    });
  });

  it("invalidates a stale file version without affecting a replacement URL", () => {
    const virtual = createVirtualLibrary(["pages/page.png"]);
    const codec = createLibraryImageUrlCodec({
      secret: SECRET,
      files: virtual.files,
    });
    const imagePath = virtual.paths[0];
    const firstUrl = codec.createUrl(imagePath);
    const entry = virtual.entries.get(imagePath);
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error("virtual file fixture is missing");
    }
    entry.size = 42n;
    entry.mtimeNs = 99_999n;

    const replacementUrl = codec.createUrl(imagePath);

    expect(replacementUrl).not.toBe(firstUrl);
    expect(codec.resolveUrl(firstUrl)).toBeNull();
    expect(codec.resolveUrl(replacementUrl)).toBe(imagePath);
    virtual.entries.delete(imagePath);
    expect(codec.resolveUrl(replacementUrl)).toBeNull();
  });

  it("rejects tampering and signed non-relative paths before file access", () => {
    const virtual = createVirtualLibrary(["pages/page.png"]);
    const codec = createLibraryImageUrlCodec({
      secret: SECRET,
      files: virtual.files,
    });
    const validUrl = codec.createUrl(virtual.paths[0]);
    const tampered = new URL(validUrl);
    tampered.searchParams.set("sig", `${tampered.searchParams.get("sig")}x`);

    expect(codec.resolveUrl(tampered.toString())).toBeNull();
    expect(codec.resolveUrl(`${validUrl}&extra=1`)).toBeNull();
    for (const relativePath of [
      "../outside.png",
      "/outside.png",
      "C:/outside.png",
      "pages\\outside.png",
      "pages//outside.png",
      "pages/./outside.png",
      "pages/\0outside.png",
    ]) {
      expect(codec.resolveUrl(createSignedUrl(relativePath))).toBeNull();
    }
    const invalidUtf8Payload = Buffer.from([0xff]).toString("base64url");
    expect(
      codec.resolveUrl(createSignedPayloadUrl(invalidUtf8Payload, "1", "1")),
    ).toBeNull();
  });

  it("canonicalizes real files and blocks outside paths and junction escapes", () => {
    const libraryRoot = mkdtempSync(join(tmpdir(), "mgt-image-library-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "mgt-image-outside-"));
    try {
      const insidePath = join(libraryRoot, "pages", "inside.png");
      const outsidePath = join(outsideRoot, "outside.png");
      mkdirSync(dirname(insidePath), { recursive: true });
      writeFileSync(insidePath, "inside");
      writeFileSync(outsidePath, "outside");
      const linkPath = join(libraryRoot, "linked");
      symlinkSync(
        outsideRoot,
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      const codec = createLibraryImageUrlCodec({
        secret: SECRET,
        files: createNodeLibraryImageUrlFiles(libraryRoot),
      });

      const validUrl = codec.createUrl(insidePath);
      expect(codec.resolveUrl(validUrl)).toBe(realpathSync.native(insidePath));
      expect(() => codec.createUrl(outsidePath)).toThrow();
      expect(() => codec.createUrl(join(linkPath, "outside.png"))).toThrow();

      const outsideStats = statSync(outsidePath, { bigint: true });
      const escapedUrl = createSignedUrl(
        "linked/outside.png",
        outsideStats.size.toString(),
        outsideStats.mtimeNs.toString(),
      );
      expect(codec.resolveUrl(escapedUrl)).toBeNull();
    } finally {
      rmSync(libraryRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("requires a supported regular file and a strong secret", () => {
    const virtual = createVirtualLibrary(["page.txt", "folder.png"]);
    const folderEntry = virtual.entries.get(virtual.paths[1]);
    expect(folderEntry).toBeDefined();
    if (!folderEntry) {
      throw new Error("virtual directory fixture is missing");
    }
    folderEntry.isFile = false;
    const codec = createLibraryImageUrlCodec({
      secret: SECRET,
      files: virtual.files,
    });

    expect(() => codec.createUrl(virtual.paths[0])).toThrow();
    expect(() => codec.createUrl(virtual.paths[1])).toThrow();
    expect(() =>
      createLibraryImageUrlCodec({
        secret: Buffer.alloc(31),
        files: virtual.files,
      }),
    ).toThrow(/at least 32 bytes/);
  });
});

describe("image protocol integration", () => {
  afterEach(() => {
    vi.doUnmock("electron");
    vi.resetModules();
  });

  it("streams signed long-path images and fonts without file URLs", async () => {
    const libraryRoot = mkdtempSync(join(tmpdir(), "mgt-image-handler-"));
    const imagePath = join(
      libraryRoot,
      `long-${"a".repeat(110)}`,
      `long-${"b".repeat(110)}`,
      "page.png",
    );
    const fontPath = join(dirname(imagePath), "font.ttf");
    mkdirSync(dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, "image");
    writeFileSync(fontPath, "font");
    expect(imagePath.length).toBeGreaterThan(260);
    const protocolHandle = vi.fn(
      (_scheme: string, _handler: TestProtocolHandler): void => undefined,
    );
    const registerSchemesAsPrivileged = vi.fn();
    const logError = vi.fn();
    vi.doMock("electron", () => ({
      protocol: { handle: protocolHandle, registerSchemesAsPrivileged },
    }));

    try {
      const imageProtocol = await import("../src/main/imageProtocol");
      let serveFile = createProtocolFileResponse;
      const controller = imageProtocol.createImageProtocolController({
        protocol: {
          handle: protocolHandle,
          registerSchemesAsPrivileged,
        },
        imageUrls: createLibraryImageUrlCodec({
          secret: SECRET,
          files: createNodeLibraryImageUrlFiles(libraryRoot),
        }),
        resolveLibraryImagePath: (path) => path,
        resolveFontFilePath: () => fontPath,
        serveFile: (path, options) => serveFile(path, options),
        isUnavailableError: isProtocolFileUnavailableError,
        reportError: logError,
      });
      controller.registerScheme();
      controller.registerHandler();
      const handlers = new Map<string, TestProtocolHandler>(
        protocolHandle.mock.calls,
      );
      const imageHandler = handlers.get("mgt-image");
      const fontHandler = handlers.get("mgt-font");
      expect(imageHandler).toBeDefined();
      expect(fontHandler).toBeDefined();
      if (!imageHandler || !fontHandler) {
        throw new Error("protocol handlers were not registered");
      }

      const imageUrl = controller.createLibraryImageUrl(imagePath);
      const imageResponse = await imageHandler({ url: imageUrl });
      expect(imageResponse.status).toBe(200);
      expect(await imageResponse.text()).toBe("image");
      expect(imageResponse.headers.get("Content-Type")).toBe("image/png");
      expect(imageResponse.headers.get("Content-Length")).toBe("5");
      expect(imageResponse.headers.get("Cache-Control")).toContain("immutable");
      for (const [fileName, contentType] of [
        ["page.jpg", "image/jpeg"],
        ["page.jpeg", "image/jpeg"],
        ["page.webp", "image/webp"],
      ] as const) {
        const variantPath = join(dirname(imagePath), fileName);
        writeFileSync(variantPath, fileName);
        const variantResponse = await imageHandler({
          url: controller.createLibraryImageUrl(variantPath),
        });
        expect(variantResponse.status).toBe(200);
        expect(variantResponse.headers.get("Content-Type")).toBe(contentType);
        expect(await variantResponse.text()).toBe(fileName);
      }

      const tamperedUrl = new URL(imageUrl);
      tamperedUrl.searchParams.set("s", "999");
      const missingResponse = await imageHandler({
        url: tamperedUrl.toString(),
      });
      expect(missingResponse.status).toBe(404);
      expect(missingResponse.headers.get("Cache-Control")).toBe("no-store");
      rmSync(imagePath);
      const deletedResponse = await imageHandler({ url: imageUrl });
      expect(deletedResponse.status).toBe(404);
      expect(deletedResponse.headers.get("Cache-Control")).toBe("no-store");
      const fontResponse = await fontHandler({ url: "mgt-font://font-id" });
      expect(fontResponse.status).toBe(200);
      expect(fontResponse.headers.get("Content-Type")).toBe("font/ttf");
      expect(await fontResponse.text()).toBe("font");
      // 커스텀 폰트는 file:// origin에서 교차 출처로 fetch되므로 CORS 헤더가
      // 있어야 차단되지 않는다(#52).
      expect(fontResponse.headers.get("Access-Control-Allow-Origin")).toBe("*");
      // 이미지는 <img>로 불러 CORS 헤더가 없어야 한다.
      expect(imageResponse.headers.get("Access-Control-Allow-Origin")).toBe(
        null,
      );

      writeFileSync(imagePath, "replacement");
      const replacementUrl = controller.createLibraryImageUrl(imagePath);
      serveFile = async () => {
        throw fileError("ENOENT");
      };
      const racedMissingResponse = await imageHandler({
        url: replacementUrl,
      });
      expect(racedMissingResponse.status).toBe(404);
      expect(racedMissingResponse.headers.get("Cache-Control")).toBe(
        "no-store",
      );
      expect(logError).not.toHaveBeenCalled();

      serveFile = async () => {
        throw new Error("open failed");
      };
      const errorResponse = await imageHandler({ url: replacementUrl });
      expect(errorResponse.status).toBe(500);
      expect(errorResponse.headers.get("Cache-Control")).toBe("no-store");
      expect(logError).toHaveBeenCalledWith(
        "Failed to serve image protocol request",
        expect.objectContaining({ url: replacementUrl }),
      );

      const fontMissingController = imageProtocol.createImageProtocolController(
        {
          protocol: {
            handle: protocolHandle,
            registerSchemesAsPrivileged,
          },
          imageUrls: createLibraryImageUrlCodec({
            secret: SECRET,
            files: createNodeLibraryImageUrlFiles(libraryRoot),
          }),
          resolveLibraryImagePath: (path) => path,
          resolveFontFilePath: () => null,
          serveFile: createProtocolFileResponse,
          isUnavailableError: isProtocolFileUnavailableError,
          reportError: logError,
        },
      );
      fontMissingController.registerHandler();
      const missingFontHandler = new Map<string, TestProtocolHandler>(
        protocolHandle.mock.calls,
      ).get("mgt-font");
      expect(missingFontHandler).toBeDefined();
      if (!missingFontHandler) {
        throw new Error("missing-font handler was not registered");
      }
      const missingFontResponse = await missingFontHandler({
        url: "mgt-font://missing",
      });
      expect(missingFontResponse.status).toBe(404);
      expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
        {
          scheme: "mgt-image",
          privileges: {
            standard: true,
            secure: true,
            stream: true,
            supportFetchAPI: true,
          },
        },
        {
          scheme: "mgt-font",
          privileges: {
            standard: true,
            secure: true,
            stream: true,
            supportFetchAPI: true,
            corsEnabled: true,
          },
        },
      ]);
    } finally {
      rmSync(libraryRoot, { recursive: true, force: true });
    }
  });
});
