import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const source = path.resolve(projectDir, "..", "..", "system_content.json");
const publicDir = path.join(projectDir, "public");
const target = path.join(publicDir, "system_content.json");

await mkdir(publicDir, { recursive: true });
await copyFile(source, target);
console.log(`Synced ${path.relative(projectDir, source)} -> ${path.relative(projectDir, target)}`);
