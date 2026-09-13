import { expect, it } from "vitest";
import { isSexualImageRefusal } from "../src/main/codexImageModeration";

it("recognizes explicit provider sexual moderation diagnostics", () => {
  const refusal = Object.assign(new Error('ImageGen 실패: "failed"'), {
    imageGenerationDiagnostics: {
      processError: {
        code: "moderation_blocked",
        moderationDetails: { categories: ["sexual"] },
      },
    },
  });
  expect(isSexualImageRefusal(refusal)).toBe(true);
  expect(
    isSexualImageRefusal(new Error("HTTP 400 safety_violations=[sexual]")),
  ).toBe(true);
  expect(
    isSexualImageRefusal(new AggregateError([refusal, new Error("disk full")])),
  ).toBe(false);
});

it.each([
  new Error("sexual.png could not be read"),
  new Error("connection failed"),
  new Error("ImageGen failed"),
  new Error("safety_violations=[violence]"),
  Object.assign(new Error("safety_violations=[sexual]"), {
    name: "AbortError",
  }),
  { code: "transport_error", moderation_details: { categories: ["sexual"] } },
  null,
])("does not hide unrelated errors or cancellation: %s", (error) => {
  expect(isSexualImageRefusal(error)).toBe(false);
});
