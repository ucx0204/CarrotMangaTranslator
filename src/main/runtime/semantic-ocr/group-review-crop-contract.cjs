// @ts-check

const GROUP_REVIEW_CROP_PLAN_VERSION = 1;
const FORBIDDEN_DEFERRED_HOST_REASONS = new Set([
  "oversized_display_text",
  "oversized_uncertain_sfx",
]);

module.exports = {
  FORBIDDEN_DEFERRED_HOST_REASONS,
  GROUP_REVIEW_CROP_PLAN_VERSION,
};
