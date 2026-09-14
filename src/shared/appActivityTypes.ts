export type AppActivityResourceKind =
  | "model-runtime"
  | "codex-auth"
  | "page-content"
  | "library-structure"
  | "work-context"
  | "output-path";

export type AppActivityResource = {
  kind: AppActivityResourceKind;
  scope: string;
  access: "read" | "write";
};

type AppActivitySnapshot = {
  id: string;
  ownerId?: string;
  category: "job" | "operation";
  kind: string;
  mutatesLibrary: boolean;
  blocksQuit: boolean;
  startedAt: number;
  resources?: readonly AppActivityResource[];
};

export type PageProcessingActivity = {
  jobId: string;
  chapterId: string;
  pageId: string;
  phase:
    | "queued"
    | "finishing-edits"
    | "waiting"
    | "processing"
    | "completed"
    | "failed";
  requestId?: string;
  reason?: string;
};

export type AppActivityState = {
  version: number;
  activities: AppActivitySnapshot[];
  pages: PageProcessingActivity[];
};

export type PageEditHandoffResponse = {
  requestId: string;
  error?: string;
};

export function activityResourcesConflict(
  left: readonly AppActivityResource[] | undefined,
  right: readonly AppActivityResource[] | undefined,
): boolean {
  // Entries which have not declared their effects remain exclusive.
  if (!left || !right) return true;
  return left.some((a) =>
    right.some(
      (b) =>
        a.kind === b.kind &&
        (a.scope === b.scope ||
          a.scope === "*" ||
          b.scope === "*" ||
          ((a.kind === "output-path" || a.kind === "page-content") &&
            (pathScopeContains(a.scope, b.scope) ||
              pathScopeContains(b.scope, a.scope)))) &&
        (a.access === "write" || b.access === "write"),
    ),
  );
}

function pathScopeContains(directory: string, path: string): boolean {
  return directory.endsWith("/**") && path.startsWith(directory.slice(0, -2));
}

export function pageContentResource(
  chapterId: string,
  pageId: string,
): AppActivityResource {
  return {
    kind: "page-content",
    scope: `${chapterId}/${pageId}`,
    access: "write",
  };
}

export function libraryStructureResource(
  type: "work" | "chapter" | "page",
  id: string,
  access: "read" | "write" = "write",
): AppActivityResource {
  return { kind: "library-structure", scope: `${type}:${id}`, access };
}

export function activityConflictReason(
  resource: AppActivityResourceKind,
): string {
  switch (resource) {
    case "model-runtime":
      return "다른 작업이 모델을 사용 중입니다.";
    case "codex-auth":
      return "ChatGPT 계정을 사용하는 작업이 진행 중입니다.";
    case "page-content":
      return "이 페이지를 처리하거나 결과를 저장 중입니다.";
    case "work-context":
      return "이 작품의 번역 문맥을 사용 중입니다.";
    case "library-structure":
      return "대기 중이거나 실행 중인 작업이 이 대상을 참조합니다.";
    case "output-path":
      return "이 경로에 파일을 내보내는 작업이 진행 중입니다.";
  }
}
