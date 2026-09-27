/**
 * Static build for OmniFormat AI Studio Max.
 *
 * The application itself is served inline by server.mjs (zero runtime deps).
 * This build step simply emits the Vite-style shell entry into dist/ so the
 * static output convention (`dist/`) is satisfied without adding dependencies.
 */
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outDir = resolve(root, "dist");

mkdirSync(outDir, { recursive: true });
cpSync(resolve(root, "index.html"), resolve(outDir, "index.html"));

// The shell module is authored as TypeScript for editor tooling; the static
// build emits a plain-JS equivalent (it uses no TS-only syntax at runtime).
writeFileSync(
  resolve(outDir, "main.js"),
  `"use strict";
(function () {
  var root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = '';
})();
`,
);

console.log("[build] dist/ written (static shell; full app served by server.mjs)");
