/**
 * Internet-research evidence validation can inspect a large OCR dossier and
 * hundreds of model proposals. Keep that synchronous CPU work outside the
 * Electron main thread so window events, IPC, and cancellation stay responsive.
 */
import { parentPort } from "node:worker_threads";
import {
  postprocessWorkContextResearch,
  type WorkContextResearchPostprocessRequest,
  type WorkContextResearchPostprocessResponse,
} from "./workContextResearchPostprocess";

const port = parentPort;
if (!port) {
  throw new Error(
    "workContextResearchPostprocessWorker must run in a worker thread.",
  );
}
const workerPort = port;

workerPort.once("message", (message: WorkContextResearchPostprocessRequest) => {
  if (message.type !== "postprocess") return;
  try {
    post({
      type: "postprocess-done",
      result: postprocessWorkContextResearch(message.input),
    });
  } catch (error) {
    post({ type: "postprocess-failed", error: serializeError(error) });
  }
});

function post(message: WorkContextResearchPostprocessResponse): void {
  workerPort.postMessage(message);
}

function serializeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
