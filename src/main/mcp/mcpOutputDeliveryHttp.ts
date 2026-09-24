import { errorMonitor } from "node:events";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type { McpOutputDeliveryTransfer } from "./mcpOutputDeliveryObserver";

/** Observe actual response settlement. Calling end() or starting a pipeline is not completion. */
export function observeMcpOutputResponse(
  response: ServerResponse,
  transfer: McpOutputDeliveryTransfer,
): void {
  if (response.writableFinished) {
    transfer.complete();
    return;
  }
  if (response.destroyed) {
    transfer.interrupt();
    return;
  }
  const cleanup = () => {
    response.removeListener("finish", finished);
    response.removeListener("close", closed);
    response.removeListener(errorMonitor, failed);
  };
  const finished = () => {
    transfer.complete();
    cleanup();
  };
  const closed = () => {
    if (response.writableFinished) transfer.complete();
    else transfer.interrupt();
    cleanup();
  };
  const failed = (error: NodeJS.ErrnoException) => {
    observeFailure(transfer, error);
    cleanup();
  };
  response.once("finish", finished);
  response.once("close", closed);
  // errorMonitor observes without consuming or replacing the HTTP error handler.
  response.once(errorMonitor, failed);
}

/** Attach before pipeline so a producer error is observed before response teardown. */
export function observeMcpOutputSource(
  source: Readable,
  transfer: McpOutputDeliveryTransfer,
): () => void {
  const failed = (error: NodeJS.ErrnoException) =>
    observeFailure(transfer, error);
  source.once(errorMonitor, failed);
  return () => source.removeListener(errorMonitor, failed);
}

function observeFailure(
  transfer: McpOutputDeliveryTransfer,
  error: NodeJS.ErrnoException,
) {
  if (
    ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE", "ABORT_ERR"].includes(
      error.code ?? "",
    )
  )
    transfer.interrupt();
  else transfer.fail();
}
