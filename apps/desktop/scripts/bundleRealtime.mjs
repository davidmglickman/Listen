import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const outdir = path.join(desktopRoot, "dist", "apps", "desktop", "resources", "realtime");

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, "services", "realtime", "src", "server.ts")],
  outfile: path.join(outdir, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  external: [
    "electron",
  ],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
  },
});