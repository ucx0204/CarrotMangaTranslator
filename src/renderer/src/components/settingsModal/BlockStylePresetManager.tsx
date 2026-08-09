import React from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockFormatDefaults } from "../../../../shared/blockFormat";
import type { BlockStylePreset } from "../../../../shared/blockStylePresets";
import { useFonts } from "../../fonts/useFonts";
import {
  PresetManagerScreen,
  type PresetFontDetail,
} from "./stylePresetManager/PresetManagerScreen";

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
  const [managerOpen, setManagerOpen] = React.useState(false);
  const fontDetails = React.useMemo(
    () =>
      new Map<string, PresetFontDetail>(
        fontOptions.map((font) => [
          font.id,
          { cssFamily: font.cssFamily, label: font.label },
        ]),
      ),
    [fontOptions],
  );

  return (
    <section className="style-preset-manager">
      <div className="style-preset-manager-heading">
        <h3>{t("stylePresets.title")}</h3>
        <span className="style-preset-manager-count" aria-hidden="true">
          {presets.length}
        </span>
      </div>
      <button
        type="button"
        className="style-preset-manager-open"
        onClick={() => setManagerOpen(true)}
      >
        <span>{t("stylePresets.manage")}</span>
        <IconChevronRight size={16} aria-hidden="true" />
      </button>
      {managerOpen ? (
        <PresetManagerScreen
          defaults={defaults}
          fontDetails={fontDetails}
          presets={presets}
          onChange={onChange}
          onClose={() => setManagerOpen(false)}
        />
      ) : null}
    </section>
  );
}
