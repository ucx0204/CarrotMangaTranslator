import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");

describe("analysis runtime cleanup", () => {
  const indexSource = readFileSync(
    join(repoRoot, "src", "main", "index.ts"),
    "utf8",
  );
  const activeJobSource = readFileSync(
    join(repoRoot, "src", "main", "jobs", "activeJob.ts"),
    "utf8",
  );
  const jobControlSource = readFileSync(
    join(repoRoot, "src", "main", "ipc", "jobControlIpc.ts"),
    "utf8",
  );
  const inpaintingJobSource = readFileSync(
    join(repoRoot, "src", "main", "jobs", "inpaintingJobs.ts"),
    "utf8",
  );
  const translationJobSource = readFileSync(
    join(repoRoot, "src", "main", "jobs", "translationJobs.ts"),
    "utf8",
  );

  it("uses a single cleanup helper for cancel and app quit", () => {
    expect(activeJobSource).toContain(
      "async runCleanup(job: ActiveJob, reason: string)",
    );
    expect(indexSource).toContain('jobs.runCleanup(job, "before-quit")');
    expect(indexSource).toContain("event.preventDefault()");
    expect(indexSource).toContain("BEFORE_QUIT_CLEANUP_TIMEOUT_MS");
    expect(jobControlSource).toContain(
      'context.jobs.runCleanup(job, "cancel")',
    );
  });

  it("stops the model endpoint after successful or failed jobs", () => {
    expect(translationJobSource).toContain(
      'context.jobs.runCleanup(job, "job-finished")',
    );
    expect(translationJobSource).toMatch(
      /finally\s*{[\s\S]*context\.jobs\.runCleanup\(job, "job-finished"\)[\s\S]*context\.jobs\.clearIfCurrent\(id\);/,
    );
  });

  it("emits terminal job events before no-target early returns", () => {
    expect(translationJobSource).toMatch(
      /resolved\.pages\.length === 0[\s\S]*emit\({[\s\S]*status: "completed"/,
    );
    expect(inpaintingJobSource).toMatch(
      /pages\.length === 0[\s\S]*emit\({[\s\S]*status: "failed"/,
    );
  });
});
