import { createHash } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpContextExchangeBindingSchema,
  type McpContextExchangeBinding,
} from "../../shared/mcpExchangeFiles";
import {
  McpContextExportPreflightSchema,
  McpContextExportReviewSchema,
  type McpContextExportPreflight,
} from "../../shared/mcpContextExchange";
import {
  encodeMcpContextExchangePayload,
  parseMcpContextExchangePayload,
} from "../../shared/mcpContextExchangePayload";
import { McpEditError } from "../application/mcpEditPolicy";
import { withLibraryRead } from "../library/lock";
import { readChapterFile, readWorkFile } from "../libraryStore/libraryFiles";
import {
  readChapterStoryMemory,
  readWorkStyleGuide,
} from "../libraryStore/workContextFiles";
import { captureWorkContextMetadata } from "../libraryStore/workContextMigration";

/** Canonical raw context only. No page/image payload or display reconciliation. */
export function readMcpContextExchangeState(
  input: McpContextExportPreflight,
  guard: () => void,
  signal?: AbortSignal,
) {
  const request = McpContextExportPreflightSchema.parse(input);
  const check = contextGuard(guard, signal);
  return withLibraryRead(() => readContextExchangeUnlocked(request, check));
}

async function readContextExchangeUnlocked(
  input: McpContextExportPreflight,
  guard: () => void,
) {
  const state = await captureContextPayloadUnlocked(input, guard);
  const bytes = Buffer.from(encodeMcpContextExchangePayload(state.payload));
  await state.evidence.verify();
  guard();
  const review = contextExportReview(input, state, bytes);
  return {
    review,
    payload: state.payload,
    bytes,
    binding: state.binding,
    verifySources: () => checkMcpContextExchangeBinding(state.binding, guard),
  };
}

async function captureContextPayloadUnlocked(
  input: McpContextExportPreflight,
  guard: () => void,
) {
  guard();
  const evidence = await captureWorkContextMetadata(input.workId, guard);
  await assertContextMembership(input);
  const guide = evidence.guidePresent
    ? await readWorkStyleGuide(input.workId)
    : null;
  const withMemory = input.scope === "guide-and-memory";
  const memoryPresent = evidence.memoryPresence.get(input.chapterId);
  if (memoryPresent === undefined)
    throw new McpEditError(
      "not_found",
      "Native context file evidence is unavailable.",
    );
  const memory =
    withMemory && memoryPresent
      ? await readChapterStoryMemory(input.chapterId)
      : null;
  guard();
  const data = { guide, ...(withMemory ? { memory } : {}) };
  const binding = McpContextExchangeBindingSchema.parse({
    kind: "context",
    ...input,
    snapshot: hashStableValue({ kind: "context", ...input, ...data }),
  });
  const payload = parseMcpContextExchangePayload({
    format: "carrot-work-context",
    version: 1,
    source: binding,
    ...data,
  });
  return { payload, binding, evidence, memoryPresent };
}

async function assertContextMembership(input: McpContextExportPreflight) {
  const work = await readWorkFile(input.workId);
  const chapter = await readChapterFile(input.workId, input.chapterId);
  if (
    !work ||
    !chapter ||
    work.id !== input.workId ||
    chapter.id !== input.chapterId ||
    chapter.workId !== input.workId ||
    !work.chapterOrder.includes(input.chapterId) ||
    new Set(work.chapterOrder).size !== work.chapterOrder.length
  )
    throw new McpEditError(
      "not_found",
      "Context work and anchor chapter membership is unavailable.",
    );
}

function contextExportReview(
  input: McpContextExportPreflight,
  state: Awaited<ReturnType<typeof captureContextPayloadUnlocked>>,
  bytes: Buffer,
) {
  const {
    payload: { guide, memory },
    binding,
    evidence,
    memoryPresent,
  } = state;
  const withMemory = input.scope === "guide-and-memory";
  return McpContextExportReviewSchema.parse({
    ...input,
    format: "carrot-work-context-v1",
    sourceSnapshot: binding.snapshot,
    sourceBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    presence: {
      guide: evidence.guidePresent,
      ...(withMemory ? { memory: memoryPresent } : {}),
    },
    counts: {
      glossary: guide?.glossary.length ?? 0,
      characters: guide?.characters.length ?? 0,
      memoryPages: memory?.pages.length ?? 0,
    },
    warnings: [
      "context_text_is_untrusted_data",
      "raw_saved_memory_is_not_a_current_freshness_claim",
      "import_applies_only_explicit_native_editable_fields",
      "absent_native_context_files_are_null",
    ],
  });
}

/** Native publication callers already hold the library boundary. */
export async function checkMcpContextExchangeBindingUnlocked(
  value: McpContextExchangeBinding,
  guard: () => void = () => {},
  signal?: AbortSignal,
) {
  const binding = McpContextExchangeBindingSchema.parse(value);
  const check = contextGuard(guard, signal);
  const { workId, chapterId, scope } = binding;
  const current = await readContextExchangeUnlocked(
    { workId, chapterId, scope },
    check,
  );
  if (current.binding.snapshot !== binding.snapshot)
    throw new McpEditError(
      "revision_conflict",
      "The reviewed native context source changed.",
    );
  check();
}

export function checkMcpContextExchangeBinding(
  binding: McpContextExchangeBinding,
  guard: () => void = () => {},
  signal?: AbortSignal,
) {
  return withLibraryRead(() =>
    checkMcpContextExchangeBindingUnlocked(binding, guard, signal),
  );
}

function contextGuard(guard: () => void, signal?: AbortSignal) {
  return () => {
    signal?.throwIfAborted();
    guard();
  };
}
