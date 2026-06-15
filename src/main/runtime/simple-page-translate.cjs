// @ts-check

const {
  convertImageToPngBufferWithFfmpeg,
} = require("./simple-page-image-variants.cjs");
const { isModelCached } = require("./simple-page-model-assets.cjs");
const {
  ensurePaddleOcrRuntime,
} = require("./simple-page-ocr-runtime-manager.cjs");
const {
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
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
 * @property {typeof convertImageToPngBufferWithFfmpeg} convertImageToPngBufferWithFfmpeg
 * @property {typeof ensurePaddleOcrRuntime} ensurePaddleOcrRuntime
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
  ensurePaddleOcrRuntime,
  isModelCached,
  requestTranslation,
  saveArtifacts,
  startServer,
  stopServer,
  testModelReply,
};
