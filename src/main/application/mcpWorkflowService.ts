import { createMcpOwnedRunCompletion } from "./mcpOwnedRunCompletion";
import { McpWorkflowRunSchema } from "../../shared/mcpWorkflow";
import { MCP_WORKFLOW_ACTION_CAPACITY } from "../../shared/mcpWorkflow";
import type {
  McpWorkflowPrepare,
  McpWorkflowRun,
  McpWorkflowExternal,
} from "../../shared/mcpWorkflow";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";
import {
  assertWorkflowVersion,
  workflowView,
  type McpWorkflowRecord,
} from "./mcpWorkflowPolicy";
import {
  persistWorkflow,
  runMcpWorkflow,
  type McpWorkflowRunnerPort,
  type McpWorkflowActive,
} from "./mcpWorkflowRunner";

type Repository = {
  find: (
    owner: string,
    input: McpWorkflowPrepare,
  ) => Promise<McpWorkflowRecord | undefined>;
  create: (
    owner: string,
    input: McpWorkflowPrepare,
    pages: McpWorkflowRecord["pages"],
    settings: string,
    guard: () => void,
  ) => Promise<McpWorkflowRecord>;
  load: (owner: string, id: string) => Promise<McpWorkflowRecord>;
  save: McpWorkflowRunnerPort["save"];
  list: (owner: string) => Promise<McpWorkflowRecord[]>;
  discard: (
    owner: string,
    id: string,
    guard: () => void,
  ) => Promise<{ id: string; status: "discarded"; pageChanges: 0 }>;
};
type Port = Omit<McpWorkflowRunnerPort, "save"> & {
  repository: Repository;
  acquireRun?: (
    owner: string,
    input: McpWorkflowRun,
  ) => { release: () => void };
  prepare: (
    input: McpWorkflowPrepare,
    guard: () => void,
  ) => Promise<{ pages: McpWorkflowRecord["pages"]; settings: string }>;
};
/** Fixed plans coordinate existing native tools; they neither own a second GPU queue nor auto-resume. */
export class McpWorkflowService {
  private active?: McpWorkflowActive;
  private starting = false;
  private admission: Promise<void> = Promise.resolve();
  private stopped = false;
  readonly completion = createMcpOwnedRunCompletion({
    active: () => this.active,
    load: (owner, id) => this.port.repository.load(owner, id),
    parse: McpWorkflowRunSchema.parse,
    project: workflowView,
    evidence: (record) => record.pages,
  });
  private readonly runner: McpWorkflowRunnerPort;
  constructor(private readonly port: Port) {
    this.runner = { ...port, save: port.repository.save.bind(port.repository) };
  }
  private check() {
    if (this.stopped)
      throw new McpEditError("access_denied", "Workflow session is stopping.");
  }
  async prepare(owner: string, input: McpWorkflowPrepare, guard: () => void) {
    this.check();
    guard();
    const existing = await this.port.repository.find(owner, input);
    if (existing) {
      guard();
      return this.view(existing);
    }
    const { pages, settings } = await this.port.prepare(input, guard);
    this.check();
    guard();
    return this.view(
      await this.port.repository.create(owner, input, pages, settings, () => {
        this.check();
        guard();
      }),
    );
  }
  async get(owner: string, id: string, guard: () => void) {
    guard();
    this.check();
    const active = this.ownedActive(owner, id);
    if (active) return this.view(active.record);
    const record = await this.port.repository.load(owner, id);
    guard();
    return this.view(record);
  }
  async list(
    owner: string,
    input: { offset: number; limit: number; snapshot?: string },
    guard: () => void,
  ) {
    guard();
    this.check();
    const records = await this.port.repository.list(owner);
    const snapshot = hashStableValue(
      records.map((record) => [record.id, record.version]),
    );
    if (
      (input.offset > 0 && !input.snapshot) ||
      (input.snapshot && input.snapshot !== snapshot)
    )
      throw new McpEditError(
        "revision_conflict",
        "Workflow list changed. Restart pagination.",
      );
    guard();
    return {
      total: records.length,
      offset: input.offset,
      limit: input.limit,
      snapshot,
      nextOffset:
        input.offset + input.limit < records.length
          ? input.offset + input.limit
          : null,
      items: records
        .slice(input.offset, input.offset + input.limit)
        .map((record) => {
          const {
            pages: _pages,
            steps: _steps,
            ...summary
          } = this.view(record);
          return summary;
        }),
    };
  }
  async run(
    owner: string,
    input: McpWorkflowRun,
    authorize: (record: McpWorkflowRecord) => void,
  ) {
    this.assertAdmissionAvailable();
    const replay = this.activeRequest(owner, input, authorize);
    if (replay) return replay;
    return this.admit(async () => {
      const record = await this.port.repository.load(owner, input.id);
      authorize(record);
      this.check();
      if (
        knownRequest(record, input.requestId, hashStableValue(["run", input]))
      )
        return this.view(record);
      assertWorkflowVersion(record, input.version);
      if (
        record.status === "completed" ||
        record.steps.some((step) => step.status === "waiting_external")
      )
        throw new McpEditError(
          "invalid_edit",
          "Workflow is complete or waiting for explicit external-result acceptance.",
        );
      const lease = this.port.acquireRun?.(owner, input);
      try {
        remember(record, input.requestId, hashStableValue(["run", input]));
        record.status = "running";
        record.lastError = null;
        const active: McpWorkflowActive = {
          record,
          controller: new AbortController(),
          pause: false,
          done: Promise.resolve(),
        };
        this.active = active;
        try {
          await persistWorkflow(this.runner, record);
        } catch (error) {
          this.active = undefined;
          throw error;
        }
        active.done = runMcpWorkflow(
          this.runner,
          active,
          () => {
            this.check();
            authorize(record);
          },
          input.retryFailed,
        )
          .catch(this.port.reportError)
          .finally(() => {
            if (this.active === active) this.active = undefined;
            lease?.release();
          });
        return this.view(record);
      } catch (error) {
        lease?.release();
        throw error;
      }
    });
  }
  async control(
    owner: string,
    id: string,
    direction: "pause" | "cancel",
    guard: () => void,
  ) {
    guard();
    this.check();
    // Active control must not wait behind a native save that needs cancellation.
    const active = this.ownedActive(owner, id);
    if (active) {
      if (direction === "pause") active.pause = true;
      else active.controller.abort();
      return this.view(active.record);
    }
    return this.settled(async () => {
      const record = await this.port.repository.load(owner, id);
      guard();
      this.check();
      const status = direction === "pause" ? "paused" : "cancelled";
      if (record.status !== "completed" && record.status !== status) {
        record.status = status;
        await persistWorkflow(this.runner, record);
      }
      return this.view(record);
    });
  }
  async acceptExternal(
    owner: string,
    input: McpWorkflowExternal,
    guard: () => void,
  ) {
    guard();
    this.check();
    return this.settled(() => this.acceptSavedExternal(owner, input, guard));
  }
  private async acceptSavedExternal(
    owner: string,
    input: McpWorkflowExternal,
    guard: () => void,
  ) {
    const record = await this.port.repository.load(owner, input.id);
    const fingerprint = hashStableValue(["external", input]);
    if (knownRequest(record, input.requestId, fingerprint))
      return this.view(record);
    assertWorkflowVersion(record, input.version);
    const step = record.steps.find(
      (step) => step.status === "waiting_external",
    );
    if (
      !step ||
      input.page.chapterId !== step.chapterId ||
      input.page.pageId !== step.pageId
    )
      throw new McpEditError(
        "invalid_edit",
        "Accept only the currently waiting external page.",
      );
    const runtime = await this.port.open(record, guard);
    const page = await runtime.verify(record, step.pageIndex);
    guard();
    this.check();
    if (
      !page ||
      page.revision !== input.page.revision ||
      page.reviewRevision !== input.page.reviewRevision
    )
      throw new McpEditError(
        "revision_conflict",
        "Read the exact saved external result before accepting it.",
      );
    remember(record, input.requestId, fingerprint);
    record.pages[step.pageIndex] = page;
    step.status = "completed";
    step.outcome = "saved_external_page_acknowledged";
    record.status = "paused";
    await persistWorkflow(this.runner, record);
    return this.view(record);
  }
  async discard(owner: string, id: string, guard: () => void) {
    guard();
    this.check();
    return this.settled(() => this.port.repository.discard(owner, id, guard));
  }
  /** Native composition only. Settled mutations and handoff share run admission;
   * active cancellation and inspection deliberately stay outside this boundary. */
  settled<T>(run: () => Promise<T>): Promise<T> {
    if (this.active)
      throw new McpEditError(
        "editor_busy",
        "Wait for workflow cleanup before changing settled workflow state.",
      );
    return this.admit(run);
  }
  private assertAdmissionAvailable() {
    this.check();
    if (this.starting)
      throw new McpEditError(
        "editor_busy",
        "Another workflow admission is pending.",
      );
  }
  private async admit<T>(run: () => Promise<T>): Promise<T> {
    this.assertAdmissionAvailable();
    this.starting = true;
    let admitted!: () => void;
    this.admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    try {
      return await run();
    } finally {
      this.starting = false;
      admitted();
    }
  }
  stop() {
    this.stopped = true;
    this.active?.controller.abort();
  }
  async close() {
    this.stop();
    await this.admission;
    await this.active?.done;
  }
  private ownedActive(owner: string, id: string) {
    if (this.active?.record.id !== id) return undefined;
    if (this.active.record.owner !== owner)
      throw new McpEditError(
        "not_found",
        "Workflow is not owned by this connection.",
      );
    return this.active;
  }
  private activeRequest(
    owner: string,
    input: McpWorkflowRun,
    authorize: (record: McpWorkflowRecord) => void,
  ) {
    if (!this.active) return undefined;
    const active = this.ownedActive(owner, input.id);
    if (active) {
      authorize(active.record);
      if (
        knownRequest(
          active.record,
          input.requestId,
          hashStableValue(["run", input]),
        )
      )
        return this.view(active.record);
    }
    throw new McpEditError(
      "editor_busy",
      "A workflow is already running. Pause or cancel it first.",
    );
  }
  private view(record: McpWorkflowRecord) {
    return workflowView(
      record,
      this.active?.record.id === record.id ? this.active : undefined,
    );
  }
}
function knownRequest(
  record: McpWorkflowRecord,
  requestId: string,
  fingerprint: string,
) {
  const previous = record.requests.find(
    (request) => request.requestId === requestId,
  );
  if (previous && previous.fingerprint !== fingerprint)
    throw new McpEditError(
      "invalid_edit",
      "Workflow requestId belongs to a different action.",
    );
  return !!previous;
}
function remember(
  record: McpWorkflowRecord,
  requestId: string,
  fingerprint: string,
) {
  if (record.requests.length >= MCP_WORKFLOW_ACTION_CAPACITY)
    throw new McpEditError(
      "invalid_edit",
      "Workflow action receipt limit reached. Prepare a new explicit remaining-target plan.",
    );
  record.requests.push({ requestId, fingerprint });
}
