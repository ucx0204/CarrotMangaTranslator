/**
 * @typedef {{
 *   "image-path": string,
 *   "system-entities"?: Array<{"mount-point"?: string, "dev-entry"?: string}>
 * }} MountedImage
 */

/**
 * DiskImageMounter can register an image before its volume is ready.
 * Keep polling until the matching image exposes a mounted volume.
 * @param {{
 *   readImages: () => MountedImage[],
 *   matchesImage: (image: MountedImage) => boolean,
 *   timeoutMs?: number,
 *   intervalMs?: number
 * }} options
 */
async function waitForMountedVolume({
  readImages,
  matchesImage,
  timeoutMs = 90_000,
  intervalMs = 500,
}) {
  const deadline = Date.now() + timeoutMs;
  let images = [];
  while (Date.now() < deadline) {
    images = readImages();
    const mounted = images.find(
      (image) =>
        matchesImage(image) &&
        image["system-entities"]?.some((entity) => entity["mount-point"]),
    );
    if (mounted) return mounted;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(
    `The downloaded DMG did not expose a mounted volume; observed images: ${JSON.stringify(images)}`,
  );
}

module.exports = { waitForMountedVolume };
