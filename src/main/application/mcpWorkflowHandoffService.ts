import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import type {
  McpWorkflowHandoffAccept,
  McpWorkflowHandoffOffer,
} from "../../shared/mcpWorkflowHandoff";
import {
  assertWorkflowVersion,
  workflowView,
  type McpWorkflowRecord,
} from "./mcpWorkflowPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Guard = () => void;
type Offer = {
  id: string;
  input: McpWorkflowHandoffOffer;
  owner: string;
  fingerprint: string;
  expiresAt: number;
  guard: Guard;
  revoked: boolean;
};
type Port = {
  now: () => number;
  load: (owner: string, id: string) => Promise<McpWorkflowRecord>;
  verify: (record: McpWorkflowRecord, guard: Guard) => Promise<void>;
  exclusive: <T>(run: () => Promise<T>) => Promise<T>;
  transfer: (
    record: McpWorkflowRecord,
    recipient: string,
    input: McpWorkflowHandoffAccept,
    guard: Guard,
  ) => Promise<McpWorkflowRecord>;
};

/** Offers are short-lived in-memory consent, not bearer capabilities. Both existing
 * approved connections must still authorize acceptance. Restart revokes outstanding
 * offers; only a completed native ownership transition survives restart. */
export class McpWorkflowHandoffService {
  private readonly offers = new Map<string, Offer>();
  private stopped = false;
  constructor(private readonly port: Port) {}

  private check(guard: Guard) {
    if (this.stopped)
      throw new McpEditError(
        "access_denied",
        "Workflow handoff session is stopping.",
      );
    guard();
  }

  async offer(owner: string, input: McpWorkflowHandoffOffer, guard: Guard) {
    this.check(guard);
    if (owner === input.targetConnectionId)
      throw new McpEditError(
        "invalid_edit",
        "The same approved connection can already resume from another conversation.",
      );
    return this.port.exclusive(async () => {
      const fingerprint = hashStableValue(input);
      for (const [id, entry] of this.offers)
        if (entry.expiresAt <= this.port.now()) this.offers.delete(id);
      const previous = [...this.offers.values()].find(
        (entry) =>
          entry.owner === owner && entry.input.requestId === input.requestId,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.revoked)
          throw new McpEditError(
            "invalid_edit",
            "Handoff requestId was used for another or revoked offer.",
          );
        this.check(guard);
        return describeOffer(previous);
      }
      if (this.offers.size >= 128)
        throw new McpEditError(
          "editor_busy",
          "Pending workflow handoff capacity reached.",
        );
      const record = await this.port.load(owner, input.id);
      assertWorkflowVersion(record, input.version);
      assertWorkflowHandoffReady(record);
      await this.port.verify(record, () => this.check(guard));
      this.check(guard);
      const offer: Offer = {
        id: randomUUID(),
        input,
        owner,
        fingerprint,
        expiresAt: Math.min(record.expiresAt, this.port.now() + 10 * 60_000),
        guard,
        revoked: false,
      };
      this.offers.set(offer.id, offer);
      return describeOffer(offer);
    });
  }

  async accept(
    recipient: string,
    input: McpWorkflowHandoffAccept,
    authorize: (record: McpWorkflowRecord) => void,
    guard: Guard,
  ) {
    this.check(guard);
    return this.port.exclusive(async () => {
      const existing = await this.recipientRecord(recipient, input.id);
      if (
        existing?.requests.some(
          (entry) =>
            entry.requestId === input.requestId &&
            entry.fingerprint === workflowHandoffFingerprint(recipient, input),
        )
      ) {
        this.check(guard);
        authorize(existing);
        return describeTransfer(existing, true);
      }
      const offer = this.offers.get(input.offerId);
      if (
        !offer ||
        offer.revoked ||
        offer.input.id !== input.id ||
        offer.input.targetConnectionId !== recipient
      )
        throw new McpEditError(
          "not_found",
          "No handoff offer belongs to this receiving connection.",
        );
      const check = () => {
        this.check(guard);
        offer.guard();
        if (offer.revoked || offer.expiresAt <= this.port.now())
          throw new McpEditError(
            "not_found",
            "Workflow handoff consent expired or was revoked.",
          );
      };
      check();
      const record = await this.port.load(offer.owner, input.id);
      assertWorkflowVersion(record, offer.input.version);
      assertWorkflowVersion(record, input.version);
      assertWorkflowHandoffReady(record);
      authorize(record);
      const authorized = () => {
        check();
        authorize(record);
      };
      await this.port.verify(record, authorized);
      const transferred = await this.port.transfer(
        record,
        recipient,
        input,
        authorized,
      );
      this.offers.delete(offer.id);
      return describeTransfer(transferred, false);
    });
  }

  revoke(owner: string, input: { id: string; offerId: string }, guard: Guard) {
    this.check(guard);
    const offer = this.offers.get(input.offerId);
    if (!offer || offer.owner !== owner || offer.input.id !== input.id)
      throw new McpEditError(
        "not_found",
        "Handoff offer is not owned by this connection.",
      );
    offer.revoked = true;
    return { ...input, status: "revoked" as const, pageChanges: 0 as const };
  }

  stop() {
    this.stopped = true;
    this.offers.clear();
  }

  private async recipientRecord(owner: string, id: string) {
    try {
      return await this.port.load(owner, id);
    } catch (error) {
      if (error instanceof McpEditError && error.code === "not_found")
        return undefined;
      throw error;
    }
  }
}

export function assertWorkflowHandoffReady(record: McpWorkflowRecord) {
  if (
    !["prepared", "paused", "waiting_external", "cancelled"].includes(
      record.status,
    ) ||
    record.steps.some(
      (step) => step.status === "running" || step.status === "failed",
    )
  )
    throw new McpEditError(
      "invalid_edit",
      "Only settled workflows without uncertain native attempts can be handed off. Reconcile failures with the current owner first.",
    );
}
export function workflowHandoffFingerprint(
  recipient: string,
  input: McpWorkflowHandoffAccept,
) {
  return hashStableValue(["workflow-handoff", recipient, input]);
}
function describeOffer(offer: Offer) {
  return {
    id: offer.input.id,
    offerId: offer.id,
    version: offer.input.version,
    targetConnectionId: offer.input.targetConnectionId,
    expiresAt: offer.expiresAt,
    historyTransferred: false as const,
  };
}
function describeTransfer(record: McpWorkflowRecord, replay: boolean) {
  return {
    workflow: workflowView(record),
    status: replay
      ? ("already_transferred" as const)
      : ("transferred" as const),
    historyTransferred: false as const,
  };
}
