import React from "react";
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
)
  .slice()
  .sort((left, right) => left.labelKo.localeCompare(right.labelKo, "ko"));

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
  const swapLanguages = () => {
    setSourceLanguage(targetLanguage);
    setTargetLanguage(sourceLanguage);
  };

  return (
    <div className="settings-field-stack">
      <span>번역 언어</span>
      <div className="settings-language-row">
        <LanguageField
          label="원문 언어"
          value={sourceLanguage}
          disabled={controlsBusy}
          onChange={setSourceLanguage}
        />
        <button
          type="button"
          className="settings-language-swap"
          onClick={swapLanguages}
          disabled={controlsBusy}
          title="원문 언어와 번역 언어를 서로 바꿉니다"
          aria-label="원문 언어와 번역 언어 바꾸기"
        >
          ⇄
        </button>
        <LanguageField
          label="번역 언어"
          value={targetLanguage}
          disabled={controlsBusy}
          onChange={setTargetLanguage}
        />
      </div>
      <p className="muted-line modal-note">
        기본값은 기존과 같은 일본어 → 한국어입니다. 목록에 없는 언어는 직접
        입력으로 언어 코드를 넣을 수 있고, 언어쌍에 따라 모델의 이미지 입력
        성능과 OCR 언어 지원에 따른 품질 차이가 있을 수 있습니다.
      </p>
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
  const isPreset = isPresetLanguageCode(value);
  // 프리셋 값에서 "직접 입력"을 고른 순간을 기억한다. 입력 중 값이 우연히
  // 프리셋 코드와 일치해도(예: "ja"까지 타이핑) 입력창이 사라지지 않는다.
  const { customPicked, locallyEditedValue, setCustomPicked } =
    useCustomLanguageMode(value, isPreset);
  const showCustomInput = customPicked || !isPreset;
  const codeValid = isValidLanguageCodeInput(value);

  return (
    <div className="settings-language-field">
      <label>
        {label}
        <select
          value={showCustomInput ? CUSTOM_LANGUAGE_OPTION : value}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === CUSTOM_LANGUAGE_OPTION) {
              setCustomPicked(true);
              return;
            }
            locallyEditedValue.current = null;
            setCustomPicked(false);
            onChange(event.target.value);
          }}
        >
          <optgroup label="주요 언어">
            {PRIMARY_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.labelKo}
              </option>
            ))}
          </optgroup>
          <optgroup label="기타 언어">
            {OTHER_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.labelKo}
              </option>
            ))}
          </optgroup>
          <option value={CUSTOM_LANGUAGE_OPTION}>직접 입력…</option>
        </select>
      </label>
      {showCustomInput ? (
        <>
          <input
            type="text"
            value={value}
            disabled={disabled}
            spellCheck={false}
            maxLength={MAX_LANGUAGE_CODE_LENGTH}
            placeholder="언어 코드 (예: eo, zh-Hans)"
            aria-label={`${label} 코드 직접 입력`}
            onChange={(event) => {
              const nextValue = event.target.value.trim();
              locallyEditedValue.current = nextValue;
              onChange(nextValue);
            }}
          />
          {!codeValid ? (
            <p className="muted-line settings-language-error">
              언어 코드는 en, ja, zh-Hans, pt-BR 같은 형식이어야 합니다.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
