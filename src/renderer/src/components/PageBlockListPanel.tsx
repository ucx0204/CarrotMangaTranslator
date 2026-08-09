import React from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockStylePresetSummary } from "../../../shared/blockStylePresets";
import {
  sortBlocksForReading,
  type BlockReadingDirection,
} from "../../../shared/blockReadingOrder";
import { PageBlockListRow } from "./PageBlockListRow";

type PageBlockListPanelProps = {
  disabled: boolean;
  page: MangaPage;
  presets: readonly BlockStylePresetSummary[];
  readingDirection: BlockReadingDirection;
  selectedBlockId: string | null;
  onApplyStylePreset: (presetId: string) => void;
  onOpenEditor: (blockId: string) => void;
  onSelectBlock: (blockId: string) => void;
  onUpdateBlock: (blockId: string, patch: Partial<TranslationBlock>) => void;
};

export function PageBlockListPanel({
  disabled,
  page,
  presets,
  readingDirection,
  selectedBlockId,
  onApplyStylePreset,
  onOpenEditor,
  onSelectBlock,
  onUpdateBlock,
}: PageBlockListPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const orderedBlocks = React.useMemo(
    () => sortBlocksForReading(page.blocks, readingDirection),
    [page.blocks, readingDirection],
  );
  const pinnedPresets = presets.filter((preset) => preset.pinned);

  React.useEffect(() => {
    if (!selectedBlockId) return;
    const row = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>(
        "[data-page-block-id]",
      ) ?? [],
    ).find((node) => node.dataset.pageBlockId === selectedBlockId);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedBlockId]);

  return (
    <section className="page-block-list-panel">
      <PageBlockListHeader
        blockCount={orderedBlocks.length}
        disabled={disabled}
        pinnedPresets={pinnedPresets}
        selectedBlockId={selectedBlockId}
        onApplyStylePreset={onApplyStylePreset}
      />
      <div className="page-block-list-scroll" ref={scrollRef}>
        {orderedBlocks.length > 0 ? (
          orderedBlocks.map((block, index) => (
            <PageBlockListRow
              key={block.id}
              block={block}
              disabled={disabled}
              index={index}
              selected={block.id === selectedBlockId}
              onOpenEditor={onOpenEditor}
              onSelect={onSelectBlock}
              onUpdate={onUpdateBlock}
            />
          ))
        ) : (
          <p className="muted-line page-block-list-empty">
            {t("pageBlocks.empty")}
          </p>
        )}
      </div>
    </section>
  );
}

function PageBlockListHeader({
  blockCount,
  disabled,
  pinnedPresets,
  selectedBlockId,
  onApplyStylePreset,
}: {
  blockCount: number;
  disabled: boolean;
  pinnedPresets: readonly BlockStylePresetSummary[];
  selectedBlockId: string | null;
  onApplyStylePreset: (presetId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="page-block-list-panel-header">
      <div>
        <h2>{t("pageBlocks.title")}</h2>
        <span>{t("pageBlocks.count", { count: blockCount })}</span>
      </div>
      {pinnedPresets.length > 0 ? (
        <div
          className="page-block-quick-presets"
          aria-label={t("stylePresets.quickFormats")}
        >
          <span>{t("stylePresets.quickFormats")}</span>
          <div>
            {pinnedPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={preset.missingFont ? "missing-font" : ""}
                disabled={disabled || !selectedBlockId}
                title={
                  preset.missingFont
                    ? t("stylePresets.missingFontShort")
                    : preset.name
                }
                onClick={() => onApplyStylePreset(preset.id)}
              >
                {preset.missingFont ? (
                  <IconAlertTriangle size={13} aria-hidden="true" />
                ) : null}
                <span>{preset.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </header>
  );
}
