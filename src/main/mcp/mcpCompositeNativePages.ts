import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import {
  McpCompositePagesSchema,
  type McpCompositePage,
  type McpCompositePrepare,
} from "../../shared/mcpCompositeWorkflow";
import type { AppSettings } from "../../shared/settingsTypes";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import type {
  McpCompositeGuard,
  McpCompositeSnapshot,
} from "../application/mcpCompositeWorkflowPorts";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import { mcpBatchMembership } from "../application/mcpPageBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { readWorkContextForEdit } from "../library";
import {
  captureRetainedPage,
  verifyRetainedFiles,
} from "./mcpRetentionEvidence";
import { readMcpCompositeFontEnvironment } from "./mcpCompositeNativeFonts";
import { workflowSettingsFingerprint } from "./mcpWorkflowEvidence";

type Saved = Awaited<ReturnType<typeof readWorkContextForEdit>>;
export type McpCompositeNativePage = {
  target: McpCompositePage;
  saved: Saved;
  page: Saved["chapter"]["pages"][number];
  state: Awaited<ReturnType<typeof captureRetainedPage>>;
};
export type McpCompositeSourceOptions = {
  settings: () => AppSettings | Promise<AppSettings>;
  preferences: Pick<
    McpPreferences,
    "allowEditing" | "allowProcessing" | "allowImages"
  >;
  readContext?: typeof readWorkContextForEdit;
  readFonts?: typeof readMcpCompositeFontEnvironment;
  requirements?: (plan: McpCompositePrepare) => readonly string[];
};

/** One common font/settings environment per selected-page snapshot, never one font scan per page. */
export async function readMcpCompositeSources(
  targets: McpCompositePage[],
  plan: McpCompositePrepare,
  guard: McpCompositeGuard,
  options: McpCompositeSourceOptions,
) {
  const requirements = options.requirements?.(plan) ?? ["carrot.read"];
  guard(requirements);
  if (targets.length) McpCompositePagesSchema.parse(targets);
  const settings = await options.settings();
  const settingsFingerprint = compositeSettings(settings);
  const fontFingerprint = await (
    options.readFonts ?? readMcpCompositeFontEnvironment
  )(guard);
  const policyFingerprint = compositeFingerprint({
    settingsFingerprint,
    fontFingerprint,
    permissions: options.preferences,
    authorizedRequirements: requirements,
    phases: plan.phases,
    budgets: plan.budgets,
  });
  const values: McpCompositeNativePage[] = [];
  for (const target of targets)
    values.push(
      await readPage(
        target,
        guard,
        options.readContext ?? readWorkContextForEdit,
      ),
    );
  const pages: McpCompositeSnapshot["pages"] = values.map(
    ({ target, page, saved, state }) => ({
      ...target,
      revision: createPageRevision(page),
      reviewRevision: createSoundEffectReviewPageRevision(page),
      sourceFingerprint: compositePageSourceFingerprint(state, page.blocks),
      membershipFingerprint: membershipFingerprint(saved),
      memoryFingerprint: memoryFingerprint(saved),
      contextFingerprint: compositeFingerprint(mcpContextRevision(saved)),
      settingsFingerprint,
      fontFingerprint,
    }),
  );
  for (const value of values)
    await verifyPage(
      value,
      guard,
      options.readContext ?? readWorkContextForEdit,
    );
  if (settingsFingerprint !== compositeSettings(await options.settings()))
    throw changed();
  guard();
  const snapshot = {
    pages,
    policyFingerprint,
    fingerprint: compositeFingerprint({ pages, policyFingerprint }),
  };
  return { snapshot, values, settings };
}
async function readPage(
  target: McpCompositePage,
  guard: McpCompositeGuard,
  read: typeof readWorkContextForEdit,
) {
  guard();
  const saved = await read(target.chapterId);
  const page = saved.chapter.pages.find((item) => item.id === target.pageId);
  if (
    !page ||
    saved.workId !== target.workId ||
    saved.chapter.workId !== target.workId ||
    saved.chapter.id !== target.chapterId
  )
    throw new McpEditError(
      "not_found",
      "An explicit composite page no longer belongs to its saved work and chapter.",
    );
  if (
    target.blockIds.some((id) => !page.blocks.some((block) => block.id === id))
  )
    throw changed();
  const state = await captureRetainedPage(page);
  guard();
  return { target: structuredClone(target), saved, page, state };
}
async function verifyPage(
  value: McpCompositeNativePage,
  guard: McpCompositeGuard,
  read: typeof readWorkContextForEdit,
) {
  guard();
  await verifyRetainedFiles(value.state.files);
  const latest = await read(value.target.chapterId);
  const page = latest.chapter.pages.find(
    (item) => item.id === value.target.pageId,
  );
  if (
    !page ||
    latest.workId !== value.saved.workId ||
    mcpContextRevision(latest) !== mcpContextRevision(value.saved) ||
    membershipFingerprint(latest) !== membershipFingerprint(value.saved) ||
    memoryFingerprint(latest) !== memoryFingerprint(value.saved) ||
    createPageRevision(page) !== createPageRevision(value.page) ||
    createSoundEffectReviewPageRevision(page) !==
      createSoundEffectReviewPageRevision(value.page)
  )
    throw changed();
}
function compositeSettings(settings: AppSettings) {
  const { tavilyApiKey: _key, ...research } = settings.internetResearch;
  return compositeFingerprint({
    workflow: workflowSettingsFingerprint(settings),
    research,
    ui: settings.ui,
    styles: settings.blockStylePresets,
    styleGroups: settings.blockStylePresetGroups,
    generationLimits: settings.generationLimits,
  });
}
function memoryFingerprint(saved: Saved) {
  const { updatedAt: _updated, ...memory } = saved.storyMemory;
  return compositeFingerprint(memory);
}
function membershipFingerprint(saved: Saved) {
  return compositeFingerprint({
    membership: mcpBatchMembership(saved.chapter),
    title: saved.chapter.title,
    names: saved.chapter.pages.map(({ id, name, sourceFileName }) => ({
      id,
      name,
      sourceFileName,
    })),
  });
}
/** Inline native lettering is a persisted render asset, including inactive values. */
export function compositePageSourceFingerprint(
  state: Pick<Awaited<ReturnType<typeof captureRetainedPage>>, "files">,
  blocks: ReadonlyArray<
    Pick<
      Saved["chapter"]["pages"][number]["blocks"][number],
      "id" | "generatedLettering"
    >
  >,
) {
  const lettering = blocks
    .filter((block) => block.generatedLettering)
    .map((block) => ({
      blockId: block.id,
      sha256: compositeFingerprint(block.generatedLettering),
    }));
  return compositeFingerprint({ files: state.files, lettering });
}
function changed() {
  return new McpEditError(
    "revision_conflict",
    "Composite page, source bytes, block membership, context or settings changed during inspection.",
  );
}
