import fs from "node:fs/promises";
import path from "node:path";

const withSourcemap = process.argv.includes("--sourcemap");
const outDir = path.join(process.cwd(), "bundle");
const outFile = path.join(outDir, "index.js");

await fs.mkdir(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(process.cwd(), "src", "index.ts")],
  outdir: outDir,
  target: "node",
  format: "esm",
  minify: true,
  sourcemap: withSourcemap ? "external" : "none",
  splitting: false,
  external: ["bun:sqlite", "node:sqlite"]
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log.message}\n`);
  }
  process.exitCode = 1;
  process.exit();
}

const bundled = await fs.readFile(outFile, "utf8");
if (!bundled.startsWith("#!/usr/bin/env node")) {
  await fs.writeFile(outFile, `#!/usr/bin/env node\n${bundled}`, "utf8");
}

await fs.chmod(outFile, 0o755);
const stat = await fs.stat(outFile);
process.stdout.write(`Bundled: bundle/index.js (${Math.round(stat.size / 1024)} KB)\n`);
