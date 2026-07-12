// @ts-check
const { buildLaunchArgs } = require("./model/launch-arguments.cjs");
const {
  isServerRuntimeCompatibleWithModel,
  looksLikeGemma4Model,
} = require("./model/model-runtime-compatibility.cjs");

module.exports = {
  buildLaunchArgs,
  isServerRuntimeCompatibleWithModel,
  looksLikeGemma4Model,
};
