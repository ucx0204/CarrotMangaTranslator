/** The parent serializes requests and owns process/session lifetime. */
export function serveInference<Input, Output>(
  infer: (input: Input) => Promise<Output>,
): void {
  const port = process.parentPort;
  if (!port) throw new Error("Native inference requires a utility process.");
  port.on("message", async ({ data }: { data: Input }) => {
    try {
      port.postMessage({ ok: true, result: await infer(data) });
    } catch (error) {
      port.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
