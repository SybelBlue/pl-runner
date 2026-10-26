import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function nodeEntrypoint(name: string): { command: string; args: string[] } {
  const compiled = new URL(`./${name}.js`, import.meta.url);
  if (fs.existsSync(fileURLToPath(compiled))) {
    return { command: process.execPath, args: [fileURLToPath(compiled)] };
  }
  const source = new URL(`./${name}.ts`, import.meta.url);
  return { command: process.execPath, args: ["--import", "tsx", fileURLToPath(source)] };
}
