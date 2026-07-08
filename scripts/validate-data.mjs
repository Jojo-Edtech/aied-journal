import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

let failures = 0;

async function readJson(file, fallback = null) {
  if (!existsSync(file)) {
    console.error(`${file} does not exist.`);
    failures += 1;
    return fallback;
  }
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    console.error(`${file} is not valid JSON: ${error.message}`);
    failures += 1;
    return fallback;
  }
}

async function countJsonl(file) {
  if (!existsSync(file)) {
    console.error(`${file} does not exist.`);
    failures += 1;
    return 0;
  }
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}

const journals = await readJson("data/radar/journals.json", []);
const q1Journals = await readJson("data/radar/journals_q1.json", []);
const sources = await readJson("data/radar/journal_sources.json", []);
const network = await readJson("data/radar/research_network.json", { nodes: [], links: [] });
const report = await readJson("data/radar/crawl_report.json", {});
const config = await readJson("data/radar/radar-config.json", {});
const snapshot = await readJson("data/radar/source_workbook_snapshot.json", []);
const preferences = await readJson("data/radar/journal_preferences.json", []);
const editorProfiles = await readJson("data/radar/editor_profiles.json", []);
const articleLines = await countJsonl("data/radar/journal_articles.jsonl");
const ragLines = await countJsonl("data/radar/rag_documents.jsonl");

if (!Array.isArray(journals) || journals.length !== 268) {
  console.error(`data/radar/journals.json expected 268 journals, found ${Array.isArray(journals) ? journals.length : "invalid"}.`);
  failures += 1;
}

if (!Array.isArray(q1Journals) || q1Journals.length !== 135) {
  console.error(`data/radar/journals_q1.json expected 135 Q1 journals, found ${Array.isArray(q1Journals) ? q1Journals.length : "invalid"}.`);
  failures += 1;
}

const allowedQuartiles = new Set(["Q1", "Q2", "Q3", "Q4"]);
const journalIds = new Set();
const quartileCounts = new Map();
const requiredFields = ["id", "name", "quartile", "main_tag", "publisher_family"];

for (const [index, journal] of (journals || []).entries()) {
  const label = `data/radar/journals.json row ${index + 1}`;
  for (const field of requiredFields) {
    if (!journal[field]) {
      console.error(`${label} missing ${field}.`);
      failures += 1;
    }
  }
  if (!allowedQuartiles.has(journal.quartile)) {
    console.error(`${label} has unsupported quartile ${journal.quartile}.`);
    failures += 1;
  }
  if (journalIds.has(journal.id)) {
    console.error(`${label} duplicates id ${journal.id}.`);
    failures += 1;
  }
  journalIds.add(journal.id);
  quartileCounts.set(journal.quartile, (quartileCounts.get(journal.quartile) || 0) + 1);
}

for (const [index, journal] of (q1Journals || []).entries()) {
  if (journal.quartile !== "Q1") {
    console.error(`data/radar/journals_q1.json row ${index + 1} has quartile ${journal.quartile}.`);
    failures += 1;
  }
}

if (!Array.isArray(sources)) {
  console.error("data/radar/journal_sources.json must be an array.");
  failures += 1;
}

if (!Array.isArray(network.nodes) || !Array.isArray(network.links) || network.nodes.length === 0 || network.links.length === 0) {
  console.error("data/radar/research_network.json must include non-empty nodes and links.");
  failures += 1;
}

const nodeIds = new Set((network.nodes || []).map((node) => node.id));
for (const link of network.links || []) {
  if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) {
    console.error(`data/radar/research_network.json has dangling link ${link.source} -> ${link.target}.`);
    failures += 1;
    break;
  }
}

if (report.journal_count !== 268 || report.journal_count_matches_expected !== true) {
  console.error("data/radar/crawl_report.json does not confirm 268 total journals.");
  failures += 1;
}

if (report.q1_count !== 135 || report.q1_count_matches_expected !== true) {
  console.error("data/radar/crawl_report.json does not confirm 135 Q1 journals.");
  failures += 1;
}

if (!report.speed_coverage || typeof report.speed_coverage.first_decision_days !== "number") {
  console.error("data/radar/crawl_report.json missing speed_coverage.");
  failures += 1;
}

if (!report.editor_profile_coverage || typeof report.editor_profile_coverage.profiles !== "number") {
  console.error("data/radar/crawl_report.json missing editor_profile_coverage.");
  failures += 1;
}

if (!report.preference_coverage || typeof report.preference_coverage.journals_with_any_articles !== "number") {
  console.error("data/radar/crawl_report.json missing preference_coverage.");
  failures += 1;
}

const expectedPreferenceSlices = ["all", "latest_issue", "recent_3_issues", "rolling_1y", "rolling_2y", "rolling_3y", "rolling_5y"];

if (!Array.isArray(snapshot) || snapshot.length !== 268) {
  console.error("data/radar/source_workbook_snapshot.json must contain the 268-journal source snapshot.");
  failures += 1;
}

if (!Array.isArray(preferences) || preferences.length !== 268) {
  console.error(`data/radar/journal_preferences.json expected 268 records, found ${Array.isArray(preferences) ? preferences.length : "invalid"}.`);
  failures += 1;
} else {
  for (const record of preferences) {
    if (!journalIds.has(record.journal_id) || !record.slices || !record.slices.all) {
      console.error(`data/radar/journal_preferences.json missing all slice for ${record.journal_id || "unknown journal"}.`);
      failures += 1;
      break;
    }
    for (const key of expectedPreferenceSlices) {
      const slice = record.slices[key];
      if (!slice || typeof slice.sample_count !== "number" || typeof slice.description !== "string") {
        console.error(`data/radar/journal_preferences.json missing ${key} metadata for ${record.journal_id || "unknown journal"}.`);
        failures += 1;
        break;
      }
    }
  }
}

for (const key of expectedPreferenceSlices) {
  if (!report.preference_coverage?.range_slices || typeof report.preference_coverage.range_slices[key] !== "number") {
    console.error(`data/radar/crawl_report.json missing preference range coverage for ${key}.`);
    failures += 1;
    break;
  }
}

if (!Array.isArray(editorProfiles) || editorProfiles.length !== 268) {
  console.error(`data/radar/editor_profiles.json expected 268 records, found ${Array.isArray(editorProfiles) ? editorProfiles.length : "invalid"}.`);
  failures += 1;
} else {
  for (const record of editorProfiles) {
    if (!journalIds.has(record.journal_id) || !Array.isArray(record.profiles)) {
      console.error(`data/radar/editor_profiles.json has invalid record for ${record.journal_id || "unknown journal"}.`);
      failures += 1;
      break;
    }
  }
}

for (const [label, fileData] of [
  ["journals", journals],
  ["preferences", preferences],
  ["editorProfiles", editorProfiles],
  ["report", report],
  ["config", config],
]) {
  const text = JSON.stringify(fileData);
  if (/DEEPSEEK_API_KEY|MODELSCOPE_API_KEY|DASHSCOPE_API_KEY|RADAR_ACCESS_CODE|(?<![A-Za-z])sk-[A-Za-z0-9_-]{12,}/.test(text)) {
    console.error(`Potential secret found in public ${label} data.`);
    failures += 1;
  }
}

if (config.api_base_url && !/^https?:\/\//.test(config.api_base_url)) {
  console.error("data/radar/radar-config.json api_base_url must be an HTTP(S) URL when configured.");
  failures += 1;
}

if (articleLines === 0) {
  console.error("data/radar/journal_articles.jsonl is empty.");
  failures += 1;
}

if (ragLines === 0) {
  console.error("data/radar/rag_documents.jsonl is empty.");
  failures += 1;
}

console.log(
  [
    `journals=${Array.isArray(journals) ? journals.length : 0}`,
    `q1=${Array.isArray(q1Journals) ? q1Journals.length : 0}`,
    `quartiles=${[...quartileCounts.entries()].map(([quartile, count]) => `${quartile}:${count}`).join(",")}`,
    `sources=${Array.isArray(sources) ? sources.length : 0}`,
    `network=${(network.nodes || []).length} nodes/${(network.links || []).length} links`,
    `articles=${articleLines}`,
    `rag_docs=${ragLines}`,
    `speed=first:${report.speed_coverage?.first_decision_days ?? 0}/review:${report.speed_coverage?.review_time_days ?? 0}/accept:${report.speed_coverage?.submission_to_accept_days ?? 0}`,
    `editors=${report.editor_profile_coverage?.profiles ?? 0} profiles/${report.editor_profile_coverage?.with_affiliation ?? 0} affiliations/${report.editor_profile_coverage?.with_country_or_region ?? 0} regions`,
    `preferences=${report.preference_coverage?.journals_with_any_articles ?? 0}/${report.preference_coverage?.total ?? 0}`,
    `ranges=${expectedPreferenceSlices.map((key) => `${key}:${report.preference_coverage?.range_slices?.[key] ?? 0}`).join(",")}`,
  ].join(" | ")
);

if (failures > 0) {
  console.error(`${failures} validation failure(s).`);
  process.exitCode = 1;
}
