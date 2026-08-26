import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

await esbuild.build({
  entryPoints: [path.join(here, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(root, "dist/server.js"),
  packages: "external",
  sourcemap: true,
});

await esbuild.build({
  entryPoints: [path.join(here, "src/migrate.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(root, "dist/migrate.js"),
  packages: "external",
  sourcemap: true,
});

console.log("server build ok -> dist/server.js dist/migrate.js");
