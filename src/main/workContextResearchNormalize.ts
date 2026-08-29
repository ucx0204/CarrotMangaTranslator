/* eslint-disable max-lines -- glossary and character proposal normalization share one duplicate/manual-protection contract */
import { randomUUID } from "node:crypto";
import type {
  CharacterProfile,
  GlossaryEntry,
  WorkStyleGuide,
} from "../shared/workContextTypes";
import type { WorkContextUsage } from "../shared/workContextUsageTypes";
import type {
  WorkContextResearchOperation,
  WorkContextResearchSource,
} from "../shared/workContextResearchTypes";
import { applyWorkContextResearchOperations } from "../shared/workContextResearchProposal";
import type { WorkTextSelection } from "./workContextAnalysisPrompt";
import { countTextMentions } from "./workContextUsage";
import {
  characterPrevious,
  glossaryPrevious,
  nowIso,
} from "./workContextResearchDefaults";
import {
  findCharacterByNames,
  findGlossaryByName,
  isManual,
} from "./workContextResearchMatch";
import {
  canonicalizeHttpsUrl,
  readAction,
  readGlossaryCategory,
  readOptionalArrayField,
  readOptionalField,
  readOptionalString,
  readRecord,
  readSpeechStyle,
  readString,
  readStringArray,
  uniqueStrings,
  type JsonRecord,
} from "./workContextResearchNormalizeValues";

export type NormalizedResearchChanges = {
  operations: WorkContextResearchOperation[];
  warnings: string[];
  estimatedTokenDelta: number;
};

// eslint-disable-next-line complexity -- each raw entity/action is normalized through one fail-closed dispatch
export function normalizeWorkContextResearchChanges({
  raw,
  guide,
  usage,
  selection,
  allowedSourceUrls,
}: {
  raw: unknown;
  guide: WorkStyleGuide;
  usage: WorkContextUsage;
  selection: WorkTextSelection;
  allowedSourceUrls?: ReadonlySet<string>;
}): NormalizedResearchChanges {
  const root = readRecord(raw);
  const rawOperations = Array.isArray(root?.operations)
    ? root.operations.slice(0, 1_300)
    : [];
  const warnings = readStringArray(root?.warnings, 50, 1_000);
  const operations: WorkContextResearchOperation[] = [];
  for (const value of rawOperations) {
    const rawOperation = readRecord(value);
    const entity = rawOperation?.entity;
    const operation =
      entity === "glossary"
        ? normalizeGlossaryOperation({
            raw: rawOperation,
            guide,
            usage,
            selection,
            allowedSourceUrls,
            warnings,
          })
        : entity === "character"
          ? normalizeCharacterOperation({
              raw: rawOperation,
              guide,
              usage,
              selection,
              allowedSourceUrls,
              warnings,
            })
          : null;
    if (!operation) continue;
    const duplicateIndex = operations.findIndex((candidate) =>
      operationsOverlap(candidate, operation),
    );
    if (duplicateIndex >= 0) {
      const existing = operations[duplicateIndex];
      if (
        existing &&
        isCharacterAddition(existing) &&
        isCharacterAddition(operation)
      ) {
        operations[duplicateIndex] = mergeCharacterAdditions(
          existing,
          operation,
        );
      }
      warnings.push("같은 항목을 여러 번 바꾸는 중복 제안을 제외했습니다.");
      continue;
    }
    operations.push(operation);
  }
  const selected = operations.filter(
    (operation) => operation.selectedByDefault,
  );
  const beforeTokens = estimateGuideTokens(guide);
  const afterTokens = estimateGuideTokens(
    applyWorkContextResearchOperations(guide, selected),
  );
  return {
    operations,
    warnings: uniqueStrings(warnings).slice(0, 100),
    estimatedTokenDelta: afterTokens - beforeTokens,
  };
}

function operationClaim(operation: WorkContextResearchOperation): string {
  if (operation.action !== "add") {
    return `${operation.entity}:id:${operation.after.id}`;
  }
  if (operation.entity === "glossary") {
    return `glossary:add:${normalizeClaimText(operation.after.source)}`;
  }
  const sourceName =
    operation.after.sourceNames[0] || operation.after.displayName;
  return `character:add:${normalizeClaimText(sourceName)}`;
}

function normalizeClaimText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
}

type CharacterResearchOperation = Extract<
  WorkContextResearchOperation,
  { entity: "character" }
>;

function operationsOverlap(
  left: WorkContextResearchOperation,
  right: WorkContextResearchOperation,
): boolean {
  if (operationClaim(left) === operationClaim(right)) return true;
  return (
    isCharacterAddition(left) &&
    isCharacterAddition(right) &&
    characterNamesOverlap(left, right)
  );
}

function isCharacterAddition(
  operation: WorkContextResearchOperation,
): operation is CharacterResearchOperation {
  return operation.entity === "character" && operation.action === "add";
}

function characterNamesOverlap(
  left: CharacterResearchOperation,
  right: CharacterResearchOperation,
): boolean {
  const leftKeys = new Set(left.after.sourceNames.map(normalizeClaimText));
  const rightKeys = new Set(right.after.sourceNames.map(normalizeClaimText));
  if ([...leftKeys].some((key) => rightKeys.has(key))) return true;
  const leftStems = new Set(left.after.sourceNames.map(characterNameStem));
  if (
    right.after.sourceNames.some((name) =>
      leftStems.has(characterNameStem(name)),
    )
  ) {
    return true;
  }
  if (
    normalizeClaimText(left.after.targetName) !==
    normalizeClaimText(right.after.targetName)
  ) {
    return false;
  }
  return left.after.sourceNames.some((leftName) =>
    right.after.sourceNames.some((rightName) =>
      isMinorNameVariant(leftName, rightName),
    ),
  );
}

function isMinorNameVariant(left: string, right: string): boolean {
  const leftChars = [...normalizeCharacterSoundKey(left)];
  const rightChars = [...normalizeCharacterSoundKey(right)];
  if (Math.abs(leftChars.length - rightChars.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < leftChars.length && rightIndex < rightChars.length) {
    if (leftChars[leftIndex] === rightChars[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (leftChars.length > rightChars.length) leftIndex += 1;
    else if (rightChars.length > leftChars.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return (
    edits +
      Number(leftIndex < leftChars.length || rightIndex < rightChars.length) <=
    1
  );
}

function normalizeCharacterSoundKey(value: string): string {
  return normalizeClaimText(value)
    .replace(/ヴァ/gu, "バ")
    .replace(/ヴィ/gu, "ビ")
    .replace(/ヴェ/gu, "ベ")
    .replace(/ヴォ/gu, "ボ");
}

function characterNameStem(value: string): string {
  const firstPart = value.normalize("NFKC").split(/[・･·\s]+/u)[0] ?? value;
  return normalizeClaimText(firstPart);
}

function mergeCharacterAdditions(
  left: CharacterResearchOperation,
  right: CharacterResearchOperation,
): CharacterResearchOperation {
  const sourceNames = uniqueStrings([
    ...left.after.sourceNames,
    ...right.after.sourceNames,
  ]).sort((a, b) => b.length - a.length);
  const targetName = preferInformativeText(
    left.after.targetName,
    right.after.targetName,
  );
  const confidence =
    left.confidence === "high" || right.confidence === "high"
      ? "high"
      : "medium";
  return {
    ...left,
    reason: uniqueStrings([left.reason, right.reason])
      .join(" / ")
      .slice(0, 2_000),
    confidence,
    selectedByDefault: confidence === "high",
    evidence: {
      pageCount: Math.max(left.evidence.pageCount, right.evidence.pageCount),
      mentionCount: Math.max(
        left.evidence.mentionCount,
        right.evidence.mentionCount,
      ),
      ...(left.evidence.sample || right.evidence.sample
        ? { sample: left.evidence.sample ?? right.evidence.sample }
        : {}),
    },
    sources: mergeSources(left.sources, right.sources),
    after: {
      ...left.after,
      displayName: targetName || left.after.displayName,
      sourceNames,
      targetName,
      aliases: uniqueStrings([
        ...(left.after.aliases ?? []),
        ...(right.after.aliases ?? []),
      ]),
      note: left.after.note ?? right.after.note,
    },
  };
}

function preferInformativeText(left: string, right: string): string {
  return normalizeClaimText(right).length > normalizeClaimText(left).length
    ? right
    : left;
}

function mergeSources(
  left: WorkContextResearchSource[],
  right: WorkContextResearchSource[],
): WorkContextResearchSource[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function normalizeGlossaryOperation(input: NormalizeOperationInput) {
  const action = readAction(input.raw?.action);
  if (!action) return null;
  const existing = findExistingGlossary(input);
  if (existing && isManual(existing)) {
    input.warnings.push(
      `수동 용어 “${existing.source}”과 충돌한 제안은 적용 대상에서 제외했습니다.`,
    );
    return null;
  }
  return action === "disable"
    ? normalizeGlossaryDisable(input, existing)
    : normalizeGlossaryUpsert(input, existing);
}

function findExistingGlossary(
  input: NormalizeOperationInput,
): GlossaryEntry | undefined {
  const rawId = readString(input.raw?.entryId, 200);
  const byId = rawId
    ? input.guide.glossary.find((entry) => entry.id === rawId)
    : undefined;
  if (byId) return byId;
  const source = readString(input.raw?.source, 400);
  return source ? findGlossaryByName(input.guide.glossary, source) : undefined;
}

function normalizeGlossaryDisable(
  input: NormalizeOperationInput,
  existing: GlossaryEntry | undefined,
) {
  if (!existing || existing.origin !== "ai") return null;
  return makeOperation(
    input,
    "glossary",
    "disable",
    existing,
    { ...existing, enabled: false, updatedAt: nowIso() },
    [existing.source, ...(existing.aliases ?? [])],
  );
}

function normalizeGlossaryUpsert(
  input: NormalizeOperationInput,
  existing: GlossaryEntry | undefined,
) {
  const raw = input.raw ?? {};
  const timestamp = nowIso();
  const previous = glossaryPrevious(existing, timestamp);
  const source = readString(raw.source, 400) || previous.source;
  if (!source) return null;
  const after: GlossaryEntry = {
    id: previous.id,
    source,
    target: readOptionalString(raw.target, 400) ?? previous.target,
    category: readGlossaryCategory(raw.category) ?? previous.category,
    ...readOptionalArrayField(raw, "aliases", previous.aliases, 50, 200),
    ...readOptionalField(raw, "note", previous.note, 2_000),
    origin: "ai",
    enabled: true,
    createdAt: previous.createdAt,
    updatedAt: timestamp,
  };
  return makeOperation(
    input,
    "glossary",
    upsertAction(existing),
    existing,
    after,
    [source, ...(after.aliases ?? [])],
  );
}

function normalizeCharacterOperation(input: NormalizeOperationInput) {
  const action = readAction(input.raw?.action);
  if (!action) return null;
  const existing = findExistingCharacter(input);
  if (existing && isManual(existing)) {
    input.warnings.push(
      `수동 캐릭터 “${existing.displayName}”과 충돌한 제안은 적용 대상에서 제외했습니다.`,
    );
    return null;
  }
  return action === "disable"
    ? normalizeCharacterDisable(input, existing)
    : normalizeCharacterUpsert(input, existing);
}

function findExistingCharacter(
  input: NormalizeOperationInput,
): CharacterProfile | undefined {
  const rawId = readString(input.raw?.entryId, 200);
  const byId = rawId
    ? input.guide.characters.find((entry) => entry.id === rawId)
    : undefined;
  if (byId) return byId;
  return findCharacterByNames(input.guide.characters, [
    ...readStringArray(input.raw?.sourceNames, 50, 200),
    readString(input.raw?.displayName, 200),
  ]);
}

function normalizeCharacterDisable(
  input: NormalizeOperationInput,
  existing: CharacterProfile | undefined,
) {
  if (!existing || existing.origin !== "ai") return null;
  return makeOperation(
    input,
    "character",
    "disable",
    existing,
    { ...existing, enabled: false, updatedAt: nowIso() },
    [...existing.sourceNames, ...(existing.aliases ?? [])],
  );
}

// eslint-disable-next-line complexity -- add/update validation keeps all character fields and manual-entry protection in one boundary
function normalizeCharacterUpsert(
  input: NormalizeOperationInput,
  existing: CharacterProfile | undefined,
) {
  const raw = input.raw ?? {};
  const timestamp = nowIso();
  const previous = characterPrevious(existing, timestamp);
  const proposedNames = uniqueStrings(
    readStringArray(raw.sourceNames, 50, 200)
      .map((name) => name.replace(/^[・･·]+|[・･·]+$/gu, "").trim())
      .filter(Boolean),
  );
  const sourceNames = proposedNames.length
    ? proposedNames
    : previous.sourceNames;
  const targetName =
    readOptionalString(raw.targetName, 200) ||
    previous.targetName ||
    readString(raw.displayName, 200) ||
    sourceNames[0] ||
    "";
  const displayName =
    targetName || previous.displayName || sourceNames[0] || "";
  if (!displayName) return null;
  if (sourceNames.length === 0) return null;
  const speechStyle = readSpeechStyle(raw.speechStyle) ?? previous.speechStyle;
  const after: CharacterProfile = {
    id: previous.id,
    displayName,
    sourceNames,
    targetName,
    ...readOptionalArrayField(raw, "aliases", previous.aliases, 50, 200),
    speechStyle,
    ...readOptionalField(
      raw,
      "customSpeechStyle",
      previous.customSpeechStyle,
      1_000,
    ),
    ...readOptionalField(raw, "note", previous.note, 2_000),
    origin: "ai",
    enabled: true,
    createdAt: previous.createdAt,
    updatedAt: timestamp,
  };
  return makeOperation(
    input,
    "character",
    upsertAction(existing),
    existing,
    after,
    [...sourceNames, ...(after.aliases ?? [])],
  );
}

function upsertAction(
  existing: GlossaryEntry | CharacterProfile | undefined,
): "add" | "update" {
  return existing ? "update" : "add";
}

type NormalizeOperationInput = {
  raw: JsonRecord | null;
  guide: WorkStyleGuide;
  usage: WorkContextUsage;
  selection: WorkTextSelection;
  allowedSourceUrls?: ReadonlySet<string>;
  warnings: string[];
};

// eslint-disable-next-line complexity -- raw proposal variants are normalized through one fail-closed entity/action boundary
function makeOperation<
  TEntity extends "glossary" | "character",
  TEntry extends TEntity extends "glossary" ? GlossaryEntry : CharacterProfile,
>(
  input: NormalizeOperationInput,
  entity: TEntity,
  action: "add" | "update" | "disable",
  before: TEntry | undefined,
  after: TEntry,
  keys: string[],
): WorkContextResearchOperation | null {
  const raw = input.raw ?? {};
  const reason = readString(raw.reason, 2_000);
  if (!reason) return null;
  const sources = readSources(raw.sources, input.allowedSourceUrls);
  const evidence = buildEvidence(input, entity, entryId(before), keys);
  if (!operationHasSupport(action, evidence.mentionCount, sources.length))
    return null;
  const confidence =
    raw.confidence === "high" &&
    isDefaultSelectableOperation(
      entity,
      action,
      after,
      evidence.mentionCount,
      raw.criticalTitleTranslation === true,
      raw.criticalEvidenceTranslation === true,
    ) &&
    (action === "disable" ||
      (raw.criticalTitleTranslation === true && sources.length >= 2) ||
      (entity === "character" &&
        raw.criticalEvidenceTranslation === true &&
        sources.length >= 2) ||
      (sources.length > 0 && evidence.mentionCount > 0) ||
      evidence.mentionCount >= 2)
      ? "high"
      : "medium";
  const common = {
    id: randomUUID(),
    action,
    reason,
    confidence,
    selectedByDefault: confidence === "high",
    evidence,
    sources,
  } as const;
  return entity === "glossary"
    ? {
        ...common,
        entity,
        ...(before ? { before: before as GlossaryEntry } : {}),
        after: after as GlossaryEntry,
      }
    : {
        ...common,
        entity,
        ...(before ? { before: before as CharacterProfile } : {}),
        after: after as CharacterProfile,
      };
}

// eslint-disable-next-line complexity -- default selection requires confidence, provenance, aliases, and local evidence to agree
function isDefaultSelectableOperation(
  entity: "glossary" | "character",
  action: "add" | "update" | "disable",
  after: GlossaryEntry | CharacterProfile,
  mentionCount: number,
  criticalTitleTranslation: boolean,
  criticalEvidenceTranslation: boolean,
): boolean {
  if (
    entity === "character" &&
    action === "add" &&
    criticalEvidenceTranslation
  ) {
    return true;
  }
  if (entity !== "glossary" || action !== "add") return true;
  const glossary = after as GlossaryEntry;
  if (
    ["term", "other"].includes(glossary.category) &&
    !criticalTitleTranslation &&
    mentionCount < 2 &&
    (glossary.aliases?.length ?? 0) === 0
  ) {
    return false;
  }
  if (
    ["character", "alias", "place", "honorific"].includes(glossary.category)
  ) {
    return true;
  }
  const source = glossary.source.normalize("NFKC").replace(/\s+/gu, "");
  if ([...source].length >= 4) return true;
  if ((glossary.aliases?.length ?? 0) > 0) return true;
  return /[【《（(0-9０-９A-Za-zァ-ヺー]/u.test(source);
}

function entryId(entry: GlossaryEntry | CharacterProfile | undefined) {
  return entry ? entry.id : undefined;
}

function operationHasSupport(
  action: "add" | "update" | "disable",
  mentionCount: number,
  sourceCount: number,
): boolean {
  return action === "disable" || mentionCount > 0 || sourceCount > 0;
}

function buildEvidence(
  input: NormalizeOperationInput,
  entity: "glossary" | "character",
  existingId: string | undefined,
  keys: string[],
) {
  const metric = existingId
    ? (entity === "glossary"
        ? input.usage.glossary
        : input.usage.characters
      ).find((candidate) => candidate.id === existingId)
    : undefined;
  const mentionCount =
    metric?.mentionCount ?? countTextMentions(input.selection.text, keys);
  const pageCount =
    metric?.pageCount ??
    input.selection.basePages.filter((page) =>
      countTextMentions(`${page.sourceDigest}\n${page.translatedDigest}`, keys),
    ).length;
  const sample = findEvidenceSample(input.selection.text, keys);
  return { pageCount, mentionCount, ...(sample ? { sample } : {}) };
}

function findEvidenceSample(text: string, keys: string[]): string {
  const usable = keys
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const key of usable) {
    const index = text.normalize("NFKC").indexOf(key.normalize("NFKC"));
    if (index >= 0) {
      return text
        .slice(
          Math.max(0, index - 90),
          Math.min(text.length, index + key.length + 130),
        )
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return "";
}

function readSources(
  value: unknown,
  allowedSourceUrls?: ReadonlySet<string>,
): WorkContextResearchSource[] {
  const values = Array.isArray(value) ? value : [];
  const allowed = allowedSourceUrls
    ? new Set([...allowedSourceUrls].map(canonicalizeHttpsUrl).filter(Boolean))
    : null;
  const urls = new Set<string>();
  const sources: WorkContextResearchSource[] = [];
  for (const candidate of values.slice(0, 20)) {
    const record = readRecord(candidate);
    const title = readString(record?.title, 500);
    const url = canonicalizeHttpsUrl(record?.url);
    if (!url || urls.has(url) || (allowed && !allowed.has(url))) continue;
    urls.add(url);
    sources.push({ title: title || new URL(url).hostname, url });
  }
  return sources;
}

function estimateGuideTokens(guide: WorkStyleGuide): number {
  return Math.ceil(
    JSON.stringify({ glossary: guide.glossary, characters: guide.characters })
      .length / 4,
  );
}
