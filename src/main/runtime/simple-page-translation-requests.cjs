// @ts-check

const {
  buildChatRequestBody,
  buildResponsesRequestBody,
} = require("./transport/request-bodies.cjs");
const {
  buildHttpFailureMessage,
} = require("./transport/model-http-errors.cjs");
const { requestTranslation } = require("./transport/translation-request.cjs");
const { testModelReply } = require("./transport/model-probe.cjs");

module.exports = {
  buildChatRequestBody,
  buildResponsesRequestBody,
  buildHttpFailureMessage,
  requestTranslation,
  testModelReply,
};
