type PreservedJsonNode =
  | Readonly<{ type: "literal"; canonical: "null" | "true" | "false" }>
  | Readonly<{ type: "number"; canonical: string }>
  | Readonly<{ type: "string"; value: string }>
  | Readonly<{ type: "array"; values: readonly PreservedJsonNode[] }>
  | Readonly<{
      type: "object";
      entries: readonly (readonly [string, PreservedJsonNode])[];
    }>;

/**
 * Canonicalize a sealed JSON record without normalizing its number tokens.
 * Python json.dumps emits spellings such as `1.0` and `1.266e-06` which are
 * lost by a JSON.parse/JSON.stringify round trip in JavaScript.
 */
export function canonicalRecordCoreFromJson(
  text: string,
  sealKey = "record_sha256",
): string | null {
  try {
    const root = new PreservedJsonParser(text).parse();
    if (root.type !== "object") return null;
    if (!root.entries.some(([key]) => key === sealKey)) return null;
    return canonicalPreservedJson(root, sealKey);
  } catch (_error) {
    return null;
  }
}

/**
 * Canonicalize a sealed object nested directly under a root JSON member while
 * preserving the original number tokens used by the producer.
 */
export function canonicalNestedRecordCoreFromJson(
  text: string,
  containerKey: string,
  sealKey = "record_sha256",
): string | null {
  try {
    const root = new PreservedJsonParser(text).parse();
    if (root.type !== "object") return null;
    const container = root.entries.find(([key]) => key === containerKey)?.[1];
    if (!container || container.type !== "object") return null;
    if (!container.entries.some(([key]) => key === sealKey)) return null;
    return canonicalPreservedJson(container, sealKey);
  } catch (_error) {
    return null;
  }
}

/**
 * Recreate Python's sorted/indented sealed JSON after removing one nested
 * object member, without collapsing float tokens such as `1.0` into `1`.
 * This is used to recover the exact pre-attachment runtime contract bytes.
 */
// eslint-disable-next-line complexity -- fail-closed preserved-token rewrite validation is intentionally centralized
export function reconstructPythonSealedJsonWithoutNestedKey(
  text: string,
  containerKey: string,
  removedKey: string,
  sealKey = "record_sha256",
  removedTopLevelKeys: readonly string[] = [],
  rewrittenTopLevelObjects: readonly PreservedTopLevelObjectRewrite[] = [],
): string | null {
  try {
    const root = new PreservedJsonParser(text).parse();
    if (root.type !== "object") return null;
    const containerEntry = root.entries.find(([key]) => key === containerKey);
    if (!containerEntry || containerEntry[1].type !== "object") return null;
    const container = containerEntry[1];
    if (!container.entries.some(([key]) => key === removedKey)) return null;
    if (!root.entries.some(([key]) => key === sealKey)) return null;
    // A release contract carries a `release_acceptance` block that the Python
    // calibration sealer pops before resealing (attach_font_matching_selection_
    // calibration.py). It is not part of the pre-calibration source contract and
    // must not alter the reconstructed binding hash; drop it alongside the seal.
    const topLevelDrop = new Set([sealKey, ...removedTopLevelKeys]);

    const sourceContainer: PreservedJsonNode = {
      type: "object",
      entries: container.entries.filter(([key]) => key !== removedKey),
    };
    const rewrittenObjects = new Map(
      rewrittenTopLevelObjects.map((rewrite) => [rewrite.objectKey, rewrite]),
    );
    if (rewrittenObjects.size !== rewrittenTopLevelObjects.length) return null;
    for (const rewrite of rewrittenTopLevelObjects) {
      const entry = root.entries.find(([key]) => key === rewrite.objectKey);
      if (!entry || entry[1].type !== "object") return null;
      const entryKeys = new Set(entry[1].entries.map(([key]) => key));
      if (
        rewrite.removedKeys.some((key) => !entryKeys.has(key)) ||
        Object.keys(rewrite.literalOverrides).some((key) => !entryKeys.has(key))
      ) {
        return null;
      }
    }
    const sourceCore: PreservedJsonNode = {
      type: "object",
      entries: root.entries
        .filter(([key]) => !topLevelDrop.has(key))
        .map(([key, value]) => {
          if (key === containerKey) return [key, sourceContainer] as const;
          const rewrite = rewrittenObjects.get(key);
          if (!rewrite || value.type !== "object") return [key, value] as const;
          const removedKeys = new Set(rewrite.removedKeys);
          const rewrittenValue: PreservedJsonNode = {
            type: "object",
            entries: value.entries
              .filter(([entryKey]) => !removedKeys.has(entryKey))
              .map(([entryKey, entryValue]) => {
                const literal = rewrite.literalOverrides[entryKey];
                return literal === undefined
                  ? ([entryKey, entryValue] as const)
                  : ([
                      entryKey,
                      { type: "literal", canonical: literal },
                    ] as const);
              }),
          };
          return [key, rewrittenValue] as const;
        }),
    };
    const seal = createHash("sha256")
      .update(canonicalPreservedJson(sourceCore))
      .digest("hex");
    const sourceRecord: PreservedJsonNode = {
      type: "object",
      entries: [
        ...sourceCore.entries,
        [sealKey, { type: "string", value: seal }],
      ],
    };
    return `${pythonPrettyPreservedJson(sourceRecord, 0)}\n`;
  } catch (_error) {
    return null;
  }
}

export type PreservedTopLevelObjectRewrite = Readonly<{
  objectKey: string;
  removedKeys: readonly string[];
  literalOverrides: Readonly<Record<string, "false" | "null" | "true">>;
}>;

function canonicalPreservedJson(
  node: PreservedJsonNode,
  omittedObjectKey?: string,
): string {
  if (node.type === "literal" || node.type === "number") {
    return node.canonical;
  }
  if (node.type === "string") return JSON.stringify(node.value);
  if (node.type === "array") {
    return `[${node.values.map((value) => canonicalPreservedJson(value)).join(",")}]`;
  }
  return `{${node.entries
    .filter(([key]) => key !== omittedObjectKey)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(
      ([key, value]) =>
        `${JSON.stringify(key)}:${canonicalPreservedJson(value)}`,
    )
    .join(",")}}`;
}

function pythonPrettyPreservedJson(
  node: PreservedJsonNode,
  depth: number,
): string {
  if (node.type === "literal" || node.type === "number") {
    return node.canonical;
  }
  if (node.type === "string") return JSON.stringify(node.value);
  const indentation = " ".repeat(depth * 2);
  const childIndentation = " ".repeat((depth + 1) * 2);
  if (node.type === "array") {
    if (node.values.length === 0) return "[]";
    return `[\n${node.values
      .map(
        (value) =>
          `${childIndentation}${pythonPrettyPreservedJson(value, depth + 1)}`,
      )
      .join(",\n")}\n${indentation}]`;
  }
  const entries = [...node.entries].sort(([left], [right]) =>
    compareStrings(left, right),
  );
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(
      ([key, value]) =>
        `${childIndentation}${JSON.stringify(key)}: ${pythonPrettyPreservedJson(value, depth + 1)}`,
    )
    .join(",\n")}\n${indentation}}`;
}

class PreservedJsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): PreservedJsonNode {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new SyntaxError("Trailing JSON");
    return value;
  }

  private parseValue(): PreservedJsonNode {
    const character = this.text[this.index];
    if (character === '"') return { type: "string", value: this.parseString() };
    if (character === "[") return this.parseArray();
    if (character === "{") return this.parseObject();
    if (character === "-" || (character && /[0-9]/u.test(character))) {
      return this.parseNumber();
    }
    for (const literal of ["null", "true", "false"] as const) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return { type: "literal", canonical: literal };
      }
    }
    throw new SyntaxError("Invalid JSON value");
  }

  private parseArray(): PreservedJsonNode {
    this.index += 1;
    this.skipWhitespace();
    const values: PreservedJsonNode[] = [];
    if (this.consume("]")) return { type: "array", values };
    while (true) {
      this.skipWhitespace();
      values.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return { type: "array", values };
      this.expect(",");
    }
  }

  private parseObject(): PreservedJsonNode {
    this.index += 1;
    this.skipWhitespace();
    const entries: Array<readonly [string, PreservedJsonNode]> = [];
    const keys = new Set<string>();
    if (this.consume("}")) return { type: "object", entries };
    while (true) {
      this.skipWhitespace();
      const key = this.parseString();
      if (keys.has(key)) throw new SyntaxError("Duplicate JSON key");
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      entries.push([key, this.parseValue()]);
      this.skipWhitespace();
      if (this.consume("}")) return { type: "object", entries };
      this.expect(",");
    }
  }

  private parseString(): string {
    if (this.text[this.index] !== '"') throw new SyntaxError("Expected string");
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === "\\") {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (character === '"') {
        const value: unknown = JSON.parse(this.text.slice(start, this.index));
        if (typeof value !== "string") throw new SyntaxError("Invalid string");
        return value;
      }
      if (character && character.charCodeAt(0) < 0x20) {
        throw new SyntaxError("Control character in string");
      }
    }
    throw new SyntaxError("Unterminated string");
  }

  private parseNumber(): PreservedJsonNode {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.index),
    );
    if (!match || !Number.isFinite(Number(match[0]))) {
      throw new SyntaxError("Invalid number");
    }
    this.index += match[0].length;
    return { type: "number", canonical: match[0] };
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.text[this.index] ?? "")) this.index += 1;
  }

  private consume(character: string): boolean {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) {
      throw new SyntaxError(`Expected ${character}`);
    }
  }
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
import { createHash } from "node:crypto";
