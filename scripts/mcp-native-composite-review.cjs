const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { nativeImage } = require("electron");
const {
  compositeMutation,
  runCompositePhase,
} = require("./mcp-native-composite-phases.cjs");

/** @typedef {import("./mcp-native-composite-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-composite-phases.cjs").Parent} Parent */

/** Fetch the exact issued native PNGs before making an explicit fixture host report.
 * This validates the transport/provenance boundary, not translation or visual quality.
 * @param {Client} client @param {Parent} parent @param {string} phaseId */
async function reviewCompositePages(client, parent, phaseId) {
  const awaiting = await runCompositePhase(client, parent);
  assert.equal(awaiting.status, "awaiting-review");
  const review = await readCompositeReviewImages(client, awaiting, phaseId);
  const report = compositeHostReport(awaiting, phaseId, review.evidence);
  const accepted = await client.call("submit_composite_review", report);
  const phase = accepted.phases.find(
    (/** @type {Parent["phases"][number]} */ phase) =>
      phase.descriptor.id === phaseId,
  );
  assert.ok(phase?.report);
  assert.equal(phase.report.verdictOrigin, "host-reported");
  return { parent: accepted, report, review };
}
/** @param {Client} client @param {Parent} parent @param {string} phaseId */
async function readCompositeReviewImages(client, parent, phaseId) {
  const review = await client.call("get_composite_review", {
    id: parent.id,
    phaseId,
  });
  assert.equal(review.evidence.length, parent.targets.length);
  const native = await client.call("get_composite_native_review", {
    id: parent.id,
  });
  assert.equal(native.scope, "selected-saved-metadata-only");
  assert.equal(native.executionReserved, false);
  assert.equal(native.total, parent.targets.length);
  assert.ok(native.notChecked.includes("translation-quality"));
  for (const evidence of review.evidence) {
    const response = await client.response("get_composite_review_image", {
      id: parent.id,
      phaseId,
      evidenceId: evidence.id,
    });
    assert.deepEqual(response.structuredContent.evidence, evidence);
    assert.equal(
      response.structuredContent.qualityVerdict,
      "host-assessment-required",
    );
    const images = response.content.filter(
      (/** @type {{type:string}} */ item) => item.type === "image",
    );
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, "image/png");
    const bytes = Buffer.from(images[0].data, "base64");
    assert.ok(
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      evidence.sha256,
    );
    const rendered = nativeImage.createFromBuffer(bytes);
    assert.equal(rendered.isEmpty(), false);
    assert.deepEqual(rendered.getSize(), {
      width: evidence.width,
      height: evidence.height,
    });
    assert.ok(
      evidence.pixelMapping.scaleX > 0 && evidence.pixelMapping.scaleY > 0,
    );
    assert.deepEqual(evidence.fontEvidence, {
      appManaged: "bytes-sha256",
      systemFallback: "native-render-pixels-only",
    });
  }
  return review;
}
/** @param {Parent} parent @param {string} phaseId
 * @param {Array<{id:string,chapterId:string,pageId:string,pass:number}>} evidence */
function compositeHostReport(parent, phaseId, evidence) {
  assert.ok(evidence.length);
  return {
    ...compositeMutation(parent),
    phaseId,
    pass: evidence[0].pass,
    reviewerKind: "connected-ai",
    verdictOrigin: "host-reported",
    verdict: "accepted",
    assessments: evidence.map((page) => ({
      chapterId: page.chapterId,
      pageId: page.pageId,
      evidenceId: page.id,
    })),
    findings: [],
    findingsOverflow: false,
  };
}
module.exports = {
  reviewCompositePages,
  readCompositeReviewImages,
  compositeHostReport,
};
