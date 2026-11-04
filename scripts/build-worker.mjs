/**
 * Bundles the media worker for its image: src/worker/main.ts into dist/worker/main.mjs, with the
 * Drizzle journal and migrations copied beside it (the worker waits until the database has them),
 * and the link preview cards' fonts and built-in photos in card-assets/ (media.card draws with them,
 * fetching nothing).
 *
 *   npm run build:worker
 *
 * One ES module for Node 22. Packages stay outside the bundle and come from the image's
 * node_modules, which holds production dependencies only, so the build fails if the worker reaches
 * a package that isn't one. It fails too if the worker reaches anything from next/: the worker runs
 * in plain Node, and a Next.js module there means app code (a cache, a cookie) leaked into it.
 * `server-only` is emptied: its package throws outside React's server, and the worker is a server.
 */
import { builtinModules } from "node:module";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

/** Refuses every import of next or next/*, naming the module that tried. */
const refuseNext = {
  name: "refuse-next",
  setup(builder) {
    builder.onResolve({ filter: /^next(\/|$)/ }, (args) => ({
      errors: [
        {
          text: `The worker can't import ${args.path} (imported by ${relative(projectRoot, args.importer)}): it runs without Next.js`,
        },
      ],
    }));
  },
};

/** Loads `server-only` as an empty module. */
const emptyServerOnly = {
  name: "empty-server-only",
  setup(builder) {
    builder.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "empty-module" }));
    builder.onLoad({ filter: /.*/, namespace: "empty-module" }, () => ({ contents: "", loader: "js" }));
  },
};

const builtins = new Set(builtinModules);

/** The package an import path names: `@aws-sdk/client-s3` for `@aws-sdk/client-s3/dist/x`. */
function packageName(importPath) {
  const parts = importPath.split("/");
  return importPath.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Throws unless every package the bundle imports is a Node built-in or a production dependency. */
async function checkPackages(metafile) {
  const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const devDependencies = new Set(Object.keys(manifest.devDependencies ?? {}));
  const missing = new Set();
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports) {
      if (!imported.external) continue;
      if (imported.path.startsWith("node:") || builtins.has(imported.path)) continue;
      const name = packageName(imported.path);
      if (!dependencies.has(name)) missing.add(name);
    }
  }
  if (missing.size > 0) {
    const named = [...missing].map((name) => (devDependencies.has(name) ? `${name} (a dev dependency)` : name));
    throw new Error(
      `The worker imports ${named.join(", ")}, which its image won't install: only production dependencies are`,
    );
  }
}

/** Copies the Drizzle journal and every migration's SQL into `folder`/drizzle. */
async function copyMigrations(folder) {
  const source = join(projectRoot, "drizzle");
  const target = join(folder, "drizzle");
  await mkdir(join(target, "meta"), { recursive: true });
  await copyFile(join(source, "meta", "_journal.json"), join(target, "meta", "_journal.json"));
  const migrations = (await readdir(source)).filter((name) => name.endsWith(".sql"));
  await Promise.all(migrations.map((name) => copyFile(join(source, name), join(target, name))));
}

/**
 * Copies what media.card draws with into `folder`/card-assets: the cards' TTF fonts (src/fonts/og)
 * as fonts/, and each built-in preview photo under public/ at its own path (src/content/preview-photos.ts).
 */
async function copyCardAssets(folder) {
  const target = join(folder, "card-assets");
  const fontsSource = join(projectRoot, "src", "fonts", "og");
  await mkdir(join(target, "fonts"), { recursive: true });
  const fonts = (await readdir(fontsSource)).filter((name) => name.endsWith(".ttf"));
  await Promise.all(fonts.map((name) => copyFile(join(fontsSource, name), join(target, "fonts", name))));
  const source = await readFile(join(projectRoot, "src", "content", "preview-photos.ts"), "utf8");
  const files = [...source.matchAll(/file: "([a-z0-9/_.-]+\.jpg)"/g)].map((match) => match[1]);
  if (files.length === 0) throw new Error("Found no built-in preview photos in src/content/preview-photos.ts");
  for (const file of files) {
    await mkdir(dirname(join(target, "public", file)), { recursive: true });
    await copyFile(join(projectRoot, "public", file), join(target, "public", file));
  }
}

/**
 * Builds the bundle into `outdir` (emptied first) and returns esbuild's result. Tests pass other
 * entry points (a harness) and folders; the image builds the defaults.
 *
 * @param {{ entryPoints?: Record<string, string>, outdir?: string }} [options]
 */
export async function buildWorker({ entryPoints = { main: "src/worker/main.ts" }, outdir = "dist/worker" } = {}) {
  const output = resolve(projectRoot, outdir);
  await rm(output, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints,
    outdir: output,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // Every package comes from node_modules at run time; the @/ paths are tsconfig's.
    packages: "external",
    tsconfig: join(projectRoot, "tsconfig.json"),
    sourcemap: true,
    metafile: true,
    logLevel: "silent",
    plugins: [refuseNext, emptyServerOnly],
  });
  try {
    await checkPackages(result.metafile);
  } catch (error) {
    // Leave no bundle that would fail in the image.
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  await copyMigrations(output);
  await copyCardAssets(output);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await buildWorker();
    console.log("Built the media worker into dist/worker");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
