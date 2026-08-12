import { describe, expect, it } from "vitest";

type PreservedSealModule = {
  canonicalNestedRecordCoreFromJson: (
    text: string,
    containerKey: string,
    sealKey?: string,
  ) => string | null;
};

const { canonicalNestedRecordCoreFromJson } =
  require("../scripts/preserved-json-record-seal.cjs") as PreservedSealModule;

describe("preserved JSON record seal script", () => {
  it("preserves Python float and exponent tokens in a nested sealed record", () => {
    const text = `{"root":"fixture","release_acceptance":{"record_sha256":"${"a".repeat(64)}","ratio":1.0,"tolerance":1e-09}}`;

    expect(canonicalNestedRecordCoreFromJson(text, "release_acceptance")).toBe(
      '{"ratio":1.0,"tolerance":1e-09}',
    );
  });

  it("fails closed on duplicate keys and malformed JSON", () => {
    const duplicate = `{"release_acceptance":{"record_sha256":"${"a".repeat(64)}","ratio":1.0,"ratio":1.00}}`;

    expect(
      canonicalNestedRecordCoreFromJson(duplicate, "release_acceptance"),
    ).toBeNull();
    expect(
      canonicalNestedRecordCoreFromJson("{", "release_acceptance"),
    ).toBeNull();
  });
});
