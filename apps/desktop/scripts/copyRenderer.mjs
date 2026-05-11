import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("src", "renderer", "index.html");
const target = path.resolve("dist", "apps", "desktop", "src", "renderer", "index.html");

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);