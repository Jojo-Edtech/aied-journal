import { cp, mkdir, rm } from "node:fs/promises";

const outputDir = "dist";
const rootFiles = [".nojekyll", "index.html", "styles.css", "app.js"];

await rm(outputDir, { recursive: true, force: true });
await mkdir(`${outputDir}/data`, { recursive: true });

for (const file of rootFiles) {
  await cp(file, `${outputDir}/${file}`);
}

await cp("data/radar", `${outputDir}/data/radar`, { recursive: true });

console.log(`AIED Journal Radar static site prepared in ${outputDir}/`);
