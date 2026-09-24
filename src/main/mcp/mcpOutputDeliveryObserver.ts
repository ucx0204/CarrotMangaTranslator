import type {
  McpObservedOutputDelivery,
  McpOutputDeliveryHttpEvent,
  McpOutputDeliveryObservation,
} from "../../shared/mcpOutputDelivery";
import type { McpDeliveryObservationReference } from "../application/mcpOutputDeliveryPolicy";

export const MCP_DELIVERY_IDENTITY_LIMIT = 512;
const MCP_DELIVERY_EVENT_LIMIT = 8;
type HttpCounts = McpObservedOutputDelivery["http"];
type Entry = {
  artifactKey: string;
  retainedOutputId?: string;
  origin: "generated" | "reissued";
  createdAt: number;
  expiresAt: number;
  lastObservedAt: number;
  prepared: number;
  attachments: number;
  lastPreparedAt?: number;
  http: HttpCounts;
  saturated: boolean;
  truncated: boolean;
  events: { sequence: number; value: McpOutputDeliveryHttpEvent }[];
};
export type McpOutputDeliveryTransfer = {
  bytesQueued: (bytes: number) => void;
  complete: () => void;
  interrupt: () => void;
  fail: () => void;
};
const noTransfer: McpOutputDeliveryTransfer = Object.freeze({
  bytesQueued: () => {},
  complete: () => {},
  interrupt: () => {},
  fail: () => {},
});
const httpFields = [
  "getStarted",
  "headStarted",
  "getCompleted",
  "headCompleted",
  "interrupted",
  "failed",
  "inFlight",
  "bytesQueued",
] as const;

/** Endpoint-owned observations only; this class is not an authorization or receipt authority. */
export class McpOutputDeliveryObserver {
  private readonly entries = new Map<string, Entry>();
  private sequence = 0;
  private closed = false;
  constructor(private readonly now: () => number = Date.now) {}

  created(input: {
    artifactKey: string;
    retainedOutputId?: string;
    expiresAt: number;
    origin: "generated" | "reissued";
  }): void {
    this.prune();
    const timestamp = this.time();
    if (this.closed || !validIdentity(input) || input.expiresAt <= timestamp)
      return;
    const previous = this.entries.get(input.artifactKey);
    if (previous) {
      if (
        previous.expiresAt === input.expiresAt &&
        previous.origin === input.origin
      )
        previous.retainedOutputId ??= input.retainedOutputId;
      return;
    }
    if (this.entries.size >= MCP_DELIVERY_IDENTITY_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(input.artifactKey, {
      ...input,
      createdAt: timestamp,
      lastObservedAt: timestamp,
      prepared: 0,
      attachments: 0,
      http: emptyHttp(),
      saturated: false,
      truncated: false,
      events: [],
    });
  }

  disclosed(artifactKey: string, input: { includeAttachment: boolean }): void {
    this.prune();
    const entry = this.entries.get(artifactKey);
    if (!entry || this.closed) return;
    entry.prepared = add(entry.prepared, 1, entry);
    if (input.includeAttachment)
      entry.attachments = add(entry.attachments, 1, entry);
    entry.lastPreparedAt = entry.lastObservedAt = this.time();
  }

  beginHttp(
    artifactKey: string,
    method: "GET" | "HEAD",
  ): McpOutputDeliveryTransfer {
    this.prune();
    const entry = this.entries.get(artifactKey);
    if (!entry || this.closed || !["GET", "HEAD"].includes(method))
      return noTransfer;
    const event: McpOutputDeliveryHttpEvent = {
      method,
      state: "started",
      startedAt: this.time(),
      bytesQueued: 0,
    };
    entry.lastObservedAt = event.startedAt;
    increment(entry, method === "GET" ? "getStarted" : "headStarted");
    increment(entry, "inFlight");
    entry.events.push({ sequence: this.sequence++, value: event });
    if (entry.events.length > MCP_DELIVERY_EVENT_LIMIT) {
      entry.events.shift();
      entry.truncated = true;
    }
    let settled = false;
    const current = () =>
      !this.closed && this.entries.get(artifactKey) === entry;
    const finish = (state: "completed" | "interrupted" | "failed") => {
      if (settled) return;
      settled = true;
      if (!current()) return;
      event.state = state;
      event.finishedAt = entry.lastObservedAt = this.time();
      entry.http.inFlight = Math.max(0, entry.http.inFlight - 1);
      increment(
        entry,
        state === "completed"
          ? method === "GET"
            ? "getCompleted"
            : "headCompleted"
          : state,
      );
    };
    return {
      bytesQueued: (bytes) => {
        if (
          settled ||
          !current() ||
          method === "HEAD" ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0
        )
          return;
        event.bytesQueued = add(event.bytesQueued, bytes, entry);
        increment(entry, "bytesQueued", bytes);
        entry.lastObservedAt = this.time();
      },
      complete: () => finish("completed"),
      interrupt: () => finish("interrupted"),
      fail: () => finish("failed"),
    };
  }

  inspect(
    reference: McpDeliveryObservationReference,
  ): McpOutputDeliveryObservation {
    this.prune();
    const selected = [...this.entries.values()].filter((entry) =>
      reference.retainedOutputId
        ? entry.retainedOutputId === reference.retainedOutputId
        : entry.artifactKey === reference.artifactKey,
    );
    return selected.length
      ? summarize(selected, this.time())
      : {
          state: "not_observed",
          checkedAt: this.time(),
          historyComplete: false,
        };
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
  }
  private time(): number {
    const value = this.now();
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  private prune(): void {
    const timestamp = this.time();
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= timestamp && entry.http.inFlight === 0)
        this.entries.delete(key);
  }
}

function emptyHttp(): HttpCounts {
  return {
    getStarted: 0,
    headStarted: 0,
    getCompleted: 0,
    headCompleted: 0,
    interrupted: 0,
    failed: 0,
    inFlight: 0,
    bytesQueued: 0,
  };
}
function add(value: number, amount: number, target: { saturated: boolean }) {
  const total = value + amount;
  target.saturated ||= !Number.isSafeInteger(total);
  return Math.min(Number.MAX_SAFE_INTEGER, total);
}
function increment(entry: Entry, field: keyof HttpCounts, amount = 1) {
  entry.http[field] = add(entry.http[field], amount, entry);
}
function validIdentity(input: {
  artifactKey: string;
  retainedOutputId?: string;
  expiresAt: number;
  origin: string;
}) {
  return (
    /^[A-Za-z0-9_-]{1,128}$/.test(input.artifactKey) &&
    (!input.retainedOutputId ||
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        input.retainedOutputId,
      )) &&
    Number.isSafeInteger(input.expiresAt) &&
    (input.origin === "generated" || input.origin === "reissued")
  );
}
function summarize(
  entries: Entry[],
  checkedAt: number,
): McpObservedOutputDelivery {
  const first = entries[0];
  const result: McpObservedOutputDelivery = {
    state: "observed",
    checkedAt,
    firstObservedAt: first.createdAt,
    lastObservedAt: first.lastObservedAt,
    historyComplete: false,
    capabilities: {
      generated: 0,
      reissued: 0,
      latestCreatedAt: first.createdAt,
      latestExpiresAt: first.expiresAt,
    },
    toolResponsesPrepared: { text: 0, attachment: 0 },
    http: emptyHttp(),
    countsSaturated: false,
    recentEventsTruncated: false,
    recentEvents: [],
  };
  const saturation = { saturated: false };
  const events: Entry["events"] = [];
  for (const entry of entries) {
    result.firstObservedAt = Math.min(result.firstObservedAt, entry.createdAt);
    result.lastObservedAt = Math.max(
      result.lastObservedAt,
      entry.lastObservedAt,
    );
    result.capabilities[entry.origin]++;
    if (entry.createdAt >= result.capabilities.latestCreatedAt) {
      result.capabilities.latestCreatedAt = entry.createdAt;
      result.capabilities.latestExpiresAt = entry.expiresAt;
    }
    const prepared = result.toolResponsesPrepared;
    prepared.text = add(prepared.text, entry.prepared, saturation);
    prepared.attachment = add(
      prepared.attachment,
      entry.attachments,
      saturation,
    );
    if (entry.lastPreparedAt !== undefined)
      prepared.lastPreparedAt = Math.max(
        prepared.lastPreparedAt ?? 0,
        entry.lastPreparedAt,
      );
    for (const key of httpFields)
      result.http[key] = add(result.http[key], entry.http[key], saturation);
    result.countsSaturated ||= entry.saturated;
    result.recentEventsTruncated ||= entry.truncated;
    events.push(...entry.events);
  }
  result.countsSaturated ||= saturation.saturated;
  result.recentEventsTruncated ||= events.length > MCP_DELIVERY_EVENT_LIMIT;
  result.recentEvents = events
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-MCP_DELIVERY_EVENT_LIMIT)
    .map((event) => ({ ...event.value }));
  return result;
}
