import { fireEvent, screen, within } from "@testing-library/react";

export function chooseCustomSelectOption(
  selectName: string | RegExp,
  optionName: string | RegExp,
): void {
  const trigger = screen.getByRole("combobox", { name: selectName });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
  fireEvent.click(
    within(screen.getByRole("listbox", { name: selectName })).getByRole(
      "option",
      { name: optionName },
    ),
  );
}

export function openCustomSelect(selectName: string | RegExp): HTMLElement {
  const trigger = screen.getByRole("combobox", { name: selectName });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
  return screen.getByRole("listbox", { name: selectName });
}

export function customSelectOptionValues(
  selectName: string | RegExp,
): Array<string | null> {
  return within(openCustomSelect(selectName))
    .getAllByRole("option", { hidden: true })
    .map((option) => option.getAttribute("data-value"));
}
