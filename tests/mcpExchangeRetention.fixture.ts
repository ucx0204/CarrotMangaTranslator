import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { retentionFixture } from "./mcpRetention.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import type { McpTool } from "../src/main/mcp/mcpReadTools";

export const artifactToken = (url: string) =>
  new URL(url).pathname.split("/")[2];
export type RetainedLink = {
  id: string;
  url: string;
  bytes: number;
  mimeType: string;
  sha256: string;
};
type Caller = NonNullable<Parameters<McpTool["invoke"]>[1]>;

/** Real encrypted retention, serializers, source checks and streaming. */
export async function exchangeRetentionFixture() {
  const f = await retentionFixture();
  const { createMcpRetentionSession } =
    await import("../src/main/mcp/mcpRetentionSession");
  const text = await import("../src/main/mcp/mcpTextExportSource");
  const context = await import("../src/main/mcp/mcpContextExchangeSource");
  const workFile = await import("../src/main/mcp/mcpWorkFileExportSource");
  const { readMcpExportSourceName } =
    await import("../src/main/mcp/mcpSourceExport");
  const { setImageRedactionEnabled } =
    await import("../src/main/imageRedactionStore");
  const sessions = new Set<ReturnType<typeof createMcpRetentionSession>>();
  const session = (images = false) => {
    const value = createMcpRetentionSession(
      f.storage,
      f.operations().artifacts,
      f.app,
      f.editing,
      false,
      images,
    );
    sessions.add(value);
    return value;
  };
  const invoke = async <T>(
    current: ReturnType<typeof session>,
    name: string,
    args: Record<string, unknown>,
    caller: Caller = f.auth(),
  ): Promise<T> => {
    const tool = current.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing retained tool ${name}`);
    const response = await tool.invoke(args, caller);
    const content = response.find((item) => item.type === "text");
    if (!content || content.type !== "text")
      throw new Error("Expected structured text");
    return JSON.parse(content.text) as T;
  };
  const owned = async <T extends { retainedOutputId?: string }>(
    name: string,
    run: () => Promise<T>,
  ) => {
    const wrap = f.operations().wrapTool;
    if (!wrap) throw new Error("Native retained publication must be connected");
    let output: T | undefined;
    const tool = wrap({
      name,
      description: "Native exchange retained-output integration",
      inputSchema: { type: "object" },
      readOnly: true,
      requiredScopes: ["carrot.read"],
      invoke: async () => {
        output = await run();
        return [];
      },
    });
    await tool.invoke({ requestId: randomUUID() }, f.auth());
    if (!output?.retainedOutputId)
      throw new Error("Expected durable output identity");
    return { ...output, id: output.retainedOutputId };
  };
  const prepare = (kind: "text" | "context") =>
    kind === "text"
      ? text.readMcpTextExportSource(
          {
            chapterId: "chapter",
            options: { format: "csv", includeBom: true },
          },
          () => {},
        )
      : context.readMcpContextExchangeState(
          { workId: "work", chapterId: "chapter", scope: "guide-and-memory" },
          () => {},
        );
  const publish = async (kind: "text" | "context") => {
    const source = await prepare(kind);
    const output = await owned(
      kind === "text"
        ? "carrot_export_text_file"
        : "carrot_export_context_json",
      () =>
        f
          .operations()
          .artifacts.putExchange(
            source.bytes,
            source.binding,
            source.verifySources,
            new AbortController().signal,
          ),
    );
    return { ...output, source };
  };
  const image = async (bytes?: Buffer) => {
    const page = (await f.snapshot()).pages[0];
    return owned("carrot_export_page_png", () =>
      f
        .operations()
        .artifacts.put(
          bytes ?? Buffer.from("renderer PNG output boundary"),
          async () => {},
          {
            chapterId: "chapter",
            pageId: page.id,
            revision: createPageRevision(page),
            sourceNameFingerprint:
              readMcpExportSourceName(page).sourceNameFingerprint,
          },
        ),
    );
  };
  const zip = (url: string) =>
    owned("carrot_create_export_zip", () =>
      f
        .operations()
        .artifacts.zip(
          [{ url, filename: "001.png" }],
          {},
          async () => {},
          new AbortController().signal,
        ),
    );
  const work = async () => {
    const state = await workFile.readMcpWorkFileExportState(
      { workId: "work", chapterIds: ["chapter"] },
      () => {},
    );
    const binding = {
      workId: state.review.workId,
      chapterIds: state.review.chapterIds,
      snapshot: state.review.snapshot,
    };
    return owned("carrot_export_work_file", () =>
      f.operations().artifacts.putWorkFile(
        (path, signal) =>
          workFile.writeMcpWorkFileExport(binding, path, () => {}, signal),
        128 * 1024 * 1024,
        async () => {},
        new AbortController().signal,
        state.bindings,
        binding,
      ),
    );
  };
  const closeSessions = async () => {
    await Promise.all([...sessions].map((value) => value.close()));
    sessions.clear();
  };
  return {
    ...f,
    session,
    invokeRetained: invoke,
    prepare,
    publish,
    image,
    zip,
    work,
    redaction: (enabled: boolean) =>
      setImageRedactionEnabled(enabled, f.env.root),
    issue: (current: ReturnType<typeof session>, id: string, caller?: Caller) =>
      invoke<RetainedLink>(current, "carrot_get_output_file", { id }, caller),
    read: (link: { url: string }) =>
      f.operations().artifacts.read(artifactToken(link.url)),
    savedBytes: (id: string, sha256: string) =>
      f.storage.path(id, sha256).then((path) => readFile(path)),
    restart: async () => {
      await closeSessions();
      await f.restart();
    },
    close: async () => {
      await closeSessions();
      await f.close();
    },
  };
}

export async function collectRetained(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
