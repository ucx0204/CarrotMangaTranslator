import React from "react";
import { useTranslation } from "react-i18next";
import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  type BlockFormatGroupId,
} from "../../../shared/blockFormat";
import { MAX_BLOCK_STYLE_PRESET_NAME_LENGTH } from "../../../shared/blockStylePresets";
import type { CreateBlockStylePresetInput } from "../../../shared/blockStylePresets";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { CheckboxField } from "./ui/CheckboxField";

export type StylePresetDraft = CreateBlockStylePresetInput;

type StylePresetEditorModalProps = {
  initialDraft?: StylePresetDraft;
  initialName?: string;
  title?: string;
  onClose: () => void;
  onSave: (draft: StylePresetDraft) => boolean | Promise<boolean>;
};

export function StylePresetEditorModal({
  initialDraft,
  initialName = "",
  title,
  onClose,
  onSave,
}: StylePresetEditorModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [name, setName] = React.useState(
    () => initialDraft?.name ?? initialName,
  );
  const [pinned, setPinned] = React.useState(
    () => initialDraft?.pinned ?? true,
  );
  const [groupIds, setGroupIds] = React.useState<BlockFormatGroupId[]>(() =>
    initialDraft ? [...initialDraft.groupIds] : [...ALL_BLOCK_FORMAT_GROUP_IDS],
  );
  const [saving, setSaving] = React.useState(false);
  const valid = Boolean(name.trim() && groupIds.length > 0);
  const save = async (): Promise<void> => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      if (
        await onSave({
          name: name.trim(),
          pinned,
          groupIds,
        })
      ) {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      width="min(560px, 100%)"
      ariaLabel={title ?? t("stylePresets.createTitle")}
      title={title ?? t("stylePresets.createTitle")}
      closeDisabled={saving}
      onClose={onClose}
      footer={
        <StylePresetEditorFooter
          saving={saving}
          valid={valid}
          onClose={onClose}
          onSave={() => void save()}
        />
      }
    >
      <StylePresetEditorForm
        groupIds={groupIds}
        name={name}
        pinned={pinned}
        onGroupIdsChange={setGroupIds}
        onNameChange={setName}
        onPinnedChange={setPinned}
        onSubmit={() => void save()}
      />
    </Modal>
  );
}

function StylePresetEditorFooter({
  saving,
  valid,
  onClose,
  onSave,
}: {
  saving: boolean;
  valid: boolean;
  onClose: () => void;
  onSave: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      actions={
        <>
          <button
            type="button"
            className="style-preset-action ghost"
            disabled={saving}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="style-preset-action primary"
            disabled={!valid || saving}
            onClick={onSave}
          >
            {t("common.save")}
          </button>
        </>
      }
    />
  );
}

function StylePresetEditorForm({
  groupIds,
  name,
  pinned,
  onGroupIdsChange,
  onNameChange,
  onPinnedChange,
  onSubmit,
}: {
  groupIds: BlockFormatGroupId[];
  name: string;
  pinned: boolean;
  onGroupIdsChange: React.Dispatch<React.SetStateAction<BlockFormatGroupId[]>>;
  onNameChange: (name: string) => void;
  onPinnedChange: (pinned: boolean) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-preset-editor-form">
      <label>
        <span>{t("stylePresets.name")}</span>
        <input
          autoFocus
          maxLength={MAX_BLOCK_STYLE_PRESET_NAME_LENGTH}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      </label>
      <StylePresetGroupFields groupIds={groupIds} onChange={onGroupIdsChange} />
      <CheckboxField
        className="style-preset-pin-toggle"
        label={t("stylePresets.pinQuick")}
        checked={pinned}
        onCheckedChange={onPinnedChange}
      />
    </div>
  );
}

function StylePresetGroupFields({
  groupIds,
  onChange,
}: {
  groupIds: BlockFormatGroupId[];
  onChange: React.Dispatch<React.SetStateAction<BlockFormatGroupId[]>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <fieldset>
      <legend>{t("stylePresets.groups")}</legend>
      <div className="style-preset-group-grid">
        {ALL_BLOCK_FORMAT_GROUP_IDS.map((groupId) => (
          <label key={groupId}>
            <input
              type="checkbox"
              checked={groupIds.includes(groupId)}
              onChange={(event) =>
                onChange((current) =>
                  updateSelectedGroups(current, groupId, event.target.checked),
                )
              }
            />
            <span>{t(`formatBatch.groups.${groupId}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function updateSelectedGroups(
  current: BlockFormatGroupId[],
  groupId: BlockFormatGroupId,
  checked: boolean,
): BlockFormatGroupId[] {
  return checked
    ? ALL_BLOCK_FORMAT_GROUP_IDS.filter(
        (candidate) => candidate === groupId || current.includes(candidate),
      )
    : current.filter((candidate) => candidate !== groupId);
}
