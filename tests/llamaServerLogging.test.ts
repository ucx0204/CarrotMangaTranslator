import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { emitServerInstallLog } =
  require("../src/main/runtime/transport/llama-server-logging.cjs") as {
    emitServerInstallLog: (
      options: { onProgress?: (event: Record<string, unknown>) => void },
      chunk: unknown,
      forwardToProgress?: boolean,
    ) => void;
  };

describe("llama server progress logging", () => {
  it("can stop forwarding inference logs after server readiness", () => {
    const onProgress = vi.fn();

    emitServerInstallLog(
      { onProgress },
      "loading model\nserver listening\n",
      true,
    );
    expect(onProgress).toHaveBeenCalledTimes(2);

    emitServerInstallLog(
      { onProgress },
      "slot print_timing: inference completed\n",
      false,
    );

    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});
