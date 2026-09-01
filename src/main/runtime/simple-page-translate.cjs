// @ts-check

const {
  convertImageToPngBufferWithFfmpeg,
  convertImageToPngFileWithFfmpeg,
  validateImageFileWithFfmpeg,
} = require("./simple-page-image-variants.cjs");
const { isModelCached } = require("./simple-page-model-assets.cjs");
const { ensureOcrRuntime } = require("./simple-page-ocr-runtime-manager.cjs");
const {
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  waitForOcrIdle,
} = require("./simple-page-ocr-bbox-pipeline.cjs");
const { saveArtifacts } = require("./simple-page-artifacts.cjs");
const {
  requestTranslation,
  testModelReply,
} = require("./simple-page-translation-requests.cjs");
const {
  startServer,
  stopServer,
} = require("./simple-page-server-lifecycle.cjs");

/**
 * @typedef {Object} SimplePageRuntimePublicApi
 * @property {typeof collectOcrBboxHints} collectOcrBboxHints
 * @property {typeof collectOcrBboxHintsBatch} collectOcrBboxHintsBatch
 * @property {typeof waitForOcrIdle} waitForOcrIdle
 * @property {typeof convertImageToPngBufferWithFfmpeg} convertImageToPngBufferWithFfmpeg
 * @property {typeof convertImageToPngFileWithFfmpeg} convertImageToPngFileWithFfmpeg
 * @property {typeof validateImageFileWithFfmpeg} validateImageFileWithFfmpeg
 * @property {typeof ensureOcrRuntime} ensureOcrRuntime
 * @property {typeof isModelCached} isModelCached
 * @property {typeof requestTranslation} requestTranslation
 * @property {typeof saveArtifacts} saveArtifacts
 * @property {typeof startServer} startServer
 * @property {typeof stopServer} stopServer
 * @property {typeof testModelReply} testModelReply
 */

/** @satisfies {SimplePageRuntimePublicApi} */
module.exports = {
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  convertImageToPngBufferWithFfmpeg,
  convertImageToPngFileWithFfmpeg,
  validateImageFileWithFfmpeg,
  ensureOcrRuntime,
  isModelCached,
  requestTranslation,
  saveArtifacts,
  startServer,
  stopServer,
  testModelReply,
  waitForOcrIdle,
};
