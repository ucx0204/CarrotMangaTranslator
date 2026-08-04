import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { Button } from "./ui/Button";

export function AutomaticFontMatchNotice({
  block,
  disabled,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const match = block.automaticFontMatch;
  if (!match) return null;
  const confidence = Math.round(match.confidence * 100);
  return (
    <div className="automatic-font-match-notice" role="status">
      <div className="automatic-font-match-summary">
        <span className="automatic-font-match-badge">
          {t("format.autoFont.badge")}
        </span>
        <strong>{resolveAutomaticFontRoleLabel(match.role, t)}</strong>
        <span>{confidence}%</span>
      </div>
      <p>{t(`format.autoFont.sources.${match.source}`)}</p>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => onUpdate(buildAutomaticFontRollbackPatch(block))}
      >
        {t("format.autoFont.rollback")}
      </Button>
    </div>
  );
}

function buildAutomaticFontRollbackPatch(
  block: TranslationBlock,
): Partial<TranslationBlock> {
  const previous = block.automaticFontMatch?.previousStyle;
  if (!previous) return {};
  return {
    automaticFontMatch: undefined,
    fontFamily: previous.fontFamily ?? undefined,
    bold: previous.bold ?? undefined,
    italic: previous.italic ?? undefined,
    outlineWidthScale: previous.outlineWidthScale ?? undefined,
    ...(previous.textColor === undefined
      ? {}
      : { textColor: previous.textColor }),
    ...("outlineColor" in previous
      ? { outlineColor: previous.outlineColor ?? undefined }
      : {}),
  };
}

function resolveAutomaticFontRoleLabel(
  role: NonNullable<TranslationBlock["fontRole"]>,
  t: TFunction<"components">,
): string {
  if (role === "dialogue") return t("format.autoFont.roles.dialogue");
  if (role === "narration") return t("format.autoFont.roles.narration");
  if (role === "thought") return t("format.autoFont.roles.thought");
  if (role === "aside_balloon_edge") {
    return t("format.autoFont.roles.aside");
  }
  if (
    role === "emphasis_dialogue" ||
    role === "shout" ||
    role.startsWith("sfx_")
  ) {
    return t("format.autoFont.roles.expressive");
  }
  return t("format.autoFont.roles.other");
}
