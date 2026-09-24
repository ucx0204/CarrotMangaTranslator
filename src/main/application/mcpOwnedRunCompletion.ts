import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";

type Record = {
  id: string;
  owner: string;
  requests: Array<{ requestId: string; fingerprint: string }>;
};
type Input = { id: string; requestId: string };
type McpOwnedRunReference = Input & { fingerprint: string };
type Active<R> = {
  record: R;
  controller: AbortController;
  pause: boolean;
  done: Promise<void>;
};
type Port<R extends Record, I extends Input, V, E> = {
  active: () => Active<R> | undefined;
  load: (owner: string, id: string) => Promise<R>;
  parse: (input: I) => I;
  project: (record: R, active?: Active<R>) => V;
  evidence?: (record: R) => E;
};

/** Internal completion of an already-admitted native run. No admission or queue. */
export function createMcpOwnedRunCompletion<
  R extends Record,
  I extends Input,
  V,
  E = never,
>(port: Port<R, I, V, E>) {
  const read = async (owner: string, input: McpOwnedRunReference) => {
    const active = matchingActive(port.active(), owner, input.id);
    const saved = active?.record ?? (await port.load(owner, input.id));
    const captured = active ?? matchingActive(port.active(), owner, input.id);
    const record = captured?.record ?? saved;
    if (!matchesRequest(record, owner, input)) return undefined;
    return { record, active: captured };
  };
  return {
    find: async (owner: string, input: McpOwnedRunReference) => {
      const owned = await read(owner, input);
      return owned
        ? port.project(structuredClone(owned.record), owned.active)
        : undefined;
    },
    evidence: async (owner: string, input: McpOwnedRunReference) => {
      const owned = await read(owner, input);
      return owned && !owned.active
        ? structuredClone(port.evidence?.(owned.record))
        : undefined;
    },
    wait: async (owner: string, input: I, signal: AbortSignal) => {
      const parsed = port.parse(input);
      const owned = await read(owner, {
        id: parsed.id,
        requestId: parsed.requestId,
        fingerprint: hashStableValue(["run", parsed]),
      });
      if (!owned) throw unavailableRun();
      if (owned.active) await settleRun(owned.active, signal);
      return port.project(structuredClone(owned.record));
    },
    control: async (
      owner: string,
      input: McpOwnedRunReference,
      direction: "pause" | "cancel",
    ) => {
      const owned = await read(owner, input);
      if (!owned) throw unavailableRun();
      if (owned.active) {
        if (direction === "pause") owned.active.pause = true;
        else owned.active.controller.abort();
      }
    },
  };
}

function matchingActive<R extends Record>(
  active: Active<R> | undefined,
  owner: string,
  id: string,
) {
  if (active?.record.id !== id) return undefined;
  if (active.record.owner !== owner) throw unavailableRun();
  return active;
}

function matchesRequest(
  record: Record,
  owner: string,
  input: McpOwnedRunReference,
) {
  if (record.owner !== owner || record.id !== input.id) throw unavailableRun();
  const request = record.requests.find(
    (item) => item.requestId === input.requestId,
  );
  if (!request) return false;
  if (request.fingerprint !== input.fingerprint)
    throw new McpEditError(
      "invalid_edit",
      "Native run requestId belongs to different input.",
    );
  // A historical request cannot identify a newer action or own its cancellation.
  return record.requests.at(-1) === request;
}

async function settleRun<R>(active: Active<R>, signal: AbortSignal) {
  const cancel = () => active.controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    await active.done;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function unavailableRun() {
  return new McpEditError(
    "not_found",
    "The exact owned native run is unavailable or was superseded.",
  );
}
