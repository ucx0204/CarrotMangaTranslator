// @ts-check

/**
 * @typedef {{ type: "literal", canonical: "null" | "true" | "false" }
 * | { type: "number", canonical: string }
 * | { type: "string", value: string }
 * | { type: "array", values: PreservedJsonNode[] }
 * | { type: "object", entries: Array<[string, PreservedJsonNode]> }} PreservedJsonNode
 */

/**
 * Canonicalize a sealed object nested under a root JSON member without
 * normalizing the producer's number tokens. Python seals values such as `1.0`
 * and `1e-09` verbatim; JSON.parse/JSON.stringify would change those tokens.
 *
 * @param {string} text
 * @param {string} containerKey
 * @param {string} [sealKey]
 */
function canonicalNestedRecordCoreFromJson(
  text,
  containerKey,
  sealKey = "record_sha256",
) {
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
 * @param {PreservedJsonNode} node
 * @param {string} [omittedObjectKey]
 * @returns {string}
 */
function canonicalPreservedJson(node, omittedObjectKey) {
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

class PreservedJsonParser {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  /** @returns {PreservedJsonNode} */
  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new SyntaxError("Trailing JSON");
    return value;
  }

  /** @returns {PreservedJsonNode} */
  parseValue() {
    const character = this.text[this.index];
    if (character === '"') return { type: "string", value: this.parseString() };
    if (character === "[") return this.parseArray();
    if (character === "{") return this.parseObject();
    if (character === "-" || (character && /[0-9]/u.test(character))) {
      return this.parseNumber();
    }
    for (const literal of /** @type {const} */ (["null", "true", "false"])) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return { type: "literal", canonical: literal };
      }
    }
    throw new SyntaxError("Invalid JSON value");
  }

  /** @returns {PreservedJsonNode} */
  parseArray() {
    this.index += 1;
    this.skipWhitespace();
    /** @type {PreservedJsonNode[]} */
    const values = [];
    if (this.consume("]")) return { type: "array", values };
    while (true) {
      this.skipWhitespace();
      values.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return { type: "array", values };
      this.expect(",");
    }
  }

  /** @returns {PreservedJsonNode} */
  parseObject() {
    this.index += 1;
    this.skipWhitespace();
    /** @type {Array<[string, PreservedJsonNode]>} */
    const entries = [];
    const keys = new Set();
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

  /** @returns {string} */
  parseString() {
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
        /** @type {unknown} */
        const value = JSON.parse(this.text.slice(start, this.index));
        if (typeof value !== "string") throw new SyntaxError("Invalid string");
        return value;
      }
      if (character && character.charCodeAt(0) < 0x20) {
        throw new SyntaxError("Control character in string");
      }
    }
    throw new SyntaxError("Unterminated string");
  }

  /** @returns {PreservedJsonNode} */
  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.index),
    );
    if (!match || !Number.isFinite(Number(match[0]))) {
      throw new SyntaxError("Invalid number");
    }
    this.index += match[0].length;
    return { type: "number", canonical: match[0] };
  }

  skipWhitespace() {
    while (/\s/u.test(this.text[this.index] ?? "")) this.index += 1;
  }

  /** @param {string} character */
  consume(character) {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  /** @param {string} character */
  expect(character) {
    if (!this.consume(character)) {
      throw new SyntaxError(`Expected ${character}`);
    }
  }
}

/** @param {string} left @param {string} right */
function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

module.exports = { canonicalNestedRecordCoreFromJson };
