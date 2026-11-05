/**
 * Turns a supplied wedding-party portrait into the site's built-in one, framed like the others.
 *
 *   npm run portrait -- ~/Downloads/james.png james
 *
 * The photo must already be cut out onto one flat background colour (the blush the portraits
 * share). The script finds the head, crops head and shoulders at 3:4 with the same headroom as every
 * portrait (padding with the background where the photo's own edge is too close), and writes
 * public/images/party/<member id>.jpg at 600x800, with no camera or location data. A new member's
 * portrait also needs its line in src/content/images.ts; the script says which.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { party } from "@/content/wedding";
import { framePortrait } from "@/lib/site-images/portrait-frame";

const OUTPUT_WIDTH = 600;
const OUTPUT_HEIGHT = 800;
// What a transparent cut-out is laid on: the blush the portraits share.
const BLUSH = { r: 243, g: 230, b: 222 };

async function main() {
  const [photoPath, memberId] = process.argv.slice(2);
  const member = party.find((candidate) => candidate.id === memberId);
  if (!photoPath || !member) {
    console.error("Usage: npm run portrait -- <photo> <member id>");
    console.error(`Member ids: ${party.map((candidate) => candidate.id).join(", ")}`);
    process.exit(1);
  }

  const source = await sharp(photoPath).rotate().flatten({ background: BLUSH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const image = { data: source.data, width: source.info.width, height: source.info.height, channels: source.info.channels };
  const { background, head, crop } = framePortrait(image);

  // Pad wherever the crop runs past the photo, in the photo's own background colour.
  const padding = {
    top: Math.max(0, -crop.top),
    left: Math.max(0, -crop.left),
    right: Math.max(0, crop.left + crop.width - image.width),
    bottom: Math.max(0, crop.top + crop.height - image.height),
  };
  const [red, green, blue] = background;
  const padded = await sharp(source.data, { raw: source.info })
    .extend({ ...padding, background: { r: red, g: green, b: blue } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const outputPath = join("public", "images", "party", `${member.id}.jpg`);
  await sharp(padded.data, { raw: padded.info })
    .extract({ left: crop.left + padding.left, top: crop.top + padding.top, width: crop.width, height: crop.height })
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT)
    .jpeg({ quality: 85, mozjpeg: true })
    .toFile(outputPath);

  console.log(`${member.name}: head from row ${head.top} to ${head.bottom}, centred on column ${head.centre}, on rgb(${background.join(", ")}).`);
  console.log(`Cropped ${crop.width}x${crop.height} at (${crop.left}, ${crop.top}), padded ${JSON.stringify(padding)}; wrote ${outputPath}.`);

  const images = await readFile(join("src", "content", "images.ts"), "utf8");
  if (!images.includes(`party/${member.id}.jpg`)) {
    const role = member.role.toLowerCase();
    console.log("\nNew portrait: add these to src/content/images.ts.");
    console.log(`  import ${member.id} from "../../public/images/party/${member.id}.jpg";`);
    console.log(`  ${member.id}: { src: ${member.id}, alt: "${member.name}, ${role}", position: "center 30%" },   (in partyPhotos)`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
