import { PNG } from "pngjs";

/** Keep alpha and empty pixels unchanged while switching the lettering palette. */
export function invertLetteringRgb(image: PNG): void {
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 3] === 0) continue;
    for (let channel = 0; channel < 3; channel++)
      image.data[offset + channel] = 255 - image.data[offset + channel];
  }
}

export function invertedLetteringReference(dataUrl: string): string {
  const image = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
  invertLetteringRgb(image);
  return `data:image/png;base64,${PNG.sync.write(image).toString("base64")}`;
}
