import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GatherTextDirectFormatModel,
  GatherTextDirectFormatPatch,
} from "../../lib/gatherTextDirectFormatModel";
import { BlockFormatPreview } from "../blockFormat/BlockFormatPreview";
import { resolvePreviewValues } from "./gatherTextDirectFormatUi";

export function GatherTextDirectFormatPreview({
  exampleText,
  model,
  patch,
  onExampleTextChange,
}: {
  exampleText: string;
  model: GatherTextDirectFormatModel;
  patch: GatherTextDirectFormatPatch;
  onExampleTextChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <BlockFormatPreview
      exampleText={exampleText}
      values={resolvePreviewValues(model, patch)}
      title={t("gatherText.previewTitle")}
      description={t("gatherText.previewBasis")}
      exampleLabel={t("gatherText.previewTextLabel")}
      placeholder={t("gatherText.previewTextPlaceholder")}
      autoFitLabel={t("gatherText.autoFitBadge")}
      onExampleTextChange={onExampleTextChange}
    />
  );
}
