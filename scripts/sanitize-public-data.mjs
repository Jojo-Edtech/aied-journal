import { readFile, writeFile } from "node:fs/promises";

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const targets = [
  {
    file: "data/radar/journal_articles.jsonl",
    fields: ["title", "abstract", "keywords", "error"],
  },
  {
    file: "data/radar/rag_documents.jsonl",
    fields: ["title", "text_snippet"],
  },
];

const structuredTargets = [
  { file: "data/radar/journals.json", fields: ["word_limit"] },
  { file: "data/radar/journals_q1.json", fields: ["word_limit"] },
  { file: "data/radar/source_workbook_snapshot.json", fields: ["word_limit"] },
];

let replacements = 0;

for (const { file, fields } of targets) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  const sanitized = lines.map((line) => {
    const record = JSON.parse(line);
    let changed = false;
    for (const field of fields) {
      if (typeof record[field] !== "string") continue;
      record[field] = record[field].replace(emailPattern, () => {
        replacements += 1;
        changed = true;
        return "[email redacted]";
      });
    }
    return changed ? JSON.stringify(record) : line;
  });
  await writeFile(file, `${sanitized.join("\n")}\n`, "utf8");
}

for (const { file, fields } of structuredTargets) {
  const records = JSON.parse(await readFile(file, "utf8"));
  for (const record of records) {
    for (const field of fields) {
      if (typeof record[field] !== "string") continue;
      record[field] = record[field].replace(emailPattern, () => {
        replacements += 1;
        return "[email redacted]";
      });
    }
  }
  await writeFile(file, JSON.stringify(records, null, 2), "utf8");
}

console.log(JSON.stringify({ replacements, files: targets.length + structuredTargets.length }));
