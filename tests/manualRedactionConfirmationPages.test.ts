import { expect, it } from "vitest";
import { indexRedactionConfirmationPages } from "../src/main/application/redactionConfirmationPages";

it("preserves the validated snapshot rather than cloning or inventing page data", () => {
  const page = { id: "page", fingerprint: "original" };
  expect(indexRedactionConfirmationPages([page], 1).get("page")).toBe(page);
});
it.each([
  [[{ id: "a" }, { id: "a" }], 2],
  [[{ id: "a" }], 2],
  [[{ id: "a" }, { id: "b" }], 1],
] as const)(
  "rejects duplicate, missing and surplus approval scopes",
  (pages, count) => {
    expect(() => indexRedactionConfirmationPages(pages, count)).toThrow(
      "페이지 목록",
    );
  },
);
