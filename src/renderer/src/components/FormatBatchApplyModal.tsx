import React from "react";
import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  BLOCK_FORMAT_GROUPS,
  type BlockFormatGroupId,
} from "../../../shared/blockFormat";
import type { FormatApplyScope } from "../hooks/useBlockEditingActions";
import { Button, Modal } from "./ui";

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
      title="서식 일괄 적용"
      onClose={onClose}
      closeOnBackdrop
      size="sm"
      ariaLabel="서식 일괄 적용"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={handleApply} disabled={!canApply}>
            적용
          </Button>
        </>
      }
    >
      <p className="muted-line modal-note">
        선택한 블록의 서식을 기준으로 아래 항목을 적용합니다.
      </p>
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
        <span>적용할 항목</span>
        <button
          type="button"
          className="format-apply-toggle-all"
          onClick={() =>
            onChange(
              allChecked ? new Set() : new Set(ALL_BLOCK_FORMAT_GROUP_IDS),
            )
          }
        >
          {allChecked ? "전체 해제" : "전체 선택"}
        </button>
      </div>
      <div className="format-apply-grid">
        {BLOCK_FORMAT_GROUPS.map((group) => (
          <label key={group.id} className="format-apply-item">
            <input
              type="checkbox"
              checked={groupIds.has(group.id)}
              onChange={() => toggleGroup(group.id)}
            />
            {group.label}
          </label>
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
  return (
    <div className="format-apply-section">
      <div className="format-apply-section-head">
        <span>적용 범위</span>
      </div>
      <div className="format-apply-scope">
        <ScopeButton
          active={scope === "selection"}
          disabled={!selectionAvailable}
          label={`선택한 블록 ${selectedBlockCount}개`}
          title={
            selectionAvailable
              ? undefined
              : "Ctrl+클릭으로 여러 블록을 선택하세요."
          }
          onClick={() => onChange("selection")}
        />
        <ScopeButton
          active={scope === "page"}
          label="이 페이지"
          onClick={() => onChange("page")}
        />
        <ScopeButton
          active={scope === "chapter"}
          disabled={disableChapterApply}
          label="이 화 전체"
          title={
            disableChapterApply
              ? "작업 중에는 이 화 전체 적용을 사용할 수 없습니다."
              : undefined
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
    <button
      type="button"
      className="format-apply-scope-button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
