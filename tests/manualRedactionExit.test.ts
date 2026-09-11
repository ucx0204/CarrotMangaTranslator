import { expect, it, vi } from "vitest";
import { finishRedactionWorkspace } from "../src/renderer/src/components/imageRedaction/finishRedactionWorkspace";

function ports() {
  const resume = vi.fn();
  return {
    save: vi.fn(async () => {
      throw new Error("disk full");
    }),
    restore: vi.fn(),
    pauseSaving: vi.fn(() => resume),
    confirm: vi.fn(async (_revision: number) => {}),
    cancel: vi.fn(async () => true),
    close: vi.fn(async () => true),
    resume,
  };
}
it("can explicitly cancel and exit without writing despite a broken store", async () => {
  const p = ports();
  await finishRedactionWorkspace("cancel", p);
  expect(p.save).not.toHaveBeenCalled();
  expect(p.restore).not.toHaveBeenCalled();
  expect(p.confirm).not.toHaveBeenCalled();
  expect(p.cancel).toHaveBeenCalledOnce();
  expect(p.close).toHaveBeenCalledOnce();
  expect(p.resume).not.toHaveBeenCalled();
  expect(p.pauseSaving.mock.invocationCallOrder[0]).toBeLessThan(
    p.cancel.mock.invocationCallOrder[0],
  );
});
it.each(["save", "discard", "send"] as const)(
  "does not silently acknowledge a failed %s write",
  async (intent) => {
    const p = ports();
    await expect(finishRedactionWorkspace(intent, p)).rejects.toThrow(
      "disk full",
    );
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.cancel).not.toHaveBeenCalled();
    expect(p.close).not.toHaveBeenCalled();
    expect(p.restore).toHaveBeenCalledTimes(intent === "discard" ? 1 : 0);
  },
);
it.each(["cancel", "close"] as const)(
  "keeps failures visible and returns draft ownership after %s fails",
  async (step) => {
    const p = ports();
    p[step].mockRejectedValueOnce(new Error("bridge unavailable"));
    await expect(finishRedactionWorkspace("cancel", p)).rejects.toThrow(
      "bridge unavailable",
    );
    expect(p.resume).toHaveBeenCalledOnce();
    expect(p.save).not.toHaveBeenCalled();
  },
);
it("confirms only after an acknowledged save, without cancelling the resumed job", async () => {
  const p = { ...ports(), save: vi.fn(async () => 7) };
  await finishRedactionWorkspace("send", p);
  expect(p.confirm).toHaveBeenCalledWith(7);
  expect(p.cancel).not.toHaveBeenCalled();
  expect(p.close).toHaveBeenCalledOnce();
});
