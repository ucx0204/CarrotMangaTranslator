import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import {
  CONDITIONAL_BATCH_FILE_NAME,
  ConditionalBatchSchemeDraftV2Schema,
  ConditionalBatchSequenceV2Schema,
  ConditionalBatchSnapshotV2Schema,
  MAX_CONDITIONAL_BATCH_FILE_BYTES,
  MAX_CONDITIONAL_BATCH_SCHEMES,
  createEmptyConditionalBatchSnapshot,
  includeConditionalBatchStarterSchemes,
  parseConditionalBatchSnapshot,
  type ConditionalBatchSchemeV2,
  type ConditionalBatchSequenceV2,
  type ConditionalBatchSnapshotV2,
  type SaveConditionalBatchSchemeInput,
} from "../shared/conditionalBatchRules";
import { formatConditionalBatchYamlSyntaxError } from "../shared/conditionalBatchErrorPresentation";
import { writeTextFileAtomically } from "./libraryStore/storage";

export type ConditionalBatchImportConflictPolicy = "duplicate" | "overwrite";

type ReadResult = {
  snapshot: ConditionalBatchSnapshotV2;
};

export class ConditionalBatchSchemeStore {
  readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.filePath = join(dataRoot, CONDITIONAL_BATCH_FILE_NAME);
  }

  list(): Promise<ConditionalBatchSnapshotV2> {
    return this.runExclusive(async () => (await this.read()).snapshot);
  }

  save(
    input: SaveConditionalBatchSchemeInput,
  ): Promise<ConditionalBatchSnapshotV2> {
    return this.runExclusive(async () => {
      const readResult = await this.read();
      const snapshot = readResult.snapshot;
      const scheme = ConditionalBatchSchemeDraftV2Schema.parse(input.scheme);
      const existingIndex = input.id
        ? snapshot.schemes.findIndex((entry) => entry.id === input.id)
        : -1;
      if (
        existingIndex < 0 &&
        snapshot.schemes.length >= MAX_CONDITIONAL_BATCH_SCHEMES
      ) {
        throw new Error(
          "일괄 편집 규칙은 최대 " +
            MAX_CONDITIONAL_BATCH_SCHEMES +
            "개까지 저장할 수 있습니다.",
        );
      }
      const existingId =
        existingIndex >= 0 ? snapshot.schemes[existingIndex]?.id : undefined;
      const saved: ConditionalBatchSchemeV2 = {
        id: existingId ?? randomUUID(),
        ...scheme,
      };
      const schemes =
        existingIndex >= 0
          ? snapshot.schemes.map((entry, index) =>
              index === existingIndex ? saved : entry,
            )
          : [saved, ...snapshot.schemes];
      const next = ConditionalBatchSnapshotV2Schema.parse({
        ...snapshot,
        schemes,
      });
      await this.write(next);
      return next;
    });
  }

  delete(id: string): Promise<ConditionalBatchSnapshotV2> {
    return this.runExclusive(async () => {
      const readResult = await this.read();
      const schemes = readResult.snapshot.schemes.filter(
        (scheme) => scheme.id !== id,
      );
      if (schemes.length === readResult.snapshot.schemes.length) {
        throw new Error("저장된 일괄 편집 규칙을 찾을 수 없습니다.");
      }
      const sequences = readResult.snapshot.sequences
        .map((sequence) => ({
          ...sequence,
          steps: sequence.steps.filter((step) => step.schemeId !== id),
        }))
        .filter((sequence) => sequence.steps.length > 0);
      const next = ConditionalBatchSnapshotV2Schema.parse({
        ...readResult.snapshot,
        schemes,
        sequences,
      });
      await this.write(next);
      return next;
    });
  }

  saveSequence(
    sequence: ConditionalBatchSequenceV2,
  ): Promise<ConditionalBatchSnapshotV2> {
    return this.runExclusive(async () => {
      const readResult = await this.read();
      const parsed = ConditionalBatchSequenceV2Schema.parse(sequence);
      const index = readResult.snapshot.sequences.findIndex(
        (entry) => entry.id === parsed.id,
      );
      const sequences =
        index < 0
          ? [parsed, ...readResult.snapshot.sequences]
          : readResult.snapshot.sequences.map((entry, entryIndex) =>
              entryIndex === index ? parsed : entry,
            );
      const next = ConditionalBatchSnapshotV2Schema.parse({
        ...readResult.snapshot,
        sequences,
      });
      await this.write(next);
      return next;
    });
  }

  deleteSequence(id: string): Promise<ConditionalBatchSnapshotV2> {
    return this.runExclusive(async () => {
      const readResult = await this.read();
      const sequences = readResult.snapshot.sequences.filter(
        (sequence) => sequence.id !== id,
      );
      if (sequences.length === readResult.snapshot.sequences.length) {
        throw new Error("저장된 연속 실행을 찾을 수 없습니다.");
      }
      const next = ConditionalBatchSnapshotV2Schema.parse({
        ...readResult.snapshot,
        sequences,
      });
      await this.write(next);
      return next;
    });
  }

  exportYaml(ids?: string[]): Promise<string> {
    return this.runExclusive(async () => {
      const snapshot = (await this.read()).snapshot;
      if (!ids || ids.length === 0) return serializeSnapshot(snapshot);
      const selectedIds = new Set(ids);
      const selected = ConditionalBatchSnapshotV2Schema.parse({
        ...snapshot,
        schemes: snapshot.schemes.filter((scheme) =>
          selectedIds.has(scheme.id),
        ),
        sequences: snapshot.sequences.filter((sequence) =>
          sequence.steps.every((step) => selectedIds.has(step.schemeId)),
        ),
      });
      return serializeSnapshot(selected);
    });
  }

  importYaml(
    raw: string,
    conflictPolicy: ConditionalBatchImportConflictPolicy = "duplicate",
  ): Promise<ConditionalBatchSnapshotV2> {
    return this.runExclusive(async () => {
      assertFileSize(raw);
      const imported = parseSnapshotYaml(raw).snapshot;
      const readResult = await this.read();
      const merged = mergeImportedSnapshot(
        readResult.snapshot,
        imported,
        conflictPolicy,
      );
      await this.write(merged);
      return merged;
    });
  }

  private async read(): Promise<ReadResult> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return {
          snapshot: includeConditionalBatchStarterSchemes(
            createEmptyConditionalBatchSnapshot(),
          ),
        };
      }
      throw error;
    }
    assertFileSize(raw);
    const parsed = parseSnapshotYaml(raw);
    return {
      snapshot: includeConditionalBatchStarterSchemes(parsed.snapshot),
    };
  }

  private async write(snapshot: ConditionalBatchSnapshotV2): Promise<void> {
    const contents = serializeSnapshot(snapshot);
    assertFileSize(contents);
    await writeTextFileAtomically(this.filePath, contents);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseSnapshotYaml(raw: string): ReadResult {
  const document = parseDocument(raw, {
    customTags: [],
    merge: false,
    prettyErrors: true,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(formatConditionalBatchYamlSyntaxError(document.errors[0]));
  }
  const parsed = document.toJS({ maxAliasCount: 0 });
  return parseConditionalBatchSnapshot(parsed);
}

function serializeSnapshot(snapshot: ConditionalBatchSnapshotV2): string {
  return stringify(ConditionalBatchSnapshotV2Schema.parse(snapshot), {
    indent: 2,
    lineWidth: 100,
    sortMapEntries: false,
  });
}

function mergeImportedSnapshot(
  current: ConditionalBatchSnapshotV2,
  imported: ConditionalBatchSnapshotV2,
  conflictPolicy: ConditionalBatchImportConflictPolicy,
): ConditionalBatchSnapshotV2 {
  if (conflictPolicy === "overwrite") {
    const importedSchemeIds = new Set(
      imported.schemes.map((scheme) => scheme.id),
    );
    const importedSequenceIds = new Set(
      imported.sequences.map((sequence) => sequence.id),
    );
    return ConditionalBatchSnapshotV2Schema.parse({
      ...current,
      schemes: [
        ...imported.schemes,
        ...current.schemes.filter(
          (scheme) => !importedSchemeIds.has(scheme.id),
        ),
      ],
      sequences: [
        ...imported.sequences,
        ...current.sequences.filter(
          (sequence) => !importedSequenceIds.has(sequence.id),
        ),
      ],
    });
  }

  const existingSchemeIds = new Set(current.schemes.map((scheme) => scheme.id));
  const usedNames = new Set(current.schemes.map((scheme) => scheme.name));
  const remappedIds = new Map<string, string>();
  const importedSchemes = imported.schemes.map((scheme) => {
    if (!existingSchemeIds.has(scheme.id)) {
      existingSchemeIds.add(scheme.id);
      usedNames.add(scheme.name);
      return scheme;
    }
    const id = randomUUID();
    remappedIds.set(scheme.id, id);
    const name = createImportedName(scheme.name, usedNames);
    existingSchemeIds.add(id);
    usedNames.add(name);
    return { ...scheme, id, name };
  });

  const existingSequenceIds = new Set(
    current.sequences.map((sequence) => sequence.id),
  );
  const usedSequenceNames = new Set(
    current.sequences.map((sequence) => sequence.name),
  );
  const importedSequences = imported.sequences.map((sequence) => {
    const collides = existingSequenceIds.has(sequence.id);
    const next = {
      ...sequence,
      id: collides ? randomUUID() : sequence.id,
      name: collides
        ? createImportedName(sequence.name, usedSequenceNames)
        : sequence.name,
      steps: sequence.steps.map((step) => ({
        ...step,
        schemeId: remappedIds.get(step.schemeId) ?? step.schemeId,
      })),
    };
    existingSequenceIds.add(next.id);
    usedSequenceNames.add(next.name);
    return next;
  });
  return ConditionalBatchSnapshotV2Schema.parse({
    ...current,
    schemes: [...importedSchemes, ...current.schemes],
    sequences: [...importedSequences, ...current.sequences],
  });
}

function createImportedName(baseName: string, usedNames: Set<string>): string {
  const suffix = " (가져옴)";
  const base = baseName.slice(0, Math.max(1, 80 - suffix.length));
  let candidate = base + suffix;
  let index = 2;
  while (usedNames.has(candidate)) {
    const numberedSuffix = ` (가져옴 ${index})`;
    candidate =
      baseName.slice(0, Math.max(1, 80 - numberedSuffix.length)) +
      numberedSuffix;
    index += 1;
  }
  return candidate;
}

function assertFileSize(raw: string): void {
  if (Buffer.byteLength(raw, "utf8") > MAX_CONDITIONAL_BATCH_FILE_BYTES) {
    throw new Error("일괄 편집 YAML 파일이 2MiB를 초과합니다.");
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return isNodeErrorWithCode(error, "ENOENT");
}

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
