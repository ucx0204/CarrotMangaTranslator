import { McpCompositeChildReferenceSchema } from "../../shared/mcpCompositeWorkflow";
import { McpCompositeOutcomeSchema } from "../../shared/mcpCompositeWorkflowOutcome";
import { parseCompositeRecord } from "../application/mcpCompositeWorkflowRecord";
import { assertCompositeOutcome } from "../application/mcpCompositeWorkflowPolicy";
import type {
  McpCompositeRecord,
  McpCompositeSavedBinding,
  McpCompositeSettlement,
} from "../application/mcpCompositeWorkflowPorts";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  assertCompositeIdentity,
  sameCompositeValue,
} from "./mcpCompositeRepositoryValidation";

type Update = (
  change: (current: McpCompositeRecord) => McpCompositeRecord,
) => Promise<McpCompositeRecord>;
/** Issued after the exact native attempt and its budget commit. The native adapter
 * proves receipt identity/ownership and physically settles cleanup before finish/hold. */
export function createCompositeSettlement(
  initial: McpCompositeRecord,
  index: number,
  update: Update,
  now: () => number,
  release: () => void,
): McpCompositeSettlement {
  return new CompositeSettlement(
    structuredClone(initial),
    index,
    update,
    now,
    release,
  );
}

class CompositeSettlement implements McpCompositeSettlement {
  private readonly binding: McpCompositeSavedBinding;
  private readonly attemptId: string;
  private readonly phaseId: string;
  private physicallySettled = false;

  constructor(
    private readonly initial: McpCompositeRecord,
    private readonly index: number,
    private readonly update: Update,
    private readonly now: () => number,
    private readonly release: () => void,
  ) {
    const admitted = initial.phases[index];
    if (!admitted?.binding || !admitted.attemptId)
      throw new Error(
        "Composite settlement requires a durable native attempt.",
      );
    this.binding = admitted.binding;
    this.attemptId = admitted.attemptId;
    this.phaseId = admitted.id;
  }

  checkpointChild: McpCompositeSettlement["checkpointChild"] = async (
    input,
  ) => {
    const receipt = McpCompositeChildReferenceSchema.parse(input);
    assertCompositeOutcome(this.binding, {
      status: "interrupted",
      receipt,
      resultFingerprint: "0".repeat(64),
    });
    return this.update((current) => {
      const phase = this.checked(current);
      if (phase.child) {
        assertSameChild(phase.child, receipt);
        return current;
      }
      if (this.physicallySettled)
        throw new McpEditError(
          "invalid_edit",
          "A closed attempt cannot admit a new child reference.",
        );
      phase.child = receipt;
      return this.save(current);
    });
  };

  finish: McpCompositeSettlement["finish"] = async (input) => {
    try {
      const outcome = McpCompositeOutcomeSchema.parse(input);
      assertCompositeOutcome(this.binding, outcome);
      return await this.update((current) => {
        const phase = this.checked(current);
        if (phase.child) assertSameChild(phase.child, outcome.receipt);
        if (phase.outcome) {
          if (!sameCompositeValue(phase.outcome, outcome))
            throw new McpEditError(
              "invalid_edit",
              "A known native outcome cannot be replaced.",
            );
          return current;
        }
        phase.child = outcome.receipt;
        phase.outcome = outcome;
        phase.status = "held";
        if (current.status !== "cancelled") current.status = "held";
        current.stopReason = "native-outcome";
        current.usageUnknown ||= outcome.status === "interrupted";
        return this.save(current);
      });
    } finally {
      this.close();
    }
  };

  hold: McpCompositeSettlement["hold"] = async (reason) => {
    try {
      if (reason !== "interrupted" && reason !== "checkpoint-failed")
        throw new McpEditError(
          "invalid_edit",
          "Invalid composite settlement hold reason.",
        );
      return await this.update((current) => {
        const phase = this.checked(current);
        if (phase.status === "completed") return current;
        if (
          phase.status === "held" &&
          current.stopReason === reason &&
          (phase.outcome || current.usageUnknown)
        )
          return current;
        phase.status = "held";
        if (current.status !== "cancelled") current.status = "held";
        current.stopReason = reason;
        current.usageUnknown ||= !phase.outcome;
        return this.save(current);
      });
    } finally {
      this.close();
    }
  };

  private checked(current: McpCompositeRecord) {
    assertCompositeIdentity(this.initial, current);
    const phase = current.phases[this.index];
    if (
      !phase ||
      phase.id !== this.phaseId ||
      phase.attemptId !== this.attemptId ||
      !sameCompositeValue(phase.binding, this.binding)
    )
      throw new McpEditError(
        "invalid_edit",
        "Composite settlement no longer matches its admitted attempt.",
      );
    return phase;
  }

  private save(current: McpCompositeRecord) {
    return parseCompositeRecord({
      ...current,
      version: current.version + 1,
      updatedAt: this.now(),
    });
  }

  private close() {
    this.physicallySettled = true;
    this.release();
  }
}

function assertSameChild(before: unknown, after: unknown) {
  if (!sameCompositeValue(before, after))
    throw new McpEditError(
      "invalid_edit",
      "Settlement cannot substitute another native child.",
    );
}
