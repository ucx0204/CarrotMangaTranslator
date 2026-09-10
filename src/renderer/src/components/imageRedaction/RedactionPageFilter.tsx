import React from "react";
import { useTranslation } from "react-i18next";
import { redactionViewSchema } from "../../../../shared/imageRedactionWorkspace";
import { Select } from "../ui/Select";
import { changeRedactionView } from "./redactionWorkspaceModel";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";

export function RedactionPageFilter({
  form,
}: {
  form: RedactionWorkspaceController;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Select
      ariaLabel={t("manualRedaction.filter")}
      value={form.state.workspace.view.filter}
      disabled={form.busy || form.drawing}
      options={redactionViewSchema.shape.filter.options.map((value) => ({
        value,
        label: t(`manualRedaction.filter_${value}`),
      }))}
      onValueChange={(value) => {
        const filter = redactionViewSchema.shape.filter.parse(value);
        form.commit((current) =>
          changeRedactionView(current, { filter, gridOffset: 0 }),
        );
      }}
    />
  );
}
