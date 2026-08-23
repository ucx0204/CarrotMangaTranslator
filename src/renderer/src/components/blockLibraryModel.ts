import React from "react";
import type {
  BlockLibraryEntryV1,
  BlockLibrarySnapshotV1,
} from "../../../shared/blockLibrary";
import { resolveTransformedBlockBounds } from "../../../shared/editableRenderGeometry";
import type { TranslationBlock } from "../../../shared/textTypes";
import { blockLibraryGateway } from "../api/blockLibraryGateway";

export type BlockLibrarySource = Pick<
  typeof blockLibraryGateway,
  | "deleteBlockLibraryEntry"
  | "listBlockLibraryEntries"
  | "renameBlockLibraryEntry"
  | "saveBlockLibraryEntry"
  | "updateBlockLibraryEntry"
  | "useBlockLibraryEntry"
>;

export type BlockLibrarySortMode = "recent" | "name";

const THUMBNAIL_CONTENT_EXTENT = 860;
const MAX_THUMBNAIL_ZOOM = 48;
const MIN_THUMBNAIL_ZOOM = 0.1;

export type BlockLibraryThumbnailModel = {
  block: TranslationBlock;
  zoom: number;
};

/**
 * Centers the transformed block and fits its full visual bounds into a square
 * thumbnail. This is a preview-only camera transform; the persisted template
 * and the block inserted into a page are left untouched.
 */
export function resolveBlockLibraryThumbnailModel(
  block: TranslationBlock,
): BlockLibraryThumbnailModel {
  const renderBbox = block.renderBbox ?? block.bbox;
  const bounds = resolveTransformedBlockBounds(block, renderBbox);
  const offsetX = 500 - (bounds.x + bounds.w / 2);
  const offsetY = 500 - (bounds.y + bounds.h / 2);
  const centeredBlock: TranslationBlock = {
    ...block,
    renderBbox: {
      ...renderBbox,
      x: renderBbox.x + offsetX,
      y: renderBbox.y + offsetY,
    },
    renderBboxSpace: "normalized_1000",
  };
  const width = Math.max(1, bounds.w);
  const height = Math.max(1, bounds.h);
  return {
    block: centeredBlock,
    zoom: clamp(
      Math.min(
        THUMBNAIL_CONTENT_EXTENT / width,
        THUMBNAIL_CONTENT_EXTENT / height,
      ),
      MIN_THUMBNAIL_ZOOM,
      MAX_THUMBNAIL_ZOOM,
    ),
  };
}

export function filterAndSortBlockLibraryEntries(
  entries: readonly BlockLibraryEntryV1[],
  query: string,
  sort: BlockLibrarySortMode,
  locale?: string,
): BlockLibraryEntryV1[] {
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const filtered = normalizedQuery
    ? entries.filter((entry) =>
        [entry.name, entry.block.sourceText, entry.block.translatedText].some(
          (value) => value.toLocaleLowerCase(locale).includes(normalizedQuery),
        ),
      )
    : [...entries];
  return filtered.sort((left, right) =>
    sort === "name"
      ? left.name.localeCompare(right.name, locale, {
          numeric: true,
          sensitivity: "base",
        })
      : right.lastUsedAt.localeCompare(left.lastUsedAt) ||
        right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function resolveBlockLibraryError(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

type ControllerOptions = {
  canInsert: boolean;
  locale?: string;
  loadFailedMessage: string;
  onClose: () => void;
  onInsert: (entry: BlockLibraryEntryV1) => void;
  source: BlockLibrarySource;
  useFailedMessage: string;
};

export function useBlockLibraryController({
  canInsert,
  locale,
  loadFailedMessage,
  onClose,
  onInsert,
  source,
  useFailedMessage,
}: ControllerOptions) {
  const [snapshot, setSnapshot] = React.useState<BlockLibrarySnapshotV1 | null>(
    null,
  );
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<BlockLibrarySortMode>("recent");
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [editEntry, setEditEntry] = React.useState<BlockLibraryEntryV1 | null>(
    null,
  );
  const [deleteEntry, setDeleteEntry] =
    React.useState<BlockLibraryEntryV1 | null>(null);
  useLoadBlockLibrary(source, setSnapshot, setError, loadFailedMessage);
  const visibleEntries = React.useMemo(
    () =>
      filterAndSortBlockLibraryEntries(
        snapshot?.entries ?? [],
        query,
        sort,
        locale,
      ),
    [locale, query, snapshot?.entries, sort],
  );
  const insert = async (entry: BlockLibraryEntryV1): Promise<void> => {
    if (!canInsert || busyId) return;
    setBusyId(entry.id);
    setError("");
    try {
      onInsert(await source.useBlockLibraryEntry(entry.id));
      onClose();
    } catch (useError) {
      setError(resolveBlockLibraryError(useError, useFailedMessage));
    } finally {
      setBusyId(null);
    }
  };
  return {
    busyId,
    deleteEntry,
    error,
    insert,
    query,
    editEntry,
    setBusyId,
    setDeleteEntry,
    setError,
    setQuery,
    setEditEntry,
    setSnapshot,
    setSort,
    snapshot,
    sort,
    visibleEntries,
  };
}

function useLoadBlockLibrary(
  source: BlockLibrarySource,
  setSnapshot: React.Dispatch<
    React.SetStateAction<BlockLibrarySnapshotV1 | null>
  >,
  setError: React.Dispatch<React.SetStateAction<string>>,
  fallback: string,
): void {
  React.useEffect(() => {
    let active = true;
    void source
      .listBlockLibraryEntries()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch((error) => {
        if (active) setError(resolveBlockLibraryError(error, fallback));
      });
    return () => {
      active = false;
    };
  }, [fallback, setError, setSnapshot, source]);
}
