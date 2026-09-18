import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { selectionHttpFixture } from "./mcpSelectionHttp.fixture";

it("runs isolated selected OCR and translation through real OAuth/HTTP without edit scope or saved changes", async () => {
  const f = await selectionHttpFixture();
  const before = await readFile(f.chapterPath);
  try {
    for (const [name, input] of [
      ["carrot_run_selection_ocr", await f.ocrInput()],
      ["carrot_run_selection_translation", await f.translationInput()],
    ] as const) {
      const accepted = (await f.call(name, input)).body.result;
      expect(accepted.isError).toBe(false);
      expect(JSON.parse(accepted.content[0].text)).toEqual(accepted.structuredContent);
      const job = await f.settle(String(accepted.structuredContent.jobId), f.principal);
      expect(job.status).toBe("completed");
      expect(job.result?.pagesChanged).toBe(0);
      const result = (await f.call("carrot_get_selection_analysis", {
        analysisId: job.jobId, limit: 1,
      })).body.result;
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(result.structuredContent.items).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/imagePath|sourceHash|dataUrl|fixture-key/);
    }
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("enforces scopes and ownership, rejects extra fields, and replays receipts without repeating paid work", async () => {
  const f = await selectionHttpFixture();
  try {
    const input = await f.translationInput();
    expect((await f.call("carrot_run_selection_translation", input, f.read)).body.error.code).toBe(-32602);
    expect((await f.call("carrot_run_selection_translation", { ...input, path: "private" })).body.error.code).toBe(-32602);
    const accepted = (await f.call("carrot_run_selection_translation", input)).body.result.structuredContent;
    expect((await f.settle(accepted.jobId, f.principal)).status).toBe("completed");
    const replay = (await f.call("carrot_run_selection_translation", input)).body.result.structuredContent;
    expect(replay.jobId).toBe(accepted.jobId);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect((await f.call("carrot_run_selection_translation", { ...input, targetLanguage: "fr" })).body.result.isError).toBe(true);
    expect((await f.call("carrot_get_selection_analysis", { analysisId: accepted.jobId }, f.other)).body.result.structuredContent.error).toBe("not_found");
    expect((await f.call("carrot_get_selection_analysis", { analysisId: randomUUID() })).body.result.isError).toBe(true);
    expect((await f.call("carrot_get_selection_analysis", { analysisId: accepted.jobId, blockId: "a" })).body.error.code).toBe(-32602);
    f.provider.revokeConnection(f.principal);
    expect((await f.call("carrot_get_selection_analysis", { analysisId: accepted.jobId })).status).toBe(401);
  } finally { await f.close(); }
});

it("withholds a result after mid-inference revocation and still releases its external session", async () => {
  const f = await selectionHttpFixture();
  const before = await readFile(f.chapterPath);
  f.request.mockImplementationOnce(async ({ userPrompt }) => {
    f.provider.revokeConnection(f.principal);
    return JSON.stringify({ blockId: JSON.parse(userPrompt).blockId, translatedText: "unpublished" });
  });
  try {
    const accepted = (await f.call("carrot_run_selection_translation", await f.translationInput())).body.result.structuredContent;
    const job = await f.settle(accepted.jobId, f.principal);
    expect(job.status).toBe("failed");
    expect(job.result?.selectionAnalysis).toBeUndefined();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.app.jobs.all).toEqual([]);
  } finally { await f.close(); }
});
