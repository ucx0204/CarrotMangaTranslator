import { useTranslation } from "react-i18next";
import type { BlockStylePreset } from "../../../shared/blockStylePresets";

import {
  type ConditionalBatchActionV2,
  type ConditionalBatchApplyStylePresetActionV2,
} from "../../../shared/conditionalBatchRules";

import { Select } from "./ui/Select";

import { Field } from "./ui/Field";

import styles from "./ConditionalBatchEditor.module.css";

import { createPresetAction } from "./conditionalBatchActionModel";

export function PresetActionEditor({
  action,
  presets,
  onChange,
}: {
  action: ConditionalBatchApplyStylePresetActionV2;
  presets: readonly BlockStylePreset[];
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <>
      <Field as="div" label={t("batchEditorCopy.stylePreset")}>
        <Select
          ariaLabel={t("batchEditorCopy.stylePreset")}
          value={action.presetId ?? ""}
          options={[
            ...(presets.some((preset) => preset.id === action.presetId)
              ? []
              : [
                  {
                    value: action.presetId ?? "",
                    label: t("batchEditorMessages.savedSnapshot", {
                      p0: action.presetName,
                    }),
                  },
                ]),
            ...presets.map((preset) => ({
              value: preset.id,
              label: preset.name,
            })),
          ]}
          onValueChange={(id) => {
            const preset = presets.find((entry) => entry.id === id);
            if (preset) {
              onChange({
                ...action,
                ...createPresetAction(preset, action.id),
                enabled: action.enabled,
              });
            }
          }}
        />
      </Field>
      <div className={styles.snapshotMeta}>
        {t("batchEditorCopy.savedValue")}
        {action.groupIds.join(", ")}
      </div>
    </>
  );
}
