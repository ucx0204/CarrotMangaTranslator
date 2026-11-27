import { runtime } from "./qwenControlCrop.fixture";
import { expect, it } from "vitest";
import { QwenNativePrintRegistration } from "../src/main/inpainting/qwenNativePrintRegistration";
it("reuses one print process, surfaces an empty worker error, and restarts after a crash", async () => {
  const reg = new QwenNativePrintRegistration({
      executable: "python",
      script: "session.py",
      packageDirectory: "tools",
    }),
    signal = new AbortController().signal;
  const score = () => reg.exposedContourError("page", "mask", "edit", signal);
  runtime.printStarted.mockClear();
  runtime.screen
    .mockResolvedValueOnce({ stdout: ".75" })
    .mockRejectedValueOnce(Error(""));
  try {
    expect(await score()).toBe(0.75);
    await expect(score()).rejects.toThrow("Qwen 원본 복원");
    expect(runtime.printStarted).toHaveBeenCalledTimes(1);
    const [child] = runtime.printStarted.mock.calls[0];
    runtime.screen.mockImplementationOnce(() => {
      child.stderr.write("decoder stopped\n");
      child.exit(3);
      return { stdout: "0" };
    });
    await expect(score()).rejects.toThrow("decoder stopped");
    runtime.screen.mockResolvedValueOnce({ stdout: ".81" });
    expect(await score()).toBe(0.81);
    expect(runtime.printStarted).toHaveBeenCalledTimes(2);
  } finally {
    await reg.dispose();
  }
  await expect(
    reg.exposedContourError("page", "mask", "edit", AbortSignal.abort()),
  ).rejects.toThrow();
});
