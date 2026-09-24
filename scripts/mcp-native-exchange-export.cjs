const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { download } = require("./mcp-native-export-batch.cjs");
const {
  waitExchangeJob,
  completeExchangeResponse,
} = require("./mcp-native-exchange-client.cjs");

/** @typedef {import("./mcp-native-exchange-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-exchange-fixture.cjs").Fixture} Fixture */
/** @typedef {{origin: string}} Http */
/** @typedef {{jobId:string, file:{kind:string, filename:string,url:string,mimeType:string,bytes:number,sha256:string,retainedOutputId:string,exchange:import("../src/shared/mcpExchangeFiles").McpExchangeBinding},bytes:Buffer}} Exported */

/** Public output metadata must stay independent from link issuance and server transfer.
 * @param {Client} client @param {Http} http @param {string} tool @param {object} args
 * @returns {Promise<Exported>} */
async function exportNativeExchange(client, http, tool, args) {
  const accepted = await client.call(tool, args);
  const job = await waitExchangeJob(client, accepted.jobId);
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.equal(job.result.kind, "exchange-file");
  assert.deepEqual(job.result.performed, ["serialize", "export"]);
  assert.ok(job.result.retainedOutputId);
  assert.equal((await client.call(tool, args)).jobId, accepted.jobId);
  const target = { kind: "job", jobId: accepted.jobId };
  const generated = await client.call("get_output_delivery", { target });
  assertSafeDelivery(generated);
  assert.equal(generated.generation.status, "completed");
  assert.equal(generated.retention.access, "allowed");
  assert.equal(generated.observation.capabilities.generated, 1);
  assert.equal(generated.observation.toolResponsesPrepared.text, 0);
  assert.equal(generated.observation.http.getStarted, 0);
  const file = await client.call("get_job_file", { jobId: accepted.jobId });
  assert.equal(file.kind, "exchange-file");
  assert.equal(file.retainedOutputId, job.result.retainedOutputId);
  const prepared = await client.call("get_output_delivery", { target });
  assert.equal(prepared.observation.toolResponsesPrepared.text, 1);
  assert.equal(prepared.observation.http.getStarted, 0);
  await assertExchangeHead(http.origin, file);
  const bytes = await completeExchangeResponse(
    http.origin,
    file.url,
    "GET",
    () => download(http.origin, file),
  );
  const delivered = await client.call("get_output_delivery", { target });
  assertSafeDelivery(delivered);
  assert.equal(delivered.sessionFile.state, "available");
  assert.equal(delivered.observation.http.getCompleted, 1);
  assert.equal(delivered.observation.http.headCompleted, 1);
  assert.equal(delivered.observation.http.bytesQueued, bytes.length);
  assert.equal(delivered.observation.http.inFlight, 0);
  return { jobId: accepted.jobId, file, bytes };
}

/** @param {string} root @param {Client} client @param {Http} http @param {Fixture} source */
async function exportNativeTextFormats(root, client, http, source) {
  const { buildReviewRows, serializeReviewRows } = require(
    join(root, "out/shared/reviewTable.js"),
  );
  const { gatherText, filterPagesByField, formatGatheredText } = require(
    join(root, "out/shared/gatherText.js"),
  );
  /** @type {Exported[]} */
  const files = [];
  for (const format of ["txt", "csv", "tsv"]) {
    const options =
      format === "txt"
        ? { format, field: "both", includeHeaders: true }
        : { format, includeBom: true };
    const review = await client.call("preflight_text_export", {
      chapterId: source.chapterId,
      pageIds: source.context.chapter.pages
        .map((/** @type {{id:string}} */ page) => page.id)
        .reverse(),
      options,
    });
    assert.equal(review.executionReserved, false);
    assert.equal(review.pageCount, 2);
    assert.deepEqual(
      review.binding.pages.map(
        (/** @type {{pageId:string}} */ page) => page.pageId,
      ),
      source.context.chapter.pages.map(
        (/** @type {{id:string}} */ page) => page.id,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(review),
      /mcp-artifacts|resource_link|"url"/,
    );
    const output = await exportNativeExchange(
      client,
      http,
      "export_text_file",
      { binding: review.binding, requestId: randomUUID() },
    );
    const expected =
      format === "txt"
        ? formatGatheredText(
            filterPagesByField(
              gatherText({
                chapter: source.context.chapter,
                page: null,
                scope: "chapter",
                direction: review.binding.direction,
              }),
              "both",
            ),
            "both",
            true,
          )
        : serializeReviewRows(
            buildReviewRows(source.context.chapter, review.binding.direction),
            format,
            true,
          );
    assert.ok(
      output.bytes.equals(Buffer.from(expected, "utf8")),
      `Native ${format} serializer parity`,
    );
    assert.equal(output.bytes.length, review.bytes);
    assert.match(output.bytes.toString("utf8"), /기존 번역/);
    files.push(output);
  }
  return files;
}

/** @param {string} root @param {Client} client @param {Http} http @param {Fixture} source */
async function exportNativeContext(root, client, http, source) {
  const input = {
    workId: source.workId,
    chapterId: source.chapterId,
    scope: "guide-and-memory",
  };
  const review = await client.call("preflight_context_export", input);
  assert.deepEqual(review.presence, { guide: true, memory: true });
  assert.equal(review.counts.glossary, 1);
  assert.equal(review.counts.memoryPages, 1);
  const output = await exportNativeExchange(
    client,
    http,
    "export_context_json",
    {
      ...input,
      sourceSnapshot: review.sourceSnapshot,
      requestId: randomUUID(),
    },
  );
  assert.equal(output.file.filename, "carrot-context.json");
  assert.equal(output.file.sha256, review.sha256);
  assert.equal(output.bytes.length, review.sourceBytes);
  const {
    decodeMcpContextExchangePayload,
    encodeMcpContextExchangePayload,
  } = require(join(root, "out/shared/mcpContextExchangePayload.js"));
  const { payload } = decodeMcpContextExchangePayload(output.bytes);
  assert.deepEqual(
    payload.guide,
    JSON.parse(source.contextFiles.guide.toString("utf8")),
  );
  assert.deepEqual(
    payload.memory,
    JSON.parse(source.contextFiles.memory.toString("utf8")),
  );
  assert.ok(
    output.bytes.equals(Buffer.from(encodeMcpContextExchangePayload(payload))),
  );
  return output;
}

/** @param {string} origin @param {{url:string,mimeType:string,filename:string,bytes:number}} file */
async function assertExchangeHead(origin, file) {
  await completeExchangeResponse(origin, file.url, "HEAD", () =>
    checkExchangeHead(origin, file),
  );
}

/** @param {string} origin @param {{url:string,mimeType:string,filename:string,bytes:number}} file */
async function checkExchangeHead(origin, file) {
  const head = await fetch(origin + new URL(file.url).pathname, {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), file.mimeType);
  assert.equal(head.headers.get("content-length"), String(file.bytes));
  assert.equal(
    head.headers.get("content-disposition"),
    `attachment; filename="${file.filename}"`,
  );
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(head.headers.get("referrer-policy"), "no-referrer");
  assert.equal(head.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
}

/** @param {import("../src/shared/mcpOutputDelivery").McpOutputDeliveryReport} report */
function assertSafeDelivery(report) {
  assert.equal(report.clientReceipt, "unconfirmed");
  assert.equal(report.observation.historyComplete, false);
  assert.doesNotMatch(
    JSON.stringify(report),
    /mcp-artifacts|resource_link|"url"|artifactKey|imagePath|rootPath|sourceText|translatedText/,
  );
}
module.exports = {
  exportNativeExchange,
  exportNativeTextFormats,
  exportNativeContext,
  assertExchangeHead,
  assertSafeDelivery,
};
