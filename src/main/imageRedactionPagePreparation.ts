import type { MangaPage } from "../shared/libraryTypes";
import type {
  ImageRedactionPage,
  ImageRedactionStroke,
} from "../shared/imageRedaction";
import { assertSupportedRedactionSize } from "../shared/imageRedactionLimits";
import { fingerprintImageFile } from "./imageFingerprint";

type SavedPages = Record<
  string,
  { fingerprint: string; strokes: ImageRedactionStroke[] }
>;

/** Bound source reads; loading a preview never grants review or transmission approval. */
export async function prepareImageRedactionPages(
  pages: readonly MangaPage[],
  saved: SavedPages,
  signal?: AbortSignal,
): Promise<ImageRedactionPage[]> {
  signal?.throwIfAborted();
  for (const page of pages) assertSupportedRedactionSize(page);
  const prepared: ImageRedactionPage[] = [];
  for (let offset = 0; offset < pages.length; offset += 4) {
    signal?.throwIfAborted();
    const chunk = await Promise.all(
      pages.slice(offset, offset + 4).map(async (page) => {
        const fingerprint = await fingerprintImageFile(page.imagePath);
        return {
          id: page.id,
          name: page.name,
          imagePath: page.imagePath,
          width: page.width,
          height: page.height,
          fingerprint,
          strokes:
            saved[page.imagePath]?.fingerprint === fingerprint
              ? saved[page.imagePath].strokes
              : [],
        };
      }),
    );
    prepared.push(...chunk);
  }
  signal?.throwIfAborted();
  return prepared;
}
