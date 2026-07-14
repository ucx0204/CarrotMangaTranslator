import React from "react";
import { useTranslation } from "react-i18next";
import {
  isValidLanguageCodeInput,
  KNOWN_TRANSLATION_LANGUAGES,
  MAX_LANGUAGE_CODE_LENGTH,
  PRIMARY_TRANSLATION_LANGUAGE_CODES,
  type ResolvedLanguage,
} from "../../../../shared/translationLanguages";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";

type TranslationLanguageFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "controlsBusy"
  | "setSourceLanguage"
  | "setTargetLanguage"
  | "sourceLanguage"
  | "targetLanguage"
>;

const CUSTOM_LANGUAGE_OPTION = "__custom__";

const PRIMARY_LANGUAGES: ResolvedLanguage[] =
  PRIMARY_TRANSLATION_LANGUAGE_CODES.map(
    (code) =>
      KNOWN_TRANSLATION_LANGUAGES.find(
        (language) => language.code === code,
      ) as ResolvedLanguage,
  ).filter(Boolean);

const OTHER_LANGUAGES: ResolvedLanguage[] = KNOWN_TRANSLATION_LANGUAGES.filter(
  (language) => !PRIMARY_TRANSLATION_LANGUAGE_CODES.includes(language.code),
);

function isPresetLanguageCode(code: string): boolean {
  return KNOWN_TRANSLATION_LANGUAGES.some((language) => language.code === code);
}

function useCustomLanguageMode(value: string, isPreset: boolean) {
  const [customPicked, setCustomPicked] = React.useState(!isPreset);
  const locallyEditedValue = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (locallyEditedValue.current === value) {
      locallyEditedValue.current = null;
      return;
    }
    setCustomPicked(!isPreset);
  }, [isPreset, value]);
  return { customPicked, locallyEditedValue, setCustomPicked };
}

/**
 * 작품 번역 언어쌍(원문 -> 번역) 설정. 앱 UI 언어가 아니라 번역 도메인
 * 설정이며, 모델 제공자(Gemma/Codex/API) 선택과 독립이다.
 */
export function TranslationLanguageFields({
  controlsBusy,
  setSourceLanguage,
  setTargetLanguage,
  sourceLanguage,
  targetLanguage,
}: TranslationLanguageFieldsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const swapLanguages = () => {
    setSourceLanguage(targetLanguage);
    setTargetLanguage(sourceLanguage);
  };

  return (
    <div className="settings-language-row">
      <LanguageField
        label={t("settings.translation.source")}
        value={sourceLanguage}
        disabled={controlsBusy}
        onChange={setSourceLanguage}
      />
      <button
        type="button"
        className="settings-language-swap"
        onClick={swapLanguages}
        disabled={controlsBusy}
        title={t("settings.translation.swapTitle")}
        aria-label={t("settings.translation.swapAria")}
      >
        ⇄
      </button>
      <LanguageField
        label={t("settings.translation.target")}
        value={targetLanguage}
        disabled={controlsBusy}
        onChange={setTargetLanguage}
      />
    </div>
  );
}

function LanguageField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (code: string) => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation("components");
  const isPreset = isPresetLanguageCode(value);
  // 프리셋 값에서 "직접 입력"을 고른 순간을 기억한다. 입력 중 값이 우연히
  // 프리셋 코드와 일치해도(예: "ja"까지 타이핑) 입력창이 사라지지 않는다.
  const { customPicked, locallyEditedValue, setCustomPicked } =
    useCustomLanguageMode(value, isPreset);
  const showCustomInput = customPicked || !isPreset;
  const codeValid = isValidLanguageCodeInput(value);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const displayNames = React.useMemo(
    () => createLanguageDisplayNames(locale),
    [locale],
  );
  const otherLanguages = React.useMemo(() => {
    const collator = new Intl.Collator(locale);
    return OTHER_LANGUAGES.slice().sort((left, right) =>
      collator.compare(
        getLanguageDisplayName(displayNames, left),
        getLanguageDisplayName(displayNames, right),
      ),
    );
  }, [displayNames, locale]);

  return (
    <div className="settings-language-field">
      <label>
        {label}
        <LanguageSelect
          displayNames={displayNames}
          disabled={disabled}
          onCustomPick={() => setCustomPicked(true)}
          onPresetPick={(nextValue) => {
            locallyEditedValue.current = null;
            setCustomPicked(false);
            onChange(nextValue);
          }}
          otherLanguages={otherLanguages}
          value={showCustomInput ? CUSTOM_LANGUAGE_OPTION : value}
        />
      </label>
      {showCustomInput ? (
        <>
          <input
            type="text"
            value={value}
            disabled={disabled}
            spellCheck={false}
            maxLength={MAX_LANGUAGE_CODE_LENGTH}
            placeholder={t("settings.translation.codePlaceholder")}
            aria-label={t("settings.translation.customCodeAria", { label })}
            onChange={(event) => {
              const nextValue = event.target.value.trim();
              locallyEditedValue.current = nextValue;
              onChange(nextValue);
            }}
          />
          {!codeValid ? (
            <p className="muted-line settings-language-error">
              {t("settings.validation.languageCode")}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function LanguageSelect({
  displayNames,
  disabled,
  onCustomPick,
  onPresetPick,
  otherLanguages,
  value,
}: {
  displayNames: Intl.DisplayNames | null;
  disabled: boolean;
  onCustomPick: () => void;
  onPresetPick: (value: string) => void;
  otherLanguages: ResolvedLanguage[];
  value: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value === CUSTOM_LANGUAGE_OPTION) {
          onCustomPick();
          return;
        }
        onPresetPick(event.target.value);
      }}
    >
      <optgroup label={t("settings.translation.primaryLanguages")}>
        {PRIMARY_LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {getLanguageDisplayName(displayNames, language)}
          </option>
        ))}
      </optgroup>
      <optgroup label={t("settings.translation.otherLanguages")}>
        {otherLanguages.map((language) => (
          <option key={language.code} value={language.code}>
            {getLanguageDisplayName(displayNames, language)}
          </option>
        ))}
      </optgroup>
      <option value={CUSTOM_LANGUAGE_OPTION}>
        {t("settings.translation.custom")}
      </option>
    </select>
  );
}

function createLanguageDisplayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: "language" });
  } catch (_error) {
    return null;
  }
}

function getLanguageDisplayName(
  displayNames: Intl.DisplayNames | null,
  language: ResolvedLanguage,
): string {
  return displayNames?.of(language.code) ?? language.labelKo ?? language.code;
}
