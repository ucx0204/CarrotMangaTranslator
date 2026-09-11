import { expect, it } from "vitest";
import { DEFAULT_REDACTION_PREFERENCES as preferences } from "../src/shared/imageRedactionWorkspace";
import {
  redactionKeyAction,
  validRedactionNavigationKeys,
} from "../src/renderer/src/components/imageRedaction/redactionKeyboard";
const key = (value: string) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
});
it("keeps page navigation separate from review and final approval", () => {
  expect(redactionKeyAction(key("x"), preferences)).toBe("next");
  expect(redactionKeyAction(key("ArrowRight"), preferences)).toBe("next");
  expect(redactionKeyAction(key("Enter"), preferences)).toBe("confirm");
  expect(
    redactionKeyAction({ ...key("Enter"), ctrlKey: true }, preferences),
  ).toBe("continue");
  expect(
    redactionKeyAction({ ...key("Enter"), repeat: true }, preferences),
  ).toBeNull();
  expect(
    redactionKeyAction(
      { ...key("Enter"), ctrlKey: true, repeat: true },
      preferences,
    ),
  ).toBeNull();
  expect(
    redactionKeyAction({ ...key("Enter"), shiftKey: true }, preferences),
  ).toBeNull();
});
it("does not consume IME composition, unrelated modifiers or disabled character keys", () => {
  expect(
    redactionKeyAction({ ...key("x"), isComposing: true }, preferences),
  ).toBeNull();
  expect(
    redactionKeyAction({ ...key("x"), ctrlKey: true }, preferences),
  ).toBeNull();
  expect(
    redactionKeyAction({ ...key("x"), altKey: true }, preferences),
  ).toBeNull();
  expect(
    redactionKeyAction(key("x"), { ...preferences, letterShortcuts: false }),
  ).toBeNull();
  expect(redactionKeyAction({ ...key("z"), metaKey: true }, preferences)).toBe(
    "undo",
  );
});
it("allows explicit one-hand remapping without tool collisions", () => {
  expect(validRedactionNavigationKeys("a", "s")).toBe(true);
  expect(validRedactionNavigationKeys("r", "x")).toBe(false);
  expect(validRedactionNavigationKeys("x", "x")).toBe(false);
  expect(validRedactionNavigationKeys("", "")).toBe(true);
  expect(
    redactionKeyAction(key("s"), {
      ...preferences,
      previousKey: "a",
      nextKey: "s",
    }),
  ).toBe("next");
});

it("inherits common remaps and unbinds without moving the app page behind the modal", () => {
  const overrides = {
    "page-next": "ctrl+q",
    "history-undo": "ctrl+j",
    "page-previous": "",
  };
  expect(
    redactionKeyAction({ ...key("q"), ctrlKey: true }, preferences, overrides),
  ).toBe("next");
  expect(redactionKeyAction(key("x"), preferences, overrides)).toBeNull();
  expect(
    redactionKeyAction(key("ArrowRight"), preferences, overrides),
  ).toBeNull();
  expect(redactionKeyAction(key("z"), preferences, overrides)).toBeNull();
  expect(
    redactionKeyAction(key("ArrowLeft"), preferences, overrides),
  ).toBeNull();
  expect(
    redactionKeyAction({ ...key("j"), metaKey: true }, preferences, overrides),
  ).toBe("undo");
  expect(
    redactionKeyAction({ ...key("z"), ctrlKey: true }, preferences, overrides),
  ).toBeNull();
});
it("uses the common physical-key normalizer but never consumes active composition", () => {
  expect(redactionKeyAction({ ...key("ㅌ"), code: "KeyX" }, preferences)).toBe(
    "next",
  );
  expect(
    redactionKeyAction(
      { ...key("ㅌ"), code: "KeyX", isComposing: true },
      preferences,
    ),
  ).toBeNull();
});
