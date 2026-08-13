/* eslint-disable max-lines, max-lines-per-function, complexity -- streamed download budget, cancellation, URL policy and staged-file cleanup intentionally remain one auditable security boundary */
import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_PAGES_PER_REQUEST } from "../shared/ipcContractCore";
import {
  WEB_IMPORT_MAX_STAGED_BYTES,
  type WebImportImageFormat,
  type WebImportSkipCounts,
  type WebImportStoredExtension,
} from "../shared/webImportTypes";
import { throwIfAborted } from "./abortSignal";
import {
  probeImageFile,
  type ImageHeaderMetadata,
} from "./libraryStore/imageHeaderProbe";
import { MAX_IMPORT_IMAGE_BYTES } from "./libraryStore/zipSafety";
import type { DiscoveredWebImage } from "./webImportPageDiscovery";
import {
  assertPublicWebImportUrl,
  WebImportUrlError,
  type WebImportDnsLookup,
} from "./webImportUrlPolicy";

const DOWNLOAD_CONCURRENCY = 6;

export type WebImportFetchSession = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
};

export type StagedWebImportCandidate = {
  id: string;
  filePath: string;
  sourceFormat: WebImportImageFormat;
  storedExtension: WebImportStoredExtension;
  width: number;
  height: number;
  pixelCount: number;
  byteSize: number;
  pageIndex: number;
};

export type WebImportDownloadResult = {
  candidates: StagedWebImportCandidate[];
  skipped: WebImportSkipCounts;
  truncated: boolean;
  timedOut: boolean;
};

type DownloadAttempt =
  | {
      status: "ready";
      filePath: string;
      metadata: ImageHeaderMetadata;
      sha256: string;
    }
  | {
      status: "skipped";
      reason: keyof Omit<WebImportSkipCounts, "duplicate">;
    }
  | { status: "budget" }
  | { status: "timeout" };

export async function downloadDiscoveredWebImages({
  candidates,
  deadlineAt,
  directory,
  dnsLookup,
  pageUrl,
  session,
  signal,
  onProgress,
}: {
  candidates: readonly DiscoveredWebImage[];
  deadlineAt: number;
  directory: string;
  dnsLookup?: WebImportDnsLookup;
  pageUrl: string;
  session: WebImportFetchSession;
  signal: AbortSignal;
  onProgress: (completed: number, total: number) => void;
}): Promise<WebImportDownloadResult> {
  const staged = new StagedByteBudget();
  const skipped = emptySkipCounts();
  const accepted: StagedWebImportCandidate[] = [];
  const hashes = new Set<string>();
  let completed = 0;
  let truncated = false;
  let timedOut = false;

  for (
    let offset = 0;
    offset < candidates.length;
    offset += DOWNLOAD_CONCURRENCY
  ) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineAt) {
      truncated = true;
      timedOut = true;
      break;
    }
    if (accepted.length >= MAX_PAGES_PER_REQUEST) {
      truncated = true;
      break;
    }
    const batch = candidates.slice(offset, offset + DOWNLOAD_CONCURRENCY);
    const attempts = await Promise.all(
      batch.map((candidate) =>
        downloadCandidate({
          candidate,
          deadlineAt,
          directory,
          dnsLookup,
          pageUrl,
          session,
          signal,
          staged,
        }),
      ),
    );
    for (const attempt of attempts) {
      completed += 1;
      if (attempt.status === "skipped") {
        skipped[attempt.reason] += 1;
        continue;
      }
      if (attempt.status === "budget") {
        truncated = true;
        continue;
      }
      if (attempt.status === "timeout") {
        timedOut = true;
        truncated = true;
        continue;
      }
      if (hashes.has(attempt.sha256)) {
        skipped.duplicate += 1;
        staged.release(attempt.metadata.byteLength);
        await rm(attempt.filePath, { force: true });
        continue;
      }
      if (accepted.length >= MAX_PAGES_PER_REQUEST) {
        truncated = true;
        staged.release(attempt.metadata.byteLength);
        await rm(attempt.filePath, { force: true });
        continue;
      }
      hashes.add(attempt.sha256);
      const sourceFormat = attempt.metadata.format;
      accepted.push({
        id: randomUUID(),
        filePath: attempt.filePath,
        sourceFormat,
        storedExtension: storedExtensionFor(sourceFormat),
        width: attempt.metadata.width,
        height: attempt.metadata.height,
        pixelCount: attempt.metadata.pixelCount,
        byteSize: attempt.metadata.byteLength,
        pageIndex: accepted.length,
      });
    }
    onProgress(completed, candidates.length);
    if (timedOut || staged.exhausted) {
      truncated = true;
      break;
    }
  }

  return { candidates: accepted, skipped, truncated, timedOut };
}

async function downloadCandidate({
  candidate,
  deadlineAt,
  directory,
  dnsLookup,
  pageUrl,
  session,
  signal,
  staged,
}: {
  candidate: DiscoveredWebImage;
  deadlineAt: number;
  directory: string;
  dnsLookup?: WebImportDnsLookup;
  pageUrl: string;
  session: WebImportFetchSession;
  signal: AbortSignal;
  staged: StagedByteBudget;
}): Promise<DownloadAttempt> {
  const partialPath = join(directory, `.${randomUUID()}.part`);
  let reservedBytes = 0;
  try {
    throwIfAborted(signal);
    if (Date.now() >= deadlineAt) {
      return { status: "timeout" };
    }
    const sourceUrl = await assertPublicWebImportUrl(candidate.url, dnsLookup);
    const response = await fetchWithDeadline({
      deadlineAt,
      pageUrl,
      session,
      signal,
      url: sourceUrl.href,
    });
    if (!response.ok) {
      return { status: "skipped", reason: "failed" };
    }
    await assertPublicWebImportUrl(response.url || sourceUrl.href, dnsLookup);
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (isKnownUnsupportedImageType(contentType)) {
      return { status: "skipped", reason: "unsupported" };
    }
    const contentLength = readContentLength(
      response.headers.get("content-length"),
    );
    if (contentLength !== null && contentLength > MAX_IMPORT_IMAGE_BYTES) {
      return { status: "skipped", reason: "failed" };
    }
    if (contentLength !== null && !staged.canReserve(contentLength)) {
      staged.markExhausted();
      return { status: "budget" };
    }
    const streamed = await streamResponseToFile({
      deadlineAt,
      partialPath,
      response,
      signal,
      staged,
    });
    reservedBytes = streamed.byteLength;
    const metadata = await probeImageFile(
      partialPath,
      "web-import-image",
      undefined,
      signal,
    );
    const sourceExtension = sourceExtensionFor(metadata.format);
    const filePath = join(directory, `${randomUUID()}${sourceExtension}`);
    await rename(partialPath, filePath);
    reservedBytes = 0;
    return {
      status: "ready",
      filePath,
      metadata,
      sha256: streamed.sha256,
    };
  } catch (error) {
    if (reservedBytes > 0) {
      staged.release(reservedBytes);
    }
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Web import cancelled", "AbortError");
    }
    if (error instanceof DownloadDeadlineError) {
      return { status: "timeout" };
    }
    if (error instanceof StagedBudgetError) {
      staged.markExhausted();
      return { status: "budget" };
    }
    if (
      error instanceof WebImportUrlError &&
      error.reason === "private-address"
    ) {
      return { status: "skipped", reason: "blocked" };
    }
    return {
      status: "skipped",
      reason: isKnownUnsupportedImageError(error) ? "unsupported" : "failed",
    };
  } finally {
    await rm(partialPath, { force: true });
  }
}

async function fetchWithDeadline({
  deadlineAt,
  pageUrl,
  session,
  signal,
  url,
}: {
  deadlineAt: number;
  pageUrl: string;
  session: WebImportFetchSession;
  signal: AbortSignal;
  url: string;
}): Promise<Response> {
  throwIfAborted(signal);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new DownloadDeadlineError();
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DownloadDeadlineError()),
    remaining,
  );
  try {
    const referrer = createWebImageRequestReferrer(pageUrl, url);
    return await session.fetch(url, {
      credentials: "include",
      headers: {
        Accept: "image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
        ...(referrer ? { Referer: referrer } : {}),
      },
      referrerPolicy: "strict-origin-when-cross-origin",
      signal: controller.signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : error;
    }
    if (controller.signal.reason instanceof DownloadDeadlineError) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function createWebImageRequestReferrer(
  pageUrl: string,
  imageUrl: string,
): string | null {
  const page = new URL(pageUrl);
  const image = new URL(imageUrl);
  if (page.protocol === "https:" && image.protocol !== "https:") {
    return null;
  }
  return page.origin === image.origin ? page.href : `${page.origin}/`;
}

async function streamResponseToFile({
  deadlineAt,
  partialPath,
  response,
  signal,
  staged,
}: {
  deadlineAt: number;
  partialPath: string;
  response: Response;
  signal: AbortSignal;
  staged: StagedByteBudget;
}): Promise<{ byteLength: number; sha256: string }> {
  if (!response.body) {
    throw new Error("Image response had no body.");
  }
  const handle = await open(partialPath, "wx", 0o600);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      if (Date.now() >= deadlineAt) {
        throw new DownloadDeadlineError();
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const bytes = chunk.value;
      if (byteLength + bytes.byteLength > MAX_IMPORT_IMAGE_BYTES) {
        throw new Error("Web image exceeded the per-file byte budget.");
      }
      staged.reserve(bytes.byteLength);
      byteLength += bytes.byteLength;
      hash.update(bytes);
      await handle.write(bytes);
    }
    if (byteLength === 0) {
      throw new Error("Image response was empty.");
    }
    return { byteLength, sha256: hash.digest("hex") };
  } catch (error) {
    staged.release(byteLength);
    throw error;
  } finally {
    try {
      await reader.cancel();
    } catch (_error) {
      // error-policy-allow: stream cancellation is best-effort after the primary result.
      // Reader cancellation is best-effort after the primary stream result.
    }
    await handle.close();
  }
}

class StagedByteBudget {
  private bytes = 0;
  exhausted = false;

  canReserve(byteLength: number): boolean {
    return this.bytes + byteLength <= WEB_IMPORT_MAX_STAGED_BYTES;
  }

  reserve(byteLength: number): void {
    if (!this.canReserve(byteLength)) {
      throw new StagedBudgetError();
    }
    this.bytes += byteLength;
  }

  release(byteLength: number): void {
    this.bytes = Math.max(0, this.bytes - byteLength);
  }

  markExhausted(): void {
    this.exhausted = true;
  }
}

class StagedBudgetError extends Error {}
class DownloadDeadlineError extends Error {}

function emptySkipCounts(): WebImportSkipCounts {
  return { unsupported: 0, failed: 0, duplicate: 0, blocked: 0 };
}

function storedExtensionFor(
  format: WebImportImageFormat,
): WebImportStoredExtension {
  return format === "jpeg" ? ".jpg" : ".png";
}

function sourceExtensionFor(format: WebImportImageFormat): string {
  if (format === "jpeg") return ".jpg";
  if (format === "webp") return ".webp";
  return ".png";
}

function readContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isKnownUnsupportedImageType(contentType: string): boolean {
  return /image\/(?:avif|bmp|gif|svg\+xml|tiff|x-icon)/.test(contentType);
}

function isKnownUnsupportedImageError(error: unknown): boolean {
  return (
    error instanceof Error && /지원하지 않는|unsupported/i.test(error.message)
  );
}
