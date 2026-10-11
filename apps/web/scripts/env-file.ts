// Tiny .env reader for the AUSD dev scripts: fills process.env from <repo root>/.env.ausd and .env without overriding
// anything already set. Values are never printed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadRepoEnv(files = [".env.ausd", ".env"]): void {
  for (const name of files) {
    const path = resolve(__dirname, "../../..", name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*([^#\s]*)/.exec(line);
      if (m && m[1] && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}
