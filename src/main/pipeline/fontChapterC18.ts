import { mkdir, mkdtemp, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppPaths } from "../appPaths";
import {
  isJapaneseLanguageCode,
  isKoreanLanguageCode,
} from "../../shared/translationLanguages";
import manifest from "./fontChapterC18Manifest.json";
import {
  buildFontChapterC18Input,
  fontChapterItemIdentity,
} from "./fontChapterC18Input";
import { launchFontChapterC18Worker } from "./fontChapterC18Worker";
import type {
  FontChapterC18Page,
  FontChapterC18Port,
  FontChapterC18Resolver,
  FontChapterC18Style,
} from "./fontChapterC18Types";
import { logPipelineInfo } from "./pipelineLogger";

const resultSchema = z.object({
  version: z.literal("c18.1"),
  choices: z.array(
    z.object({
      key: z.string(),
      groupId: z.string(),
      fontId: z.string(),
      fontWeight: z.union([z.literal(400), z.literal(700)]),
      italic: z.literal(false),
    }),
  ),
});

export function createFontChapterC18Port(paths: AppPaths): FontChapterC18Port {
  return { prepare: (pages, signal) => prepareChapter(paths, pages, signal) };
}

async function prepareChapter(
  paths: AppPaths,
  entries: readonly FontChapterC18Page[],
  signal: AbortSignal,
): Promise<FontChapterC18Resolver | undefined> {
  const selected = entries.filter(
    ({ pageOptions: o }) =>
      o.autoFontMatching &&
      isKoreanLanguageCode(o.targetLanguage) &&
      isJapaneseLanguageCode(o.sourceLanguage),
  );
  const first = selected[0];
  if (!first) return undefined;
  const assets = join(paths.dataRoot, "font-chapter-c18/v1");
  // Missing installation is an explicit failure, never an old-font success.
  await access(join(assets, "ownership.json"));
  const input = await buildFontChapterC18Input(selected, signal);
  if (input.identities.size === 0) return undefined;
  const parent = join(paths.dataRoot, "cache/font-chapter-c18");
  await mkdir(parent, { recursive: true });
  const job = await mkdtemp(join(parent, "chapter-"));
  const request = join(job, "request.json");
  const manifestPath = join(job, "manifest.json");
  const options = {
    ...first.pageOptions,
    ocrPipeline: "hayai" as const,
    ocrRuntimeDir: paths.ocrRuntimeDir,
    workingDir: paths.dataRoot,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    request,
    JSON.stringify({
      pages: input.pages,
      assets,
      manifest: manifestPath,
      output: join(job, "analysis"),
      workingDir: paths.dataRoot,
      hayaiScript: join(paths.runtimeDir, "hayai-bboxes.py"),
      ocrDevice: options.ocrDevice === "gpu" ? "gpu" : "cpu",
    }),
  );
  signal.throwIfAborted();
  const worker = await launchFontChapterC18Worker(paths, options);
  try {
    const { response } = worker.startRequest({ request }, signal);
    const result = await response;
    if (!result.ok)
      throw new Error(`C18 chapter font matching failed: ${result.error}`);
    const parsed = resultSchema.parse(result.result);
    const resolver = bindChoices(parsed.choices, input.identities);
    logPipelineInfo("C18 chapter palette ready", {
      version: parsed.version,
      pages: selected.length,
      choices: parsed.choices.length,
      elapsedMs: result.elapsed_ms,
      job,
    });
    return resolver;
  } finally {
    await worker.dispose();
  }
}

function bindChoices(
  choices: z.infer<typeof resultSchema>["choices"],
  identities: Awaited<
    ReturnType<typeof buildFontChapterC18Input>
  >["identities"],
): FontChapterC18Resolver {
  const pages = new Map<string, Map<string, FontChapterC18Style>>();
  const seen = new Set<string>();
  for (const choice of choices) {
    const identity = identities.get(choice.key);
    if (!identity || seen.has(choice.key))
      throw new Error("C18 source inventory mismatch.");
    seen.add(choice.key);
    const page =
      pages.get(identity.pageId) ?? new Map<string, FontChapterC18Style>();
    page.set(identity.identity, {
      fontId: choice.fontId,
      fontWeight: choice.fontWeight,
      italic: choice.italic,
      groupId: choice.groupId,
      runtimeVersion: "c18.1",
    });
    pages.set(identity.pageId, page);
  }
  if (seen.size !== identities.size)
    throw new Error("Incomplete C18 source inventory.");
  return (pageId, item) =>
    pages.get(pageId)?.get(fontChapterItemIdentity(item));
}
