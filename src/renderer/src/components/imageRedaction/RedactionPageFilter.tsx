import React from "react";
import { useTranslation } from "react-i18next";
import {
  redactionViewSchema,
  type RedactionView,
} from "../../../../shared/imageRedactionWorkspace";
import { Select } from "../ui/Select";

export function RedactionPageFilter({
  value,
  disabled,
  onChange,
}: {
  value: RedactionView["filter"];
  disabled: boolean;
  onChange: (filter: RedactionView["filter"]) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Select
      ariaLabel={t("manualRedaction.filter")}
      value={value}
      disabled={disabled}
      options={redactionViewSchema.shape.filter.options.map((value) => ({
        value,
        label: t(`manualRedaction.filter_${value}`),
      }))}
      onValueChange={(value) => {
        const filter = redactionViewSchema.shape.filter.parse(value);
        onChange(filter);
      }}
    />
  );
}
