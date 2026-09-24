import { withLibraryOwnedContentEdit } from "../library/lock";
import { pageContentResource } from "../../shared/appActivityTypes";
import { outputPathResource } from "../outputPathActivity";
import {
  createPageRevision,
  createPageVisualRevision,
} from "../../shared/pageRevision";
import { buildLinkedMirrorChapter } from "./linkedWorkspaceMirror";
import { writeLinkedWorkspaceMirror } from "./linkedWorkspaceFiles";
import { ReviewedOutputPublisher } from "./linkedWorkspaceReviewedOutputPublish";
import {
  ReviewedOutputError,
  type ReviewedOutputExecution,
  type ReviewedOutputResult,
} from "./linkedWorkspaceReviewedOutputTypes";
import type { PageExportRenderSession } from "../pageExport";
import type {
  NativeLinkedOutputOwner,
  ReviewedNativePage,
  ReviewedNativePlan,
} from "./linkedWorkspaceReviewedOutputInternal";

export async function executeReviewedOutput(
  owner: NativeLinkedOutputOwner,
  plan: ReviewedNativePlan,
  context: ReviewedOutputExecution,
) {
  const publisher = new ReviewedOutputPublisher(owner, plan, context);
  try {
    return await withLibraryOwnedContentEdit(
      [
        ...plan.review.mirrorScope.chapters.flatMap((chapter) =>
          chapter.pageIds.map((id) =>
            pageContentResource(chapter.chapterId, id),
          ),
        ),
        await outputPathResource(plan.rootPath, true),
      ],
      () => runReviewedOutput(publisher),
    );
  } catch (error) {
    owner.reportError("Reviewed linked output publication failed", error);
    return publisher.result(error);
  }
}

async function runReviewedOutput(publisher: ReviewedOutputPublisher) {
  await publisher.verify();
  const session = await publisher.owner.createRenderer();
  let cancellationFailure: unknown;
  let closeFailure: unknown;
  let outcome: { result: ReviewedOutputResult } | { error: unknown };
  const cancel = () => {
    try {
      session.cancel?.();
    } catch (error) {
      cancellationFailure = error;
    }
  };
  publisher.context.signal.addEventListener("abort", cancel, { once: true });
  if (publisher.context.signal.aborted) cancel();
  try {
    for (const [index, page] of publisher.plan.pages.entries()) {
      await publishPage(publisher, session, page, index);
    }
    await publishMirror(publisher);
    publisher.context.onProgress?.({
      phase: "done",
      completed: publisher.plan.pages.length,
      total: publisher.plan.pages.length,
    });
    outcome = { result: publisher.result() };
  } catch (error) {
    outcome = { error };
  } finally {
    publisher.context.signal.removeEventListener("abort", cancel);
    try {
      session.close();
    } catch (error) {
      closeFailure = error;
    }
  }
  if (cancellationFailure || closeFailure)
    throw new AggregateError(
      [
        "error" in outcome ? outcome.error : undefined,
        cancellationFailure,
        closeFailure,
      ].filter(Boolean),
      "Reviewed output renderer cleanup failed.",
    );
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

async function publishPage(
  publisher: ReviewedOutputPublisher,
  session: PageExportRenderSession,
  page: ReviewedNativePage,
  index: number,
) {
  publisher.guard();
  await publisher.verify(page.page.id);
  const record = publisher.state.records.find(
    (record) => record.id === page.recordId,
  );
  if (!record) throw new ReviewedOutputError("destination_changed");
  publisher.context.onProgress?.({
    phase: "rendering",
    completed: index,
    total: publisher.plan.pages.length,
  });
  const content = await session.renderPage(page.page, {
    format: page.captureFormat,
    resolutionMode: "original",
    ...(page.captureFormat === "jpeg"
      ? { quality: record.output.jpegQuality }
      : page.captureFormat === "webp"
        ? { quality: record.output.webpQuality }
        : {}),
  });
  await publisher.verify(page.page.id);
  for (const file of page.files) {
    publisher.context.onProgress?.({
      phase: "publishing",
      completed: index,
      total: publisher.plan.pages.length,
    });
    await publisher.publish(
      file,
      file.role === "result" && file.action === "publish" ? content : undefined,
    );
  }
  await publishRegistry(publisher, nextPageRecords(publisher, page));
}

function nextPageRecords(
  publisher: ReviewedOutputPublisher,
  page: ReviewedNativePage,
) {
  const next = structuredClone(publisher.state.records);
  const changed = next.find((record) => record.id === page.recordId);
  if (!changed) throw new ReviewedOutputError("destination_changed");
  const artifacts = { ...changed.artifacts[page.page.id] };
  for (const file of page.files.filter((file) => file.action === "publish")) {
    if (
      !file.relativePath ||
      !file.desired ||
      file.role === "mirror" ||
      file.role === "registry"
    )
      throw new ReviewedOutputError("publication_failed");
    artifacts[file.role] = {
      path: file.relativePath,
      ...file.desired,
      ...(file.sourcePath ? { sourcePath: file.sourcePath } : {}),
    };
  }
  if (!page.page.inpaintedImagePath) delete artifacts.inpainted;
  if (!page.page.inpaintMaskPath) delete artifacts.mask;
  changed.artifacts[page.page.id] = artifacts;
  changed.publishedRevisions[page.page.id] = createPageVisualRevision(
    page.page,
  );
  changed.updatedAt = new Date().toISOString();
  return next;
}

async function publishMirror(publisher: ReviewedOutputPublisher) {
  await publisher.verify();
  const chapters = publisher.state.records.map((record) => {
    const chapter = publisher.plan.chapters.find(
      (item) => item.id === record.chapterId,
    );
    if (!chapter) throw new ReviewedOutputError("selection_changed");
    return buildLinkedMirrorChapter(
      record,
      chapter,
      publisher.plan.workTitles.get(record.workId) ?? "",
    );
  });
  const file = publisher.plan.files.find((file) => file.role === "mirror");
  if (!file) throw new ReviewedOutputError("publication_failed");
  publisher.context.onProgress?.({
    phase: "mirror",
    completed: publisher.plan.pages.length,
    total: publisher.plan.pages.length,
  });
  await writeLinkedWorkspaceMirror({
    rootPath: publisher.plan.rootPath,
    appVersion: publisher.owner.appVersion(),
    chapters,
    publication: publisher.hooks(file),
  });
  const next = structuredClone(publisher.state.records);
  for (const record of next) {
    const chapter = publisher.plan.chapters.find(
      (item) => item.id === record.chapterId,
    );
    if (!chapter) throw new ReviewedOutputError("selection_changed");
    for (const page of chapter.pages)
      record.publishedMirrorRevisions[page.id] = createPageRevision(page);
    record.updatedAt = new Date().toISOString();
  }
  await publishRegistry(publisher, next);
}

async function publishRegistry(
  publisher: ReviewedOutputPublisher,
  next: ReviewedOutputPublisher["state"]["records"],
) {
  publisher.guard();
  const file = publisher.registryFile();
  await publisher.owner.commit(
    publisher.state.records,
    next,
    publisher.hooks(file, () => {
      publisher.state.records = next;
    }),
  );
}
