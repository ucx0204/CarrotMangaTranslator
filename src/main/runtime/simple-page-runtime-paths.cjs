// @ts-check
const runtimeFiles = require("./model/runtime-files.cjs");
const runtimeProfiles = require("./model/runtime-profile.cjs");
const runtimeLocations = require("./model/runtime-locations.cjs");
const { resolveFfmpegPath } = require("./assets/ffmpeg-path.cjs");

module.exports = {
  ...runtimeFiles,
  ...runtimeProfiles,
  ...runtimeLocations,
  resolveFfmpegPath,
};
