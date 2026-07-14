import React from "react";
import { useTranslation } from "react-i18next";
import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  BLOCK_FORMAT_GROUPS,
  type BlockFormatGroupId,
} from "../../../shared/blockFormat";
import type { FormatApplyScope } from "../hooks/useBlockEditingActions";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { SelectionCard, SelectionSurface } from "./ui/SelectionCard";

type FormatBatchApplyModalProps = {
  selectedBlockCount: number;
  disableChapterApply: boolean;
  onApply: (scope: FormatApplyScope, groupIds: BlockFormatGroupId[]) => void;
  onClose: () => void;
};

export function FormatBatchApplyModal({
  selectedBlockCount,
  disableChapterApply,
  onApply,
  onClose,
}: FormatBatchApplyModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const selectionAvailable = selectedBlockCount > 1;
  const [groupIds, setGroupIds] = React.useState<Set<BlockFormatGroupId>>(
    () => new Set(ALL_BLOCK_FORMAT_GROUP_IDS),
  );
  const [scope, setScope] = React.useState<FormatApplyScope>(
    selectionAvailable ? "selection" : "page",
  );
  const canApply = groupIds.size > 0;

  const handleApply = (): void => {
    if (!canApply) {
      return;
    }
    onApply(scope, [...groupIds]);
    onClose();
  };

  return (
    <Modal
      title={t("formatBatch.title")}
      onClose={onClose}
      closeOnBackdrop
      size="sm"
      ariaLabel={t("formatBatch.title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={handleApply} disabled={!canApply}>
            {t("common.apply")}
          </Button>
        </>
      }
    >
      <p className="muted-line modal-note">{t("formatBatch.description")}</p>
      <FormatGroupChecklist groupIds={groupIds} onChange={setGroupIds} />
      <FormatScopeSelector
        scope={scope}
        selectedBlockCount={selectedBlockCount}
        selectionAvailable={selectionAvailable}
        disableChapterApply={disableChapterApply}
        onChange={setScope}
      />
    </Modal>
  );
}

function FormatGroupChecklist({
  groupIds,
  onChange,
}: {
  groupIds: Set<BlockFormatGroupId>;
  onChange: (next: Set<BlockFormatGroupId>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const allChecked = groupIds.size === BLOCK_FORMAT_GROUPS.length;
  const toggleGroup = (id: BlockFormatGroupId): void => {
    const next = new Set(groupIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next);
  };
  return (
    <div className="format-apply-section">
      <div className="format-apply-section-head">
        <span>{t("formatBatch.items")}</span>
        <button
          type="button"
          className="format-apply-toggle-all"
          onClick={() =>
            onChange(
              allChecked ? new Set() : new Set(ALL_BLOCK_FORMAT_GROUP_IDS),
            )
          }
        >
          {t(allChecked ? "common.clearAll" : "common.selectAll")}
        </button>
      </div>
      <div className="format-apply-grid">
        {BLOCK_FORMAT_GROUPS.map((group) => (
          <SelectionCard
            key={group.id}
            className="format-apply-item"
            variant="row"
            inputType="checkbox"
            checked={groupIds.has(group.id)}
            onChange={() => toggleGroup(group.id)}
          >
            {t(`formatBatch.groups.${group.id}`)}
          </SelectionCard>
        ))}
      </div>
    </div>
  );
}

function FormatScopeSelector({
  scope,
  selectedBlockCount,
  selectionAvailable,
  disableChapterApply,
  onChange,
}: {
  scope: FormatApplyScope;
  selectedBlockCount: number;
  selectionAvailable: boolean;
  disableChapterApply: boolean;
  onChange: (scope: FormatApplyScope) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="format-apply-section">
      <div className="format-apply-section-head">
        <span>{t("formatBatch.scope")}</span>
      </div>
      <div className="format-apply-scope">
        <ScopeButton
          active={scope === "selection"}
          disabled={!selectionAvailable}
          label={t("formatBatch.selectedBlocks", {
            count: selectedBlockCount,
          })}
          title={
            selectionAvailable ? undefined : t("formatBatch.multiSelectHint")
          }
          onClick={() => onChange("selection")}
        />
        <ScopeButton
          active={scope === "page"}
          label={t("formatBatch.thisPage")}
          onClick={() => onChange("page")}
        />
        <ScopeButton
          active={scope === "chapter"}
          disabled={disableChapterApply}
          label={t("formatBatch.entireChapter")}
          title={
            disableChapterApply ? t("formatBatch.chapterDisabled") : undefined
          }
          onClick={() => onChange("chapter")}
        />
      </div>
    </div>
  );
}

function ScopeButton({
  active,
  disabled = false,
  label,
  title,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  title?: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <SelectionSurface
      as="button"
      type="button"
      className="format-apply-scope-button"
      selected={active}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      {label}
    </SelectionSurface>
  );
}
