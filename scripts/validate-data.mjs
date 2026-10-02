import { readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const directoryAt = args.indexOf("--data-dir");
const root = path.resolve(directoryAt >= 0 ? args[directoryAt + 1] : "data/radar");
let failures = 0;
const fail = (message) => { console.error(message); failures += 1; };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,179}$/;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const credentialPattern = /(?:DEEPSEEK_API_KEY|MODELSCOPE_API_KEY|DASHSCOPE_API_KEY|RADAR_ACCESS_CODE|(?<![A-Za-z])sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})/g;

function inspectPublic(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if ((text.match(emailPattern) || []).length) fail(`${label} contains public email addresses.`);
  if ((text.match(credentialPattern) || []).length) fail(`${label} contains potential credentials.`);
}

async function readJson(relative, fallback = null) {
  try {
    const value = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    inspectPublic(value, relative);
    return value;
  } catch (error) {
    fail(`${relative} is missing or invalid: ${error.message}`);
    return fallback;
  }
}

async function shardPath(relative, dataset, id, suffix) {
  if (!safeId.test(id) || relative !== `${dataset}/${id}${suffix}`) throw new Error(`Unsafe ${dataset} shard path for ${id}`);
  const absolute = await realpath(path.join(root, relative));
  const realRoot = await realpath(root);
  if (!absolute.startsWith(`${realRoot}${path.sep}`)) throw new Error(`Shard escapes data directory: ${relative}`);
  return absolute;
}

const journals = await readJson("journals.json", []);
const q1Journals = await readJson("journals_q1.json", []);
const sources = await readJson("journal_sources.json", []);
const network = await readJson("research_network.json", { nodes: [], links: [] });
const report = await readJson("crawl_report.json", {});
const config = await readJson("radar-config.json", {});
const baseline = await readJson("source_workbook_snapshot.json", []);
const editorProfiles = await readJson("editor_profiles.json", []);
const manifest = await readJson("data-manifest.json", {});
const scopeAudit = await readJson("journal-scope-audit.json", {});
const journalMap = new Map();
const quartileCounts = new Map();
const allowedQuartiles = new Set([null, "Q1", "Q2", "Q3", "Q4"]);
const metricFields = ["jif_2025", "jci_2025", "quartile", "publications"];
const slices = ["all", "latest_issue", "recent_3_issues", "rolling_1y", "rolling_2y", "rolling_3y", "rolling_5y"];
const allowedIndexes = ["SSCI", "ESCI", "Scopus"];
const scopeId = "english-ssci-esci-scopus-v1";
const scopeExcluded = new Map((Array.isArray(scopeAudit.excluded) ? scopeAudit.excluded : []).map((row) => [row.journal_id, row]));
const isEvidenceUrl = (entry) => {
  try { const url = new URL(entry?.url || entry?.source_url || entry?.evidence_url || ""); return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname); }
  catch { return false; }
};

if (!Array.isArray(journals) || journals.length === 0) fail("journals.json must be a nonempty array.");
for (const [index, journal] of (Array.isArray(journals) ? journals : []).entries()) {
  for (const field of ["id", "name", "main_tag", "publisher_family"]) {
    if (!journal[field]) fail(`Journal row ${index + 1} is missing ${field}.`);
  }
  if (!safeId.test(journal.id || "") || journalMap.has(journal.id)) fail(`Invalid or duplicate journal ID: ${journal.id}`);
  if (!allowedQuartiles.has(journal.quartile)) fail(`Invalid quartile for ${journal.id}; unknown must be null.`);
  for (const field of ["jif_2025", "jci_2025"]) {
    if (journal[field] !== null && !(typeof journal[field] === "number" && Number.isFinite(journal[field]) && journal[field] >= 0)) fail(`Invalid ${field} for ${journal.id}.`);
  }
  if (typeof journal.has_jcr_record !== "boolean") fail(`Missing JCR provenance flag for ${journal.id}.`);
  if (!journal.has_jcr_record && ["jif_2025", "jci_2025", "quartile", "metrics_year"].some((field) => journal[field] !== null)) fail(`Catalog-only journal ${journal.id} must not claim JCR metrics.`);
  for (const field of ["source_urls", "catalog_sources", "issns"]) {
    if (!Array.isArray(journal[field])) fail(`Missing ${field} array for ${journal.id}.`);
  }
  if (!Array.isArray(journal.languages) || !journal.languages.includes("English") || journal.languages.includes("Chinese")) fail(`Journal violates the English-only/no-Chinese scope: ${journal.id}.`);
  if (!Array.isArray(journal.indexes) || !journal.indexes.length || new Set(journal.indexes).size !== journal.indexes.length || journal.indexes.some((value) => !allowedIndexes.includes(value))) fail(`Missing or invalid verified index for ${journal.id}.`);
  if (!Array.isArray(journal.index_evidence) || !journal.index_evidence.some(isEvidenceUrl) || journal.scope_id !== scopeId) fail(`Missing index evidence/scope identity for ${journal.id}.`);
  journalMap.set(journal.id, journal);
  quartileCounts.set(journal.quartile || "unknown", (quartileCounts.get(journal.quartile || "unknown") || 0) + 1);
}
const journalIds = new Set(journalMap.keys());
function checkIds(records, field, label) {
  if (!Array.isArray(records)) { fail(`${label} must be an array.`); return; }
  const ids = new Set(records.map((record) => record[field]));
  if (ids.size !== records.length || ids.size !== journalIds.size || [...journalIds].some((id) => !ids.has(id))) fail(`${label} must have exactly one record per journal.`);
}
const actualQ1 = [...journalMap.values()].filter((journal) => journal.quartile === "Q1");
if (!Array.isArray(q1Journals) || !same(q1Journals.map((j) => j.id).sort(), actualQ1.map((j) => j.id).sort())) fail("Q1 data must exactly equal the verified Q1 subset of the full catalog.");
for (const journal of Array.isArray(q1Journals) ? q1Journals : []) {
  if (journal.quartile !== "Q1" || !same(journal, journalMap.get(journal.id))) fail(`Q1 record differs from full catalog: ${journal.id}`);
}
if (!Array.isArray(baseline) || baseline.length === 0) fail("The independent JCR source snapshot must be preserved.");
const baselineIds = new Set();
for (const record of Array.isArray(baseline) ? baseline : []) {
  if (baselineIds.has(record.id)) fail(`Duplicate baseline ID ${record.id}.`);
  baselineIds.add(record.id);
  const journal = journalMap.get(record.id);
  if (!journal) {
    if (!scopeExcluded.get(record.id)?.has_jcr_record) fail(`JCR baseline record missing without a scope exclusion: ${record.id}`);
    continue;
  }
  if (!journal.has_jcr_record) { fail(`JCR baseline provenance missing: ${record.id}`); continue; }
  for (const field of metricFields) if (!same(record[field] ?? null, journal[field] ?? null)) fail(`JCR baseline ${field} changed for ${record.id}.`);
}
for (const journal of journalMap.values()) if (journal.has_jcr_record && !baselineIds.has(journal.id)) fail(`Unverified JCR provenance for ${journal.id}.`);
if (scopeAudit.schema_version !== 1 || scopeAudit.scope_id !== scopeId || scopeAudit.data_version !== manifest.data_version || manifest.scope_audit !== "journal-scope-audit.json") fail("Required journal scope audit is invalid.");
if (!same(scopeAudit.allowed_indexes, allowedIndexes)) fail("Scope audit permits unexpected indexes.");
if (!Array.isArray(scopeAudit.included_ids) || new Set(scopeAudit.included_ids).size !== journalIds.size || !same([...scopeAudit.included_ids].sort(), [...journalIds].sort())) fail("Scope audit included identities do not match the published catalog.");
if (!Array.isArray(scopeAudit.excluded) || scopeExcluded.size !== scopeAudit.excluded.length || [...scopeExcluded.keys()].some((id) => journalIds.has(id) || !safeId.test(id))) fail("Scope audit has duplicate, unsafe or included exclusions.");
const reasonCounts = {};
if (!scopeAudit.identity_exclusions || typeof scopeAudit.identity_exclusions !== "object" || Array.isArray(scopeAudit.identity_exclusions) || Object.values(scopeAudit.identity_exclusions).some((value) => value !== "identity_ambiguity")) fail("Scope identity exclusions must be an explicit mapping.");
for (const excluded of scopeExcluded.values()) {
  const languages = excluded.languages || [];
  const indexes = excluded.indexes || [];
  const expectedReason = scopeAudit.identity_exclusions?.[excluded.journal_id] === "identity_ambiguity" ? "identity_ambiguity" : languages.includes("Chinese") ? "chinese_language" : !languages.includes("English") ? "english_language_unverified" : !indexes.length ? "allowed_index_unverified" : null;
  if (!Array.isArray(languages) || !Array.isArray(indexes) || indexes.some((index) => !allowedIndexes.includes(index)) || excluded.reason !== expectedReason || !expectedReason) fail(`Invalid scope exclusion reason: ${excluded.journal_id}.`);
  reasonCounts[excluded.reason] = (reasonCounts[excluded.reason] || 0) + 1;
}
for (const id of Object.keys(scopeAudit.identity_exclusions || {})) if (journalIds.has(id)) fail(`Identity-ambiguous journal was published: ${id}.`);
if (scopeAudit.included_count !== journalIds.size || scopeAudit.excluded_count !== scopeExcluded.size || scopeAudit.input_count !== journalIds.size + scopeExcluded.size) fail("Scope audit counts do not reconcile.");
for (const key of new Set([...Object.keys(reasonCounts), ...Object.keys(scopeAudit.excluded_reason_counts || {})])) if (reasonCounts[key] !== scopeAudit.excluded_reason_counts?.[key]) fail(`Scope exclusion count mismatch: ${key}.`);
for (const index of allowedIndexes) if (scopeAudit.index_counts?.[index] !== journals.filter((journal) => journal.indexes?.includes(index)).length) fail(`Scope index count mismatch: ${index}.`);
if (scopeAudit.source_snapshot_count !== baseline.length || !/^[a-f0-9]{64}$/.test(scopeAudit.index_evidence_sha256 || "")) fail("Scope source counts/evidence fingerprint are invalid.");
try {
  const snapshotHash = createHash("sha256").update(await readFile(path.join(root, "source_workbook_snapshot.json"))).digest("hex");
  if (scopeAudit.source_snapshot_sha256 !== snapshotHash) fail("The complete source workbook snapshot differs from its scope audit fingerprint.");
} catch { fail("Cannot verify preserved source workbook snapshot."); }
const scopeSummary = Object.fromEntries(Object.entries(scopeAudit).filter(([key]) => !["included_ids", "excluded"].includes(key)));
if (!same(manifest.journal_scope, scopeSummary) || !same(report.journal_scope, scopeSummary)) fail("Manifest/report scope summaries differ from the audited scope.");
checkIds(editorProfiles, "journal_id", "editor_profiles.json");
for (const record of Array.isArray(editorProfiles) ? editorProfiles : []) if (!Array.isArray(record.profiles)) fail(`Invalid editor profile list for ${record.journal_id}.`);
if (!Array.isArray(sources)) fail("journal_sources.json must be an array.");
for (const source of Array.isArray(sources) ? sources : []) if (!journalIds.has(source.journal_id)) fail(`Unknown journal source reference: ${source.journal_id}.`);
if (!Array.isArray(network.nodes) || !Array.isArray(network.links)) fail("Research network must contain node/link arrays.");
const nodeIds = new Set((network.nodes || []).map((node) => node.id));
const networkJournals = new Set((network.nodes || []).filter((node) => node.type === "journal").map((node) => node.id));
if (networkJournals.size !== journalIds.size || [...journalIds].some((id) => !networkJournals.has(id))) fail("Research network omits journal records.");
for (const link of network.links || []) if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) fail(`Dangling research network link: ${link.source} -> ${link.target}.`);
if (config.api_base_url && !/^https?:\/\//.test(config.api_base_url)) fail("api_base_url must be HTTP(S) when configured.");
if (manifest.schema_version !== 1 || !manifest.data_version || manifest.data_version !== report.generated_at) fail("Manifest/report versions are inconsistent.");
const includedBaselineCount = journals.filter((journal) => journal.has_jcr_record).length;
for (const [field, value] of [["journal_count", journals.length], ["jcr_journal_count", includedBaselineCount], ["q1_count", actualQ1.length]]) {
  if (manifest[field] !== value || report[field] !== value) fail(`Manifest/report ${field} does not match the actual data.`);
}
if (manifest.catalog_journal_count !== journals.length - includedBaselineCount) fail("Manifest catalog-only count does not match the scoped data.");
if (report.baseline_preservation?.journal_count !== baseline.length || report.baseline_preservation?.source_snapshot_preserved !== true || report.baseline_preservation?.included_count !== includedBaselineCount || report.baseline_preservation?.scope_excluded_count !== baseline.length - includedBaselineCount || report.baseline_preservation?.all_ids_preserved !== (includedBaselineCount === baseline.length) || report.baseline_preservation?.metrics_preserved !== true) fail("Source baseline preservation and scoped metric preservation were not confirmed.");

const totals = { journal_articles: 0, rag_documents: 0 };
const ranges = Object.fromEntries(slices.map((key) => [key, 0]));
const articleCounts = new Map();
const preferenceCounts = new Map();
const allDocIds = new Set();
for (const dataset of ["journal_articles", "rag_documents", "journal_preferences"]) {
  const index = await readJson(`${dataset}_index.json`, {});
  if (index.schema_version !== 1 || index.data_version !== manifest.data_version || !index.journals || typeof index.journals !== "object" || Array.isArray(index.journals)) { fail(`Invalid ${dataset} index.`); continue; }
  const ids = Object.keys(index.journals);
  if (ids.length !== journalIds.size || ids.some((id) => !journalIds.has(id))) fail(`${dataset} index must cover the complete journal catalog.`);
  if (manifest.datasets?.[dataset] !== `${dataset}_index.json`) fail(`Manifest has an invalid ${dataset} index path.`);
  for (const [id, entry] of Object.entries(index.journals)) {
    try {
      const isPreference = dataset === "journal_preferences";
      const absolute = await shardPath(entry.path, dataset, id, isPreference ? ".json" : ".jsonl");
      const text = await readFile(absolute, "utf8");
      inspectPublic(text, entry.path);
      if (isPreference) {
        const record = JSON.parse(text);
        if (record.journal_id !== id || record.journal_name !== journalMap.get(id)?.name) fail(`Incorrect preference journal identity: ${id}.`);
        if (!Array.isArray(entry.available_time_slices)) fail(`Missing available preference ranges: ${id}.`);
        for (const key of slices) {
          const slice = record.slices?.[key];
          if (!slice || !Number.isInteger(slice.sample_count) || slice.sample_count < 0 || typeof slice.description !== "string") { fail(`Invalid ${key} preference range for ${id}.`); continue; }
          if (slice.sample_count > 0) ranges[key] += 1;
        }
        if (entry.sample_count !== record.slices?.all?.sample_count || !same(entry.available_time_slices, record.available_time_slices)) fail(`Preference index summary differs from its shard: ${id}.`);
        preferenceCounts.set(id, entry.sample_count);
      } else {
        const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
        if (!Number.isInteger(entry.count) || entry.count !== rows.length) fail(`Wrong ${dataset} count for ${id}.`);
        const seen = new Set();
        for (const row of rows) {
          if (row.journal_id !== id || row.journal_name !== journalMap.get(id)?.name) fail(`Incorrect ${dataset} journal identity in ${id}.`);
          if (dataset === "rag_documents") {
            if (!row.doc_id || allDocIds.has(row.doc_id)) fail(`Missing or duplicate RAG document ID in ${id}.`);
            allDocIds.add(row.doc_id);
            if (row.source_type === "jcr_workbook" && !baselineIds.has(id)) fail(`Catalog record incorrectly labelled as JCR evidence: ${id}.`);
          } else {
            const doi = String(row.doi || "").toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
            const key = doi || row.url || `${row.title}|${row.year || ""}`;
            if (seen.has(key)) fail(`Duplicate article in ${id}.`);
            seen.add(key);
            if (row.status !== "ok" || !row.title) fail(`Failed/empty article counted as valid evidence in ${id}.`);
          }
        }
        if (dataset === "rag_documents" && rows.length === 0) fail(`Missing base source document for ${id}.`);
        if (dataset === "journal_articles") articleCounts.set(id, rows.length);
        totals[dataset] += rows.length;
      }
    } catch (error) {
      fail(`${dataset}/${id}: ${error.message}`);
    }
  }
}
for (const id of journalIds) {
  const count = articleCounts.get(id);
  if (count !== preferenceCounts.get(id) || count !== journalMap.get(id)?.article_count_crawled || count !== journalMap.get(id)?.article_preferences?.article_sample_count) fail(`Article/preference counts disagree for ${id}.`);
}
if (totals.journal_articles !== report.articles?.total || totals.journal_articles !== manifest.article_count) fail("Article counts disagree with the report/manifest.");
if (totals.rag_documents !== report.rag_documents || totals.rag_documents !== manifest.rag_document_count) fail("RAG counts disagree with the report/manifest.");
for (const key of slices) if (ranges[key] !== report.preference_coverage?.range_slices?.[key]) fail(`Preference coverage mismatch for ${key}.`);
if (report.preference_coverage?.total !== journalIds.size || report.speed_coverage?.total !== journalIds.size) fail("Coverage denominators must equal the complete catalog size.");
for (const relative of ["journal_preferences.json", "journal_articles.jsonl", "rag_documents.jsonl"]) if (existsSync(path.join(root, relative))) fail(`Legacy monolith should not remain in a partitioned build: ${relative}`);
console.log(`journals=${journalIds.size} | jcr=${includedBaselineCount} | baseline_archive=${baselineIds.size} | q1=${actualQ1.length} | articles=${totals.journal_articles} | rag_docs=${totals.rag_documents} | quartiles=${[...quartileCounts].map(([q, count]) => `${q}:${count}`).join(",")}`);
if (failures) { console.error(`${failures} validation failure(s).`); process.exitCode = 1; }
