import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";
import type { TranslationBlock } from "../../../shared/textTypes";
import { EditorCharacterEffectControls } from "./EditorCharacterEffectControls";
import { EditorCharacterNumberFields } from "./EditorCharacterNumberFields";
import { EditorDisclosure } from "./EditorDisclosure";
import {
  isBlockWideCharacterScope,
  type CharacterFormatField,
  type CharacterFormatTarget,
} from "./editorCharacterFormatTarget";
import { FontSelect } from "./FontSelect";
import { IconButton } from "./ui/IconButton";
import {
  BoldIcon,
  EmphasisMarkIcon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "./ui/icons";
import styles from "./EditorCharacterFormatSection.module.css";

export type EditorCharacterFormatSectionProps = {
  block: TranslationBlock;
  disabled: boolean;
  /** Optimistic block font while a whole-block change round-trips. */
  fontFamilyDraft?: string;
  resolvedFontSizePx: number | null;
  target: CharacterFormatTarget;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onFontFamilyDraftChange?: (fontFamily?: string) => void;
  onOpenFontManager?: () => void;
  /**
   * Block-wide presets and text-area background, fenced off above the letter
   * controls so they never read as part of a letter-range edit.
   */
  blockControls: React.ReactNode;
};

/**
 * Font, emphasis, size, leading, spacing and color for whatever the controller
 * says is being edited: the whole block, a text range, the caret, or several
 * blocks. The target is named in the header; less common effects stay folded.
 */
export function EditorCharacterFormatSection(
  props: EditorCharacterFormatSectionProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <EditorDisclosure
        id="character-format"
        label={t("format.characterFormat.title")}
        headerExtra={<CharacterScopeChip target={props.target} />}
      >
        <div className={styles.body} data-character-scope={props.target.scope}>
          <div className={styles.blockControls}>{props.blockControls}</div>
          <CharacterFontField {...props} />
          <CharacterEmphasisButtons {...props} />
          <EditorCharacterNumberFields {...props} />
        </div>
      </EditorDisclosure>
      <EditorDisclosure
        id="character-effects"
        label={t("format.characterFormat.effects")}
        headerExtra={<ActiveEffectSummary target={props.target} />}
        initiallyOpen={false}
      >
        <EditorCharacterEffectControls
          disabled={props.disabled}
          target={props.target}
        />
      </EditorDisclosure>
    </>
  );
}

function CharacterScopeChip({
  target,
}: {
  target: CharacterFormatTarget;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <span className={styles.scope} data-scope={target.scope} role="status">
      <span>{t("format.characterFormat.scopePrefix")}</span>
      {t(`format.characterFormat.scope.${target.scope}`, {
        count: target.blockCount,
      })}
    </span>
  );
}

const EFFECTS: readonly (readonly [
  CharacterFormatField,
  CharacterFormatField,
  string,
])[] = [
  ["outlineEnabled", "outlineWidthPx", "format.outline"],
  ["outerOutlineEnabled", "outerOutlineWidthPx", "format.outerOutline.enabled"],
  ["shadowEnabled", "shadowOpacityPercent", "format.textEffect.title"],
  ["glowEnabled", "glowOpacityPercent", "format.textGlow.title"],
  ["backgroundEnabled", "backgroundColor", "editor.richText.background"],
];

/** Names the effects that are on (or on for some letters) while folded. */
function ActiveEffectSummary({
  target,
}: {
  target: CharacterFormatTarget;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const active = activeEffectNames(target, t);
  if (!active.length) return null;
  return <span className={styles.effectSummary}>{active.join(" · ")}</span>;
}

function activeEffectNames(
  target: CharacterFormatTarget,
  t: TFunction<"components">,
): string[] {
  return EFFECTS.filter(([enabled, value]) => {
    if (enabled === "backgroundEnabled" && !target.supportsCharacterBackground)
      return false;
    return (
      Boolean(target.values[enabled]) ||
      target.mixed.has(enabled) ||
      (enabled !== "backgroundEnabled" && target.mixed.has(value))
    );
  }).map(([, , labelKey]) => t(labelKey));
}

const EMPHASIS_CONTROLS = [
  ["bold", "format.bold", BoldIcon],
  ["italic", "format.italic", ItalicIcon],
  ["underline", "format.characterFormat.underline", UnderlineIcon],
  ["strikethrough", "format.characterFormat.strikethrough", StrikethroughIcon],
  ["emphasisMark", "format.characterFormat.emphasisMark", EmphasisMarkIcon],
] as const;

function CharacterEmphasisButtons({
  disabled,
  target,
}: EditorCharacterFormatSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className="block-style-group"
      role="group"
      aria-label={t("format.characterFormat.emphasis")}
    >
      {EMPHASIS_CONTROLS.map(([field, labelKey, Icon]) => {
        const mixed = target.mixed.has(field);
        return (
          <IconButton
            key={field}
            size="sm"
            label={t(labelKey)}
            title={t(labelKey)}
            aria-pressed={mixed ? "mixed" : target.values[field]}
            disabled={disabled}
            onClick={() =>
              target.apply({ [field]: mixed || !target.values[field] })
            }
          >
            <Icon size={18} />
          </IconButton>
        );
      })}
    </div>
  );
}

function CharacterFontField({
  disabled,
  fontFamilyDraft,
  onFontFamilyDraftChange,
  onOpenFontManager,
  target,
}: EditorCharacterFormatSectionProps): React.JSX.Element {
  const blockWide = isBlockWideCharacterScope(target.scope);
  const mixed = target.mixed.has("fontFamily");
  return (
    <div className="font-field">
      <FontSelect
        value={blockWide && !mixed ? fontFamilyDraft : target.values.fontFamily}
        disabled={disabled}
        mixed={mixed}
        onOpenManager={onOpenFontManager}
        onChange={(fontFamily) => {
          if (blockWide) onFontFamilyDraftChange?.(fontFamily);
          target.apply({
            fontFamily:
              fontFamily ?? (target.codeMode ? DEFAULT_BLOCK_FONT_ID : null),
          });
        }}
      />
    </div>
  );
}
