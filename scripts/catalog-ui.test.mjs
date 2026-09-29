import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
// Evaluate the actual render/filter functions without starting a browser or API.
const functionsOnly = source.slice(0, source.indexOf('els.search.addEventListener("input"'));
class Element {
  constructor(tag = "div") { this.tagName = tag; this.value = "all"; this.hidden = false; this.childNodes = []; this.dataset = {}; this.attributes = {}; this.style = {}; this.textContent = ""; this._html = ""; this.classList = { add() {}, remove() {}, toggle() {} }; }
  set innerHTML(value) { this._html = value; this.childNodes = []; }
  get innerHTML() { return this._html; }
  get options() { return this.childNodes; }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener() {}
  querySelectorAll() { return []; }
  querySelector(tag) { return this.childNodes.find((node) => node.tagName === tag) || null; }
  insertAdjacentHTML(position, html) { this._html += html; }
  closest() { return null; }
}
function setup() {
  const elements = new Map();
  const context = vm.createContext({
    localStorage: { getItem: () => "zh" }, Intl, URL,
    document: {
      querySelector: (key) => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); },
      createElement: (tag) => new Element(tag), createElementNS: (ns, tag) => new Element(tag),
    },
    window: { clearTimeout() {}, setTimeout: () => 0, requestAnimationFrame: (fn) => fn() },
    RadarData: {},
  });
  vm.runInContext(functionsOnly, context);
  const api = vm.runInContext('({ state, els, quartileKey, quartileLabel, metricLabel, languageLabel, median, buildSearchIndex, filteredJournals, sortedTableJournals, renderTable, renderScatter, renderKpis, renderNetwork, evidenceSummary, websiteEvidenceCount, sourceListHtml, renderJournalDetail, ensureJournalPreference, latestIssueSignalHtml, rangeMetaText, t, refreshFilters })', context);
  api.els.search.value = "";
  return { context, ...api };
}
const journals = [
  { id: "journal-old", name: "Original Journal", quartile: "Q1", jif_2025: 5, jci_2025: 2, main_tag: "教育技术", languages: ["en"], catalog_sources: [{ id: "jcr", label: "JCR workbook" }] },
  { id: "journal-cn", name: "教育研究", aliases: ["教育探索别名"], issn: "1234-5678", issns: ["1234-5678"], quartile: null, jif_2025: null, jci_2025: null, country: "China", main_tag: "教育技术", languages: ["zh"], catalog_sources: [{ id: "doaj", label: "DOAJ", url: "https://doaj.org", record_id: "entry-cn", retrieved_at: "2026-09-29" }] },
  { id: "journal-zero", name: "Zero Journal", quartile: "Q4", jif_2025: 0, jci_2025: 0, main_tag: "教育技术", languages: ["en", "zh"], catalog_sources: [{ id: "doaj", label: "DOAJ" }] },
];
function load(api) { api.state.journals = structuredClone(journals); api.buildSearchIndex(); }

test("null metrics stay missing, real zero is retained, unknown quartile is not labelled JCR", () => {
  const api = setup();
  load(api);
  assert.equal(api.metricLabel(null), "指标缺失");
  assert.equal(api.metricLabel(0), "0");
  assert.equal(api.median([null, 0, 4]), 2);
  assert.equal(api.quartileLabel(journals[1]), "JCR 未核验");
  for (const key of ["jif", "jci", "quartile"]) {
    for (const dir of [1, -1]) {
      api.state.tableSort = { key, dir };
      assert.equal(api.sortedTableJournals(api.state.journals).at(-1).id, "journal-cn");
    }
  }
});

test("unknown quartile, language and directory filters cover added journals", () => {
  const api = setup(); load(api); api.refreshFilters();
  assert.ok(api.els.quartile.options.some((option) => option.value === "__unknown__"));
  api.els.quartile.value = "__unknown__";
  assert.deepEqual(Array.from(api.filteredJournals(), (j) => j.id), ["journal-cn"]);
  api.els.quartile.value = "all";
  api.els.journalLanguage.value = "zh";
  api.els.catalog.value = "doaj";
  assert.deepEqual(Array.from(api.filteredJournals(), (j) => j.id).sort(), ["journal-cn", "journal-zero"]);
});

test("Chinese names, aliases, ISSNs, country and catalog record identifiers are searchable", () => {
  const api = setup(); load(api);
  for (const query of ["教育研究", "教育探索别名", "1234-5678", "China", "entry-cn"]) {
    api.els.search.value = query;
    assert.equal(api.filteredJournals()[0].id, "journal-cn", query);
  }
  assert.match(api.t("chatIdle"), /3 本/);
});

test("historical ISSNs are searchable in formatted and compact form", () => {
  const api = setup(); load(api);
  api.state.journals.push({ id: "journal-issn-19847238", name: "Revista Linhas", issns: ["1984-7238"], historical_issns: ["1518-367X"], languages: ["Portuguese"], quartile: null });
  api.buildSearchIndex();
  for (const query of ["1518-367X", "1518367x", "19847238"]) {
    api.els.search.value = query;
    assert.equal(api.filteredJournals()[0]?.id, "journal-issn-19847238", query);
  }
});

test("missing first-decision median has no days suffix while actual zero retains it", () => {
  const api = setup(); load(api);
  api.renderKpis([{ ...journals[1], first_decision_days: null }]);
  assert.ok(!api.els.kpis.innerHTML.includes("未标注天"));
  assert.match(api.els.kpis.innerHTML, /<strong>未标注<\/strong>/);
  api.renderKpis([{ ...journals[1], first_decision_days: 0 }]);
  assert.match(api.els.kpis.innerHTML, /<strong>0天<\/strong>/);
});

test("table stays at 120 rows per page across a 3000-journal catalog", () => {
  const api = setup();
  const rows = Array.from({ length: 3000 }, (_, i) => ({ ...journals[1], id: `journal-${i}`, name: `刊物 ${i}` }));
  api.renderTable(rows);
  assert.equal((api.els.tableBody.innerHTML.match(/<tr>/g) || []).length, 120);
  assert.match(api.els.tableBody.innerHTML, /JCR 未核验/);
  assert.equal(api.els.previousRows.disabled, true);
  api.state.tablePage = 24;
  api.renderTable(rows);
  assert.equal((api.els.tableBody.innerHTML.match(/<tr>/g) || []).length, 120);
  assert.equal(api.els.toggleRows.disabled, true);
  assert.match(api.els.tablePage.textContent, /25 \/ 25/);
});

test("scatter reports complete-catalog coverage and zero-only points have finite coordinates", () => {
  const api = setup(); load(api);
  api.renderScatter([journals[1]]);
  assert.match(api.els.scatter.innerHTML, /0 \/ 1/);
  api.renderScatter([journals[1], journals[2]]);
  assert.match(api.els.scatter.innerHTML, /1 \/ 2/);
  const svg = api.els.scatter.childNodes[0];
  const circle = svg.childNodes.find((node) => node.tagName === "circle");
  assert.ok(Number.isFinite(Number(circle.attributes.cx)));
  assert.ok(Number.isFinite(Number(circle.attributes.cy)));
});

test("catalog detail distinguishes directory evidence and escapes unsafe source links", () => {
  const api = setup(); load(api);
  const journal = { ...journals[1], catalog_sources: [{ id: "doaj", label: "DOAJ", url: "javascript:alert(1)", record_id: "<script>" }] };
  const html = api.sourceListHtml(journal, []);
  assert.match(html, /不代表 JCR 收录/);
  assert.match(html, /教育探索别名/);
  assert.match(html, /1234-5678/);
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("<script>"));
  assert.match(api.latestIssueSignalHtml(null), /尚未覆盖/);
  assert.match(api.rangeMetaText(null, "all"), /尚未覆盖/);
  api.state.preferenceStatus.set(journal.id, "error");
  api.renderJournalDetail(journal.id);
  const detail = api.els.detailContent.innerHTML;
  assert.match(detail, /当前目录来源未提供经核验的 JIF \/ JCI/);
  assert.match(detail, /年度发文量尚无可用来源/);
  assert.ok(!detail.includes("Excel"));
  assert.ok(!detail.includes("原记录的 2025"));
  api.state.journalsById.set(journal.id, { ...journal, has_jcr_record: true });
  api.renderJournalDetail(journal.id);
  assert.match(api.els.detailContent.innerHTML, /原记录的 2025/);
  assert.match(api.els.detailContent.innerHTML, /来自 Excel/);
});

test("slow preference response cannot replace another journal after rapid navigation", async () => {
  const api = setup();
  const pending = new Map();
  const rendered = [];
  api.context.RadarData.loadPreference = (id) => new Promise((resolve) => pending.set(id, resolve));
  api.context.rendered = rendered;
  vm.runInContext('renderJournalDetail = (id) => rendered.push(id)', api.context);
  api.state.selectedJournalId = "a"; api.state.detailRequestToken = 1;
  const first = api.ensureJournalPreference("a");
  api.state.selectedJournalId = "b"; api.state.detailRequestToken = 2;
  const second = api.ensureJournalPreference("b");
  pending.get("a")({ journal_id: "a" });
  await first;
  assert.deepEqual(rendered, []);
  pending.get("b")({ journal_id: "b" });
  await second;
  assert.deepEqual(rendered, ["b"]);
  assert.equal(api.state.preferencesByJournal.get("a").journal_id, "a");
});

test("preference errors show a retry state without claiming zero samples", async () => {
  const api = setup();
  api.state.selectedJournalId = "a"; api.state.detailRequestToken = 1;
  api.context.RadarData.loadPreference = async () => { throw new Error("404"); };
  vm.runInContext('renderJournalDetail = () => {}', api.context);
  await api.ensureJournalPreference("a");
  assert.equal(api.state.preferenceStatus.get("a"), "error");
  assert.equal(api.state.preferencesByJournal.has("a"), false);
  api.state.preferenceStatus.delete("a");
  api.context.RadarData.loadPreference = async () => ({ journal_id: "a" });
  await api.ensureJournalPreference("a");
  assert.equal(api.state.preferencesByJournal.get("a").journal_id, "a");
});

test("real directory language names display in Chinese and remain searchable in either UI language", () => {
  const api = setup();
  api.state.journals = [
    { ...journals[1], languages: ["Chinese"] },
    { ...journals[0], languages: ["English"] },
  ];
  assert.equal(api.languageLabel("Chinese"), "中文");
  assert.equal(api.languageLabel("English"), "英语");
  api.buildSearchIndex(); api.refreshFilters();
  assert.ok(api.els.journalLanguage.options.some((option) => option.value === "Chinese" && option.textContent === "中文"));
  api.els.journalLanguage.value = "Chinese";
  assert.deepEqual(Array.from(api.filteredJournals(), (journal) => journal.id), ["journal-cn"]);
  api.els.journalLanguage.value = "all";
  api.state.language = "en"; api.buildSearchIndex();
  for (const query of ["中文", "汉语", "Chinese", "zh"]) {
    api.els.search.value = query;
    assert.equal(api.filteredJournals()[0].id, "journal-cn", query);
  }
  for (const query of ["英文", "英语", "English"]) {
    api.els.search.value = query;
    assert.equal(api.filteredJournals()[0].id, "journal-old", query);
  }
});

test("evidence coverage excludes failed pages and catalog/API records, and article totals follow the current filter", () => {
  const api = setup();
  const rows = [
    { ...journals[1], id: "failed", source_pages_crawled: 4, article_count_crawled: 0 },
    { ...journals[1], id: "website", source_pages_crawled: 1, article_count_crawled: 0 },
    { ...journals[1], id: "catalog", source_pages_crawled: 2, article_count_crawled: 0 },
    { ...journals[1], id: "articles", source_pages_crawled: 0, article_count_crawled: 7 },
  ];
  api.state.journals = rows;
  api.state.report = { articles: { ok: 999, total: 999 } };
  api.state.sourcesByJournal = new Map([
    ["failed", [{ status: "failed", source_type: "journal_page" }, { status: "content_too_short", source_type: "author_guidelines" }]],
    ["website", [{ status: "ok", source_type: "journal_page" }]],
    ["catalog", [{ status: "ok", source_type: "journal_catalog" }, { status: "ok", source_type: "article_metadata_api" }]],
  ]);
  assert.equal(api.websiteEvidenceCount(rows[0]), 0);
  assert.equal(api.websiteEvidenceCount(rows[1]), 1);
  assert.equal(api.websiteEvidenceCount(rows[2]), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(api.evidenceSummary(rows))), { journalCount: 2, articleCount: 7 });
  api.renderKpis(rows);
  assert.match(api.els.kpis.innerHTML, /2\/4/);
  assert.match(api.els.kpis.innerHTML, /已抓取 7 篇/);
  assert.ok(!api.els.kpis.innerHTML.includes("999"));
  api.renderKpis([rows[0], rows[2]]);
  assert.match(api.els.kpis.innerHTML, /0\/2/);
  assert.match(api.els.kpis.innerHTML, /已抓取 0 篇/);
  api.renderTable([rows[0]]);
  assert.match(api.els.tableBody.innerHTML, /未覆盖/);
});

test("network cache invalidates when filtered totals change despite identical visible journal IDs", () => {
  const api = setup();
  const rows = Array.from({ length: 30 }, (_, index) => ({ ...journals[1], id: `journal-${index}` }));
  api.state.journals = rows;
  api.els.catalog.value = "doaj";
  api.renderNetwork(rows);
  const firstKey = api.state.networkRenderKey;
  assert.match(api.els.networkNote.textContent, /0 \/ 30/);
  // Force the DOM-presence side of the cache guard to be true; this is the case
  // for a rendered graph even though the first 20 IDs have not changed.
  api.els.network.append(new Element());
  api.renderNetwork(rows.slice(0, 25));
  assert.notEqual(api.state.networkRenderKey, firstKey);
  assert.match(api.els.networkNote.textContent, /0 \/ 25/);
});
