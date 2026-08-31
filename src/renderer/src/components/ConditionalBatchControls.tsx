import type { ComponentProps } from "react";
import { Button as UiButton } from "./ui/Button";
import { CheckboxField as UiCheckboxField } from "./ui/CheckboxField";
import { Select as UiSelect } from "./ui/Select";

export function Button(props: ComponentProps<typeof UiButton>) {
  return <UiButton {...props} />;
}

export function CheckboxField(props: ComponentProps<typeof UiCheckboxField>) {
  return <UiCheckboxField {...props} />;
}

export function Select(props: ComponentProps<typeof UiSelect>) {
  return <UiSelect {...props} />;
}
