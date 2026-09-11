import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  ConfirmImageRedaction,
  ImageRedactionPage,
} from "../../shared/imageRedaction";
import {
  DEFAULT_REDACTION_VIEW,
  redactionWorkspaceSchema,
  saveRedactionWorkspaceSchema,
  type RedactionWorkspace,
  type SaveRedactionWorkspace,
  type RedactionView,
} from "../../shared/imageRedactionWorkspace";
import type { RedactionWorkspacePorts } from "./redactionWorkspacePorts";
import {
  applyRedactionDraftChanges,
  assertRedactionDraftPagesCurrent,
  observeRedactionDraft,
  type RedactionDraftBaseline,
  type StoredRedactionPage,
} from "./redactionWorkspaceMerge";

type Session = {
  root: string;
  scopeKey: string;
  workspace: RedactionWorkspace;
  baseline: RedactionDraftBaseline;
  pages: Map<string, ImageRedactionPage>;
  controller: AbortController;
};
export class RedactionWorkspaceApplicationService {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<RedactionWorkspace>>();

  constructor(private readonly ports: RedactionWorkspacePorts) {}

  open(
    pages: ImageRedactionPage[],
    sessionId: string,
    root: string,
  ): Promise<RedactionWorkspace> {
    const current = this.sessions.get(sessionId);
    if (current) return Promise.resolve(current.workspace);
    const pending = this.opening.get(sessionId);
    if (pending) return pending;
    const operation = this.createSession(pages, sessionId, root).finally(() =>
      this.opening.delete(sessionId),
    );
    this.opening.set(sessionId, operation);
    return operation;
  }

  private async createSession(
    pages: ImageRedactionPage[],
    sessionId: string,
    root: string,
  ): Promise<RedactionWorkspace> {
    if (
      !pages.length ||
      pages.length > 10000 ||
      new Set(pages.map((page) => page.id)).size !== pages.length
    )
      throw new Error("가리기 작업의 페이지 목록이 올바르지 않습니다.");
    const state = await this.ports.readDraft(root);
    const approved = await this.ports.readApproved(root);
    const paths = pages.map((page) => resolve(page.imagePath));
    const scopeKey = createHash("sha256")
      .update([...paths].sort().join("\0"))
      .digest("hex");
    const restored = pages.map((page) => {
      const draft = state.pages[resolve(page.imagePath)];
      if (
        draft?.fingerprint === page.fingerprint &&
        draft.width === page.width &&
        draft.height === page.height
      )
        return { ...page, strokes: draft.strokes, decision: draft.decision };
      const previous = approved.pages[page.imagePath];
      return {
        ...page,
        strokes:
          previous?.fingerprint === page.fingerprint
            ? previous.strokes
            : page.strokes,
        decision:
          previous?.fingerprint === page.fingerprint
            ? ("reviewed" as const)
            : ("unreviewed" as const),
      };
    });
    const workspace = redactionWorkspaceSchema.parse({
      sessionId,
      revision: state.revision,
      pages: restored,
      view: normalizeView(state.views[scopeKey], pages),
      preferences: state.preferences,
      presets: state.presets,
    });
    this.sessions.set(sessionId, {
      root,
      scopeKey,
      workspace,
      baseline: observeRedactionDraft(state, paths, scopeKey),
      pages: new Map(pages.map((page) => [page.id, page])),
      controller: new AbortController(),
    });
    return workspace;
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session)
      throw new Error(
        "가리기 편집 세션이 만료되었습니다. 저장한 초안을 다시 열어 주세요.",
      );
    session.controller.signal.throwIfAborted();
    return session;
  }

  getPage(sessionId: string, pageId: string) {
    const session = this.requireSession(sessionId);
    const page = session.pages.get(pageId);
    if (!page) throw new Error("가리기 작업에 포함되지 않은 페이지입니다.");
    return { page, signal: session.controller.signal };
  }

  async save(input: SaveRedactionWorkspace): Promise<number> {
    const request = saveRedactionWorkspaceSchema.parse(input);
    const session = this.requireSession(request.sessionId);
    validateSaveScope(session, request);
    let baseline = session.baseline;
    const revision = await this.ports.updateDraft(
      session.root,
      async (state) => {
        this.requireSession(request.sessionId);
        if (request.expectedRevision !== session.workspace.revision)
          throw new Error("최신 가리기 초안을 저장한 뒤 다시 확인해 주세요.");
        const pages = await this.readChangedDraftPages(session, request);
        this.requireSession(request.sessionId);
        baseline = applyRedactionDraftChanges(state, session.baseline, {
          previous: session.workspace,
          request,
          pages,
        });
      },
    );
    const changes = new Map(
      request.changes.map((document) => [document.id, document]),
    );
    session.baseline = baseline;
    session.workspace = {
      ...session.workspace,
      revision,
      view: request.view,
      preferences: request.preferences,
      presets: request.presets,
      pages: session.workspace.pages.map((page) => ({
        ...page,
        ...changes.get(page.id),
      })),
    };
    return revision;
  }

  private async readChangedDraftPages(
    session: Session,
    request: SaveRedactionWorkspace,
  ): Promise<Record<string, StoredRedactionPage>> {
    const changes: Record<string, StoredRedactionPage> = {};
    for (let offset = 0; offset < request.changes.length; offset += 4)
      await Promise.all(
        request.changes.slice(offset, offset + 4).map(async (document) => {
          const page = session.pages.get(document.id);
          if (
            !page ||
            document.fingerprint !== page.fingerprint ||
            (await this.ports.fingerprint(page.imagePath)) !== page.fingerprint
          )
            throw new Error(
              "확인한 원본 이미지가 변경되었습니다. 해당 페이지를 다시 열어 주세요.",
            );
          changes[resolve(page.imagePath)] = {
            fingerprint: document.fingerprint,
            strokes: document.strokes,
            decision: document.decision,
            width: page.width,
            height: page.height,
          };
        }),
      );
    return changes;
  }

  /** A persisted draft is not permission to send; final confirmation binds the entire snapshot. */
  async assertConfirmation(request: ConfirmImageRedaction): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      if (request.workspaceRevision !== undefined)
        throw new Error("가리기 확인 세션이 만료되었습니다.");
      return;
    }
    this.requireSession(request.sessionId);
    const disk = await this.ports.readDraft(session.root);
    if (request.workspaceRevision !== session.workspace.revision)
      throw new Error("최신 가리기 초안을 저장한 뒤 다시 확인해 주세요.");
    assertRedactionDraftPagesCurrent(disk, session.baseline);
    const patches = new Map(request.pages.map((page) => [page.id, page]));
    if (
      patches.size !== session.pages.size ||
      patches.size !== request.pages.length
    )
      throw new Error("확인할 페이지 목록이 다릅니다.");
    for (const page of session.workspace.pages) {
      const patch = patches.get(page.id);
      if (
        !patch ||
        page.decision !== "reviewed" ||
        patch.fingerprint !== page.fingerprint ||
        JSON.stringify(patch.strokes) !== JSON.stringify(page.strokes)
      )
        throw new Error("미확인 또는 변경된 가리기 페이지가 남아 있습니다.");
    }
  }

  async close(sessionId: string): Promise<boolean> {
    const pending = this.opening.get(sessionId);
    if (pending) {
      try {
        await pending;
      } catch (error) {
        this.ports.reportCleanupError(
          "Manual redaction session initialization failed during cleanup",
          error,
        );
      }
    }
    const session = this.sessions.get(sessionId);
    session?.controller.abort(new Error("Manual redaction workspace closed"));
    return this.sessions.delete(sessionId);
  }
}

function normalizeView(
  view: RedactionView | undefined,
  pages: ImageRedactionPage[],
): RedactionView {
  const ids = new Set(pages.map((page) => page.id));
  const source = view ?? {
    ...DEFAULT_REDACTION_VIEW,
    mode: pages.length > 12 ? ("grid" as const) : ("edit" as const),
  };
  return {
    ...source,
    currentId: ids.has(source.currentId) ? source.currentId : pages[0].id,
    selectedIds: source.selectedIds.filter((id) => ids.has(id)),
    pageViews: Object.fromEntries(
      Object.entries(source.pageViews).filter(([id]) => ids.has(id)),
    ),
  };
}

function validateSaveScope(
  session: Session,
  request: SaveRedactionWorkspace,
): void {
  const ids = request.changes.map((document) => document.id);
  const viewIds = [
    request.view.currentId,
    ...request.view.selectedIds,
    ...Object.keys(request.view.pageViews),
  ];
  if (
    new Set(ids).size !== ids.length ||
    [...ids, ...viewIds].some((id) => !session.pages.has(id))
  )
    throw new Error("가리기 초안의 페이지 목록이 다릅니다.");
  if (
    new Set(request.presets.map((preset) => preset.id)).size !==
    request.presets.length
  )
    throw new Error("가리기 프리셋이 중복되었습니다.");
}
