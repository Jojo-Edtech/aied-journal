import { cp, mkdir, rm, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { buildLocalData } from "./build-local-data.mjs";

const outputDir = "dist";
const maxPublishedBytes = 900_000_000;
let publishedBytes = 0;
async function publishFile(source, destination) {
  if (source.endsWith(".json")) {
    // Compact whitespace only; every public field and value is retained.
    await writeFile(destination, JSON.stringify(JSON.parse(await readFile(source, "utf8"))));
  } else {
    await cp(source, destination);
  }
  const { size } = await stat(destination);
  publishedBytes += size;
  if (size >= 100_000_000 || publishedBytes > maxPublishedBytes) {
    throw new Error("Public radar exceeds the publishing size budget. Source data is preserved; review retention before deploying.");
  }
}
const rootFiles = [".nojekyll", "index.html", "styles.css", "data-loader.js", "app.js"];
const publicFiles = [
  "journals.json", "journals_q1.json", "journal_sources.json", "research_network.json",
  "crawl_report.json", "radar-config.json", "editor_profiles.json", "data-manifest.json", "journal-scope-audit.json",
  "journal_preferences_index.json", "journal_articles_index.json", "rag_documents_index.json",
];
const publicShards = {
  journal_preferences: /^[\p{L}\p{N}_-]+\.json$/u,
  journal_articles: /^[\p{L}\p{N}_-]+\.jsonl$/u,
  rag_documents: /^[\p{L}\p{N}_-]+\.jsonl$/u,
};

await buildLocalData();
await rm(outputDir, { recursive: true, force: true });
await mkdir(`${outputDir}/data/radar`, { recursive: true });
for (const file of rootFiles) await publishFile(file, `${outputDir}/${file}`);
for (const file of publicFiles) {
  await publishFile(`data/radar/${file}`, `${outputDir}/data/radar/${file}`).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
// Do not recursively publish raw catalog imports, workbook snapshots, old
// monoliths, symlinks, or unrelated files that happen to be under data/.
// Offline JS bundles stay in the local checkout. Hosting both JSON and its
// file-mode duplicate would needlessly double the large catalog deployment.
for (const [directory, allowedName] of Object.entries(publicShards)) {
  const entries = await readdir(`data/radar/${directory}`, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  await mkdir(`${outputDir}/data/radar/${directory}`, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !allowedName.test(entry.name)) continue;
    await publishFile(`data/radar/${directory}/${entry.name}`, `${outputDir}/data/radar/${directory}/${entry.name}`);
  }
}
console.log(`AIED Journal Radar static site prepared in ${outputDir}/ (${publishedBytes} bytes)`);
