type MountedImage = {
  "image-path": string;
  "system-entities"?: { "mount-point"?: string; "dev-entry"?: string }[];
};

// DiskImageMounter registers the image before its volume is ready.
export async function waitForMountedVolume({
  readImages,
  matchesImage,
  timeoutMs = 90_000,
  intervalMs = 500,
}: {
  readImages: () => MountedImage[];
  matchesImage: (image: MountedImage) => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<MountedImage> {
  const deadline = Date.now() + timeoutMs;
  let images: MountedImage[] = [];
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
