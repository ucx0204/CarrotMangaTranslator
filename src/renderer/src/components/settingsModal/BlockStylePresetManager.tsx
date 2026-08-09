import React from "react";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockFormatDefaults } from "../../../../shared/blockFormat";
import {
  createBlockStylePresetFromDefaults,
  createBlockStylePresetId,
  MAX_BLOCK_STYLE_PRESET_NAME_LENGTH,
  MAX_BLOCK_STYLE_PRESETS,
  summarizeBlockStylePresets,
  type BlockStylePreset,
} from "../../../../shared/blockStylePresets";
import { useFonts } from "../../fonts/useFonts";
import { StylePresetEditorModal } from "../StylePresetEditorModal";
import { IconButton } from "../ui/IconButton";

export function BlockStylePresetManager({
  defaults,
  presets,
  onChange,
}: {
  defaults: BlockFormatDefaults;
  presets: BlockStylePreset[];
  onChange: React.Dispatch<React.SetStateAction<BlockStylePreset[]>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { options: fontOptions } = useFonts();
  const [createOpen, setCreateOpen] = React.useState(false);
  const summaries = summarizeBlockStylePresets(
    presets,
    new Set(fontOptions.map((font) => font.id)),
  );
  const missingFontById = new Map(
    summaries.map((summary) => [summary.id, summary.missingFont]),
  );

  return (
    <section className="style-preset-manager">
      <header>
        <div>
          <h3>{t("stylePresets.managerTitle")}</h3>
          <p>{t("stylePresets.managerDescription")}</p>
        </div>
        <button
          type="button"
          className="style-preset-action small"
          disabled={presets.length >= MAX_BLOCK_STYLE_PRESETS}
          onClick={() => setCreateOpen(true)}
        >
          <IconPlus size={15} aria-hidden="true" />
          {t("stylePresets.createFromDefaults")}
        </button>
      </header>
      <PresetManagerList
        missingFontById={missingFontById}
        presets={presets}
        onChange={onChange}
      />
      {createOpen ? (
        <StylePresetEditorModal
          onClose={() => setCreateOpen(false)}
          onSave={(draft) => {
            onChange((current) =>
              current.length >= MAX_BLOCK_STYLE_PRESETS
                ? current
                : [
                    ...current,
                    createBlockStylePresetFromDefaults({ defaults, ...draft }),
                  ],
            );
            return true;
          }}
        />
      ) : null}
    </section>
  );
}

function PresetManagerList({
  missingFontById,
  presets,
  onChange,
}: {
  missingFontById: ReadonlyMap<string, boolean>;
  presets: BlockStylePreset[];
  onChange: React.Dispatch<React.SetStateAction<BlockStylePreset[]>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (presets.length === 0) {
    return (
      <div className="style-preset-manager-list">
        <p className="muted-line">{t("stylePresets.emptyManager")}</p>
      </div>
    );
  }
  return (
    <div className="style-preset-manager-list">
      {presets.map((preset, index) => (
        <PresetManagerRow
          key={preset.id}
          index={index}
          missingFont={missingFontById.get(preset.id) ?? false}
          preset={preset}
          total={presets.length}
          onDelete={() =>
            onChange((current) =>
              current.filter((item) => item.id !== preset.id),
            )
          }
          onDuplicate={() =>
            onChange((current) =>
              appendDuplicatePreset(
                current,
                preset,
                t("stylePresets.duplicateName", { name: preset.name }),
              ),
            )
          }
          onMove={(direction) =>
            onChange((current) => movePreset(current, preset.id, direction))
          }
          onPatch={(patch) =>
            onChange((current) =>
              current.map((item) =>
                item.id === preset.id ? { ...item, ...patch } : item,
              ),
            )
          }
        />
      ))}
    </div>
  );
}

function PresetManagerRow({
  index,
  missingFont,
  preset,
  total,
  onDelete,
  onDuplicate,
  onMove,
  onPatch,
}: {
  index: number;
  missingFont: boolean;
  preset: BlockStylePreset;
  total: number;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
  onPatch: (patch: Partial<BlockStylePreset>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <article className="style-preset-manager-row">
      <div className="style-preset-manager-name">
        <input
          aria-label={t("stylePresets.name")}
          defaultValue={preset.name}
          maxLength={80}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name) onPatch({ name });
            else event.target.value = preset.name;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span>
          {t("stylePresets.groupCount", { count: preset.groupIds.length })}
        </span>
        {missingFont ? (
          <span className="style-preset-font-warning">
            <IconAlertTriangle size={13} aria-hidden="true" />
            {t("stylePresets.missingFontShort")}
          </span>
        ) : null}
      </div>
      <label className="style-preset-manager-pin">
        <input
          type="checkbox"
          checked={preset.pinned}
          onChange={(event) => onPatch({ pinned: event.target.checked })}
        />
        <span>{t("stylePresets.pinned")}</span>
      </label>
      <PresetManagerRowActions
        index={index}
        total={total}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onMove={onMove}
      />
    </article>
  );
}

function PresetManagerRowActions({
  index,
  total,
  onDelete,
  onDuplicate,
  onMove,
}: {
  index: number;
  total: number;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-preset-manager-actions">
      <IconButton
        size="sm"
        label={t("stylePresets.moveUp")}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <IconArrowUp size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        label={t("stylePresets.moveDown")}
        disabled={index === total - 1}
        onClick={() => onMove(1)}
      >
        <IconArrowDown size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        label={t("common.duplicate")}
        disabled={total >= MAX_BLOCK_STYLE_PRESETS}
        onClick={onDuplicate}
      >
        <IconCopy size={15} aria-hidden="true" />
      </IconButton>
      <IconButton size="sm" label={t("common.delete")} onClick={onDelete}>
        <IconTrash size={15} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function appendDuplicatePreset(
  presets: BlockStylePreset[],
  preset: BlockStylePreset,
  duplicateName: string,
): BlockStylePreset[] {
  if (presets.length >= MAX_BLOCK_STYLE_PRESETS) return presets;
  return [
    ...presets,
    {
      ...preset,
      id: createBlockStylePresetId(),
      name: duplicateName.slice(0, MAX_BLOCK_STYLE_PRESET_NAME_LENGTH),
      groupIds: [...preset.groupIds],
      format: { ...preset.format },
    },
  ];
}

function movePreset(
  presets: BlockStylePreset[],
  presetId: string,
  direction: -1 | 1,
): BlockStylePreset[] {
  const index = presets.findIndex((preset) => preset.id === presetId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= presets.length) {
    return presets;
  }
  const next = [...presets];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}
