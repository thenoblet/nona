import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { previewPhotos } from "@/content/preview-photos";
import { CARD_FONTS } from "@/lib/preview-cards/layout";
import { buildWorker } from "../../scripts/build-worker.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const folders: string[] = [];

afterAll(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

/** A folder outside the project holding one module with this source, for the build to start from. */
async function entryModule(source: string): Promise<{ entry: string; outdir: string }> {
  const folder = await mkdtemp(join(tmpdir(), "nona-worker-bundle-"));
  folders.push(folder);
  const entry = join(folder, "entry.ts");
  await writeFile(entry, source);
  return { entry, outdir: join(folder, "out") };
}

describe("the worker's bundle build", () => {
  it("fails when a module it reaches imports next/cache", async () => {
    const { entry, outdir } = await entryModule(`import { cacheLife } from "next/cache";\ncacheLife("max");\n`);
    await expect(buildWorker({ entryPoints: { main: entry }, outdir })).rejects.toThrow(/next\/cache/);
  });

  it("fails when it reaches next/ through another module: the site content's cached read", async () => {
    const { entry, outdir } = await entryModule(
      `import { getSiteContent } from "@/lib/content/get";\nconsole.log(await getSiteContent());\n`,
    );
    await expect(buildWorker({ entryPoints: { main: entry }, outdir })).rejects.toThrow(/next\/cache/);
  });

  it("fails when it imports a package the image doesn't install: a dev dependency", async () => {
    const { entry, outdir } = await entryModule(`import { build } from "esbuild";\nconsole.log(build);\n`);
    await expect(buildWorker({ entryPoints: { main: entry }, outdir })).rejects.toThrow(/esbuild.*dev/);
  });

  it("bundles the worker with only production dependencies left outside, and the migrations beside it", async () => {
    const outdir = join(projectRoot, "node_modules", ".cache", "nona-worker-bundle-test");
    folders.push(outdir);
    const result = await buildWorker({ outdir });

    const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports);
    const packages = imports.filter((imported) => imported.external).map((imported) => imported.path);
    const dependencies = Object.keys(
      JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")).dependencies as Record<string, string>,
    );
    const packageNames = packages
      .filter((path) => !path.startsWith("node:"))
      .map((path) => (path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0]));
    expect(packageNames.filter((name) => !dependencies.includes(name))).toEqual([]);
    expect(packageNames).toEqual(expect.arrayContaining(["pg-boss", "zod", "drizzle-orm", "postgres"]));
    expect(packages.filter((path) => path === "next" || path.startsWith("next/"))).toEqual([]);
    // server-only is emptied, not left for Node to load (its package throws outside React's server).
    expect(packages).not.toContain("server-only");

    expect(await readdir(outdir)).toEqual(expect.arrayContaining(["main.mjs", "drizzle"]));
    const journal = JSON.parse(await readFile(join(outdir, "drizzle", "meta", "_journal.json"), "utf8"));
    const migrations = await readdir(join(outdir, "drizzle"));
    for (const entry of journal.entries as { tag: string }[]) expect(migrations).toContain(`${entry.tag}.sql`);

    // The preview cards' fonts and built-in photos travel in the image, so drawing one fetches nothing (Task 19).
    expect((await readdir(join(outdir, "card-assets", "fonts"))).sort()).toEqual(
      CARD_FONTS.map((font) => font.file).sort(),
    );
    for (const { file } of Object.values(previewPhotos)) {
      const copied = await readFile(join(outdir, "card-assets", "public", file));
      expect(copied.equals(await readFile(join(projectRoot, "public", file))), file).toBe(true);
    }
    // satori and its layout engine are production dependencies the image installs.
    expect(packageNames).toContain("satori");
  });
});
