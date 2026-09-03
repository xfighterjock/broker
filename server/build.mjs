import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

await esbuild.build({
  entryPoints: [path.join(here, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(root, "dist/server.js"),
  sourcemap: true,
  external: ["firebase-admin", "firebase-admin/app", "firebase-admin/messaging"],
});

await esbuild.build({
  entryPoints: [path.join(here, "src/migrate.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(root, "dist/migrate.js"),
  sourcemap: true,
});

mkdirSync(path.join(root, "dist"), { recursive: true });
writeFileSync(path.join(root, "dist/package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
console.log("server build ok -> dist/server.js dist/migrate.js");
