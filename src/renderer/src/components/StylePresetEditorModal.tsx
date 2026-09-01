import React from "react";
import { useTranslation } from "react-i18next";
import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  type BlockFormatGroupId,
} from "../../../shared/blockFormat";
import { MAX_BLOCK_STYLE_PRESET_NAME_LENGTH } from "../../../shared/blockStylePresets";
import type { CreateBlockStylePresetInput } from "../../../shared/blockStylePresets";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
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

export function StylePresetRenameModal({
  initialName,
  onClose,
  onSave,
}: {
  initialName: string;
  onClose: () => void;
  onSave: (name: string) => boolean | Promise<boolean>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [name, setName] = React.useState(initialName);
  const [saving, setSaving] = React.useState(false);
  const normalizedName = name.trim();
  const save = async (): Promise<void> => {
    if (!normalizedName || saving) return;
    setSaving(true);
    try {
      if (await onSave(normalizedName)) onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      width="min(420px, 100%)"
      title={t("stylePresets.renameTitle")}
      closeDisabled={saving}
      onClose={onClose}
      footer={
        <ModalActionBar
          actions={
            <ModalActionButtons
              cancel={{
                label: t("common.cancel"),
                disabled: saving,
                onClick: onClose,
              }}
              confirm={{
                label: t("common.save"),
                disabled: !normalizedName || saving,
                onClick: () => void save(),
              }}
            />
          }
        />
      }
    >
      <label className="style-preset-rename-field">
        <span>{t("stylePresets.name")}</span>
        <input
          autoFocus
          maxLength={MAX_BLOCK_STYLE_PRESET_NAME_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
        />
      </label>
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
        <ModalActionButtons
          cancel={{
            label: t("common.cancel"),
            onClick: onClose,
            disabled: saving,
          }}
          confirm={{
            label: t("common.save"),
            onClick: onSave,
            disabled: !valid || saving,
          }}
        />
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
          <CheckboxField
            key={groupId}
            label={t(`formatBatch.groups.${groupId}`)}
            checked={groupIds.includes(groupId)}
            onCheckedChange={(checked) =>
              onChange((current) =>
                updateSelectedGroups(current, groupId, checked),
              )
            }
          />
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
