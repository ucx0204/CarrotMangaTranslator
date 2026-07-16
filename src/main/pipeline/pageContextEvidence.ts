export function collectOcrTextEvidence(value: unknown): string[] {
  const found: string[] = [];
  const visit = (item: unknown, depth: number): void => {
    if (depth > 5 || item === null || item === undefined) return;
    if (Array.isArray(item)) {
      item.slice(0, 500).forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (
        typeof child === "string" &&
        /^(?:ocrText|text|sourceText|transcript)$/i.test(key)
      ) {
        const text = child.replace(/\s+/g, " ").trim();
        if (text) found.push(text);
      } else if (typeof child === "object") {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return [...new Set(found)];
}

export function buildNameIndex<T extends { id: string }>(
  entries: T[],
  names: (entry: T) => string[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const value of names(entry)) {
      const key = normalizeEvidence(value);
      if (!key) continue;
      const ids = index.get(key) ?? new Set<string>();
      ids.add(entry.id);
      index.set(key, ids);
    }
  }
  return index;
}

export function resolveNameMatches(
  index: Map<string, Set<string>>,
  values: string[],
): Set<string> {
  const matches = new Set<string>();
  for (const value of values) {
    for (const id of index.get(normalizeEvidence(value)) ?? []) {
      matches.add(id);
    }
  }
  return matches;
}

export function evidenceContains(
  normalizedEvidence: readonly string[],
  value: string,
): boolean {
  const needle = normalizeEvidence(value);
  return (
    Boolean(needle) &&
    normalizedEvidence.some((segment) => segment.includes(needle))
  );
}

export function normalizeEvidenceSegments(values: string[]): string[] {
  return [...new Set(values.map(normalizeEvidence).filter(Boolean))];
}

export function normalizeEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}
