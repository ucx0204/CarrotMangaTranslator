import React from "react";
import { useTranslation } from "react-i18next";
import { useFonts } from "../../fonts/useFonts";
import { resolveBlockFontFamily } from "../../lib/fonts";
import type {
  GatherTextDirectFormatModel,
  GatherTextDirectFormatPatch,
  GatherTextDirectFormatValues,
} from "../../lib/gatherTextDirectFormatModel";
import {
  resolvePreviewOutline,
  resolvePreviewValues,
} from "./gatherTextDirectFormatUi";

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
  const values = resolvePreviewValues(model, patch);
  return (
    <BlockFormatPreview
      exampleText={exampleText}
      values={values}
      title={t("gatherText.previewTitle")}
      description={t("gatherText.previewBasis")}
      exampleLabel={t("gatherText.previewTextLabel")}
      placeholder={t("gatherText.previewTextPlaceholder")}
      autoFitLabel={t("gatherText.autoFitBadge")}
      onExampleTextChange={onExampleTextChange}
    />
  );
}

export function BlockFormatPreview({
  autoFitLabel,
  description,
  exampleLabel,
  exampleText,
  placeholder,
  title,
  values,
  onExampleTextChange,
}: {
  autoFitLabel: string;
  description: string;
  exampleLabel: string;
  exampleText: string;
  placeholder: string;
  title: string;
  values: GatherTextDirectFormatValues;
  onExampleTextChange: (value: string) => void;
}): React.JSX.Element {
  const { catalog } = useFonts();
  const textShadow = resolvePreviewOutline(
    values.fontSizePx,
    values.outlineColor ?? "#ffffff",
    values.outlineWidthScale,
  );
  const vertical = values.renderDirection === "vertical";
  const previewText = exampleText || placeholder;
  return (
    <section className="gather-direct-preview">
      <BlockFormatPreviewHeader
        description={description}
        exampleLabel={exampleLabel}
        exampleText={exampleText}
        title={title}
        onExampleTextChange={onExampleTextChange}
      />
      <div
        className="gather-direct-preview-stage"
        data-direction={values.renderDirection}
      >
        <div
          className="gather-direct-preview-rotation"
          style={{
            opacity: values.textOpacity,
            transform: `rotate(${values.rotationDeg}deg)`,
          }}
        >
          <div
            className="gather-direct-preview-text"
            style={
              {
                "--gather-preview-font-size": `${values.fontSizePx}px`,
                color: values.textColor,
                fontFamily: resolveBlockFontFamily(values.fontFamily, catalog),
                fontSize: `${values.fontSizePx}px`,
                fontStyle: values.italic ? "italic" : "normal",
                fontSynthesis: "weight style",
                fontWeight: values.bold ? 700 : 400,
                letterSpacing: values.letterSpacing
                  ? `${values.letterSpacing}em`
                  : undefined,
                lineHeight: values.lineHeight,
                textAlign: values.textAlign,
                textShadow,
                transform: `scaleX(${values.fontWidthScale})`,
                ...resolvePreviewWrappingStyle(values.wordBreak),
                writingMode: vertical ? "vertical-rl" : "horizontal-tb",
              } as React.CSSProperties
            }
          >
            {previewText}
          </div>
        </div>
        {values.autoFitText ? (
          <span className="gather-direct-preview-badge">{autoFitLabel}</span>
        ) : null}
      </div>
    </section>
  );
}

function resolvePreviewWrappingStyle(
  wordBreak: GatherTextDirectFormatValues["wordBreak"],
): React.CSSProperties {
  return {
    overflowWrap: wordBreak === "break-word" ? "anywhere" : "normal",
    wordBreak,
  };
}

function BlockFormatPreviewHeader({
  description,
  exampleLabel,
  exampleText,
  title,
  onExampleTextChange,
}: {
  description: string;
  exampleLabel: string;
  exampleText: string;
  title: string;
  onExampleTextChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="gather-direct-preview-head">
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      <label className="gather-direct-preview-input">
        <span>{exampleLabel}</span>
        <input
          value={exampleText}
          maxLength={120}
          onChange={(event) => onExampleTextChange(event.target.value)}
        />
      </label>
    </div>
  );
}
