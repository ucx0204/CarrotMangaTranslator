// @ts-check
const sourceAssets = require("./assets/image-source-assets.cjs");
const {
  buildOpenAIVisionVariant,
} = require("./assets/openai-vision-variant.cjs");
const electronEnhancement = require("./assets/electron-image-enhancement.cjs");
const powershellEnhancement = require("./assets/powershell-image-enhancement.cjs");
const enhancement = require("./assets/image-enhancement.cjs");
const { prepareImageVariants } = require("./assets/image-variants.cjs");

module.exports = {
  ...sourceAssets,
  buildOpenAIVisionVariant,
  ...electronEnhancement,
  ...powershellEnhancement,
  ...enhancement,
  prepareImageVariants,
};
