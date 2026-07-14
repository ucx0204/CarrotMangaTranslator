import { createHmac, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

const IMAGE_PROTOCOL_ORIGIN = "mgt-image://library";
const IMAGE_URL_VERSION = "v1";
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const EXPECTED_FILE_ERROR_CODES = new Set([
  "EACCES",
  "EINVAL",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

type LibraryImageFileStats = {
  size: bigint;
  mtimeNs: bigint;
  isFile(): boolean;
};

export type LibraryImageUrlFiles = {
  libraryRoot: string;
  realpath(path: string): string;
  stat(path: string): LibraryImageFileStats;
};

export type LibraryImageUrlCodec = {
  createUrl(imagePath: string): string;
  resolveUrl(requestUrl: string): string | null;
};

type ImageMetadata = {
  imagePath: string;
  relativePath: string;
  size: string;
  mtimeNs: string;
};

type ParsedImageUrl = {
  payload: string;
  relativePath: string;
  size: string;
  mtimeNs: string;
};

class InvalidLibraryImageError extends Error {}

export function createNodeLibraryImageUrlFiles(
  libraryRoot: string,
): LibraryImageUrlFiles {
  return {
    libraryRoot,
    realpath: realpathSync.native,
    stat: (path) => statSync(path, { bigint: true }),
  };
}

export function createLibraryImageUrlCodec(options: {
  secret: Uint8Array;
  files: LibraryImageUrlFiles;
}): LibraryImageUrlCodec {
  if (options.secret.byteLength < 32) {
    throw new Error("Image URL signing secret must be at least 32 bytes.");
  }
  const secret = Buffer.from(options.secret);

  return {
    createUrl(imagePath) {
      const metadata = readImageMetadata(options.files, imagePath);
      const payload = encodeBase64Url(metadata.relativePath);
      const signature = signMetadata(
        secret,
        payload,
        metadata.size,
        metadata.mtimeNs,
      );
      return `${IMAGE_PROTOCOL_ORIGIN}/${IMAGE_URL_VERSION}/${payload}?s=${metadata.size}&m=${metadata.mtimeNs}&sig=${signature}`;
    },
    resolveUrl(requestUrl) {
      const parsed = parseImageUrl(requestUrl, secret);
      if (!parsed) {
        return null;
      }
      try {
        const metadata = readRelativeImageMetadata(
          options.files,
          parsed.relativePath,
        );
        if (
          metadata.size !== parsed.size ||
          metadata.mtimeNs !== parsed.mtimeNs
        ) {
          return null;
        }
        return metadata.imagePath;
      } catch (error) {
        if (
          error instanceof InvalidLibraryImageError ||
          isExpectedFileError(error)
        ) {
          return null;
        }
        throw error;
      }
    },
  };
}

function parseImageUrl(
  requestUrl: string,
  secret: Buffer,
): ParsedImageUrl | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch (_error) {
    return null;
  }
  const payload = parsePayload(url);
  const size = getCanonicalQueryValue(url, "s");
  const mtimeNs = getCanonicalQueryValue(url, "m");
  const signature = getSingleQueryValue(url, "sig");
  if (!payload || !size || !mtimeNs || !signature || !hasOnlyQueryKeys(url)) {
    return null;
  }
  if (!verifySignature(secret, payload, size, mtimeNs, signature)) {
    return null;
  }
  const relativePath = decodeRelativePath(payload);
  return relativePath ? { payload, relativePath, size, mtimeNs } : null;
}

function parsePayload(url: URL): string | null {
  if (
    url.protocol !== "mgt-image:" ||
    url.hostname !== "library" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }
  const match = /^\/v1\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  return match?.[1] ?? null;
}

function getCanonicalQueryValue(url: URL, key: string): string | null {
  const value = getSingleQueryValue(url, key);
  return value && /^(0|[1-9]\d*)$/.test(value) ? value : null;
}

function getSingleQueryValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && values[0] ? values[0] : null;
}

function hasOnlyQueryKeys(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  return (
    keys.length === 3 && keys.every((key) => ["s", "m", "sig"].includes(key))
  );
}

function readImageMetadata(
  files: LibraryImageUrlFiles,
  imagePath: string,
): ImageMetadata {
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    throw new InvalidLibraryImageError("Image path is required.");
  }
  const libraryRoot = files.realpath(resolve(files.libraryRoot));
  const canonicalImagePath = files.realpath(resolve(imagePath));
  return readCanonicalImageMetadata(files, libraryRoot, canonicalImagePath);
}

function readRelativeImageMetadata(
  files: LibraryImageUrlFiles,
  relativePath: string,
): ImageMetadata {
  const libraryRoot = files.realpath(resolve(files.libraryRoot));
  const candidatePath = resolve(libraryRoot, ...relativePath.split("/"));
  if (!isPathStrictlyInside(libraryRoot, candidatePath)) {
    throw new InvalidLibraryImageError("Image path escapes the library.");
  }
  const canonicalImagePath = files.realpath(candidatePath);
  return readCanonicalImageMetadata(files, libraryRoot, canonicalImagePath);
}

function readCanonicalImageMetadata(
  files: LibraryImageUrlFiles,
  libraryRoot: string,
  canonicalImagePath: string,
): ImageMetadata {
  if (!isPathStrictlyInside(libraryRoot, canonicalImagePath)) {
    throw new InvalidLibraryImageError("Image path escapes the library.");
  }
  if (
    !SUPPORTED_IMAGE_EXTENSIONS.has(extname(canonicalImagePath).toLowerCase())
  ) {
    throw new InvalidLibraryImageError("Unsupported image file.");
  }
  const stats = files.stat(canonicalImagePath);
  if (!stats.isFile()) {
    throw new InvalidLibraryImageError("Image path is not a regular file.");
  }
  return {
    imagePath: canonicalImagePath,
    relativePath: relative(libraryRoot, canonicalImagePath)
      .split(sep)
      .join("/"),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
  };
}

function isPathStrictlyInside(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath);
  return !!child && !child.startsWith("..") && !isAbsolute(child);
}

function decodeRelativePath(payload: string): string | null {
  let decoded: string;
  try {
    const bytes = Buffer.from(payload, "base64url");
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (encodeBase64Url(decoded) !== payload) {
      return null;
    }
  } catch (_error) {
    return null;
  }
  const segments = decoded.split("/");
  if (
    !decoded ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    isAbsolute(decoded) ||
    win32.isAbsolute(decoded) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return decoded;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signMetadata(
  secret: Buffer,
  payload: string,
  size: string,
  mtimeNs: string,
): string {
  return createHmac("sha256", secret)
    .update(`${IMAGE_URL_VERSION}\0${payload}\0${size}\0${mtimeNs}`)
    .digest("base64url");
}

function verifySignature(
  secret: Buffer,
  payload: string,
  size: string,
  mtimeNs: string,
  providedSignature: string,
): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(providedSignature)) {
    return false;
  }
  const expected = Buffer.from(signMetadata(secret, payload, size, mtimeNs));
  const provided = Buffer.from(providedSignature);
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}

function isExpectedFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    EXPECTED_FILE_ERROR_CODES.has(error.code)
  );
}
