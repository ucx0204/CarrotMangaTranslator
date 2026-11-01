import { useTranslation } from "react-i18next";
import React from "react";
import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";
import { ConditionalBatchSpeakersContext } from "./conditionalBatchSpeakers";
import { FontSelect } from "./FontSelect";
import { Field } from "./ui/Field";
import { Select } from "./ui/Select";

export function ConditionalBatchIdentityField({
  field,
  label,
  ariaLabel = label,
  value,
  useDefaultFont = false,
  onChange,
}: {
  field: "speakerId" | "fontFamily";
  label: string;
  ariaLabel?: string;
  value: string;
  useDefaultFont?: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  useTranslation();
  if (field === "speakerId") {
    return <SpeakerField label={label} value={value} onChange={onChange} />;
  }
  return (
    <Field as="div" label={label}>
      <FontSelect
        ariaLabel={ariaLabel}
        preserveFontId
        value={value || undefined}
        onChange={(font) =>
          onChange(font ?? (useDefaultFont ? DEFAULT_BLOCK_FONT_ID : ""))
        }
      />
    </Field>
  );
}

function SpeakerField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const catalog = React.useContext(ConditionalBatchSpeakersContext);
  const hintId = React.useId();
  const options = [...catalog.options];
  if (value && !options.some((option) => option.value === value)) {
    options.push({
      value,
      label: t("batchEditorMessages.unnamed", { p0: value }),
      tooltip: value,
      group: t("batchEditorCopy.speakerSavedInThisRule"),
      description: t(
        "batchEditorCopy.noCharacterInformationWasFoundForThisWork",
      ),
      searchText: value,
    });
  }
  const status = catalog.error
    ? t("batchEditorCopy.couldNotLoadSpeakerNamesReopenTheWindowTo")
    : !catalog.ready
      ? t("batchEditorCopy.loadingSpeakerNames")
      : catalog.options.length === 0
        ? t(
            "batchEditorCopy.noRegisteredCharactersOrLinkedSpeakersCheckTheWork",
          )
        : null;
  return (
    <Field
      as="div"
      label={label}
      hint={
        status || catalog.unassignedCount > 0 ? (
          <span id={hintId}>
            {status}
            {catalog.unassignedCount > 0
              ? t("batchEditorMessages.dialogueWithoutASpeakerInThisChapter", {
                  p0: catalog.unassignedCount,
                })
              : null}
          </span>
        ) : undefined
      }
    >
      <Select
        ariaLabel={label}
        ariaDescribedBy={
          status || catalog.unassignedCount > 0 ? hintId : undefined
        }
        searchable
        searchPlaceholder={t("batchEditorCopy.searchSpeakerNamesOrAliases")}
        placeholder={t("batchEditorCopy.selectSpeaker")}
        value={value}
        options={options}
        onValueChange={onChange}
      />
    </Field>
  );
}
