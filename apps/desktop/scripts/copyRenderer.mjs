import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const source = path.join(desktopRoot, "src", "renderer", "index.html");
const target = path.join(desktopRoot, "dist", "apps", "desktop", "src", "renderer", "index.html");

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);