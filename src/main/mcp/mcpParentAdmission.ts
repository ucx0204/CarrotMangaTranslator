import { AsyncLocalStorage } from "node:async_hooks";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpWorkflowRun } from "../../shared/mcpWorkflow";
import type {
  McpCompositeBinding,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import { McpEditError } from "../application/mcpEditPolicy";

type Parent = { kind: "workflow" | "composite"; owner: string; id: string };
type Child = { parent: Parent; owner: string; id: string; fingerprint: string };

/** Rejects competing parent admissions; native children retain their existing queues and leases. */
export class McpParentAdmission {
  private active?: Parent;
  private readonly child = new AsyncLocalStorage<Child>();

  acquireComposite(record: McpCompositeRecord) {
    return this.acquire({
      kind: "composite",
      owner: record.owner,
      id: record.id,
    });
  }

  acquireWorkflow(owner: string, input: McpWorkflowRun) {
    const child = this.child.getStore();
    if (
      child &&
      this.active === child.parent &&
      child.owner === owner &&
      child.id === input.id &&
      child.fingerprint === hashStableValue(input)
    )
      return { release: () => {} };
    return this.acquire({ kind: "workflow", owner, id: input.id });
  }

  async executeChild<T>(
    binding: McpCompositeBinding,
    execute: () => Promise<T>,
  ) {
    const parent = this.active;
    if (
      parent?.kind !== "composite" ||
      parent.id !== binding.compositeId ||
      parent.owner !== binding.owner
    )
      throw new McpEditError(
        "editor_busy",
        "The exact composite parent admission is no longer active.",
      );
    const action = binding.action;
    if (action.kind !== "workflow-run") return execute();
    return this.child.run(
      {
        parent,
        owner: binding.owner,
        id: action.input.id,
        fingerprint: hashStableValue(action.input),
      },
      execute,
    );
  }

  isActive(id: string) {
    return this.active?.id === id;
  }

  assertDiscardable(id: string) {
    if (this.isActive(id))
      throw new McpEditError(
        "editor_busy",
        "The admitted parent and its native cleanup must settle before discard.",
      );
  }

  private acquire(parent: Parent) {
    if (this.active)
      throw new McpEditError(
        "editor_busy",
        "Another workflow or composite phase is still admitted. Wait for native cleanup.",
      );
    this.active = parent;
    return {
      release: () => {
        if (this.active === parent) this.active = undefined;
      },
    };
  }
}
