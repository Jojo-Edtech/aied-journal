import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const pageMarkup = await readFile(new URL("../index.html", import.meta.url), "utf8");
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
  click() {}
  scrollIntoView(options) { this.lastScroll = options; }
  querySelectorAll() { return []; }
  querySelector(tag) { return this.childNodes.find((node) => node.tagName === tag) || null; }
  insertAdjacentHTML(position, html) { this._html += html; }
  closest() { return null; }
}
function setup() {
  const elements = new Map();
  const context = vm.createContext({
    localStorage: { getItem: () => "zh" }, Intl, URL, Blob,
    document: {
      querySelector: (key) => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); },
      createElement: (tag) => new Element(tag), createElementNS: (ns, tag) => new Element(tag),
    },
    window: { clearTimeout() {}, setTimeout: () => 0, requestAnimationFrame: (fn) => fn(), location: { hash: "" }, scrollY: 0, scrollTo(options) { this.scrollY = options.top; } },
    RadarData: {},
  });
  vm.runInContext(functionsOnly, context);
  const api = vm.runInContext('({ state, els, quartileKey, quartileLabel, metricLabel, languageLabel, median, buildSearchIndex, filteredJournals, sortedTableJournals, renderTable, renderScatter, renderKpis, renderNetwork, renderRecommendations, downloadVisibleCsv, evidenceSummary, websiteEvidenceCount, sourceListHtml, renderJournalDetail, ensureJournalPreference, latestIssueSignalHtml, rangeMetaText, t, refreshFilters, renderAll, renderFilterSummary, syncResponsiveLayout, resetFilters, setMobileSort, changeTablePage, revealDashboardSection, navigateToJournal, renderRoute })', context);
  api.els.search.value = "";
  return { context, ...api };
}
const journals = [
  { id: "journal-old", name: "Original Journal", quartile: "Q1", jif_2025: 5, jci_2025: 2, main_tag: "教育技术", languages: ["en"], indexes: ["SSCI", "Scopus"], catalog_sources: [{ id: "jcr", label: "JCR workbook" }] },
  { id: "journal-added", name: "Education Inquiry", aliases: ["Educational Inquiry Review"], issn: "1234-5678", issns: ["1234-5678"], quartile: null, jif_2025: null, jci_2025: null, country: "United Kingdom", main_tag: "教育技术", languages: ["English"], indexes: ["Scopus"], catalog_sources: [{ id: "doaj", label: "DOAJ", url: "https://doaj.org", record_id: "entry-added", retrieved_at: "2026-09-29" }] },
  { id: "journal-zero", name: "Zero Journal", quartile: "Q4", jif_2025: 0, jci_2025: 0, main_tag: "教育技术", languages: ["en"], indexes: ["ESCI"], catalog_sources: [{ id: "doaj", label: "DOAJ" }] },
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
      assert.equal(api.sortedTableJournals(api.state.journals).at(-1).id, "journal-added");
    }
  }
});

test("index filters select recorded coverage without inferring it from quartile or directory", () => {
  const api = setup(); load(api); api.refreshFilters();
  assert.deepEqual(Array.from(api.els.index.options, (option) => option.value), ["all", "SSCI", "ESCI", "Scopus"]);
  assert.ok(api.els.quartile.options.some((option) => option.value === "__unknown__"));
  api.els.quartile.value = "__unknown__";
  assert.deepEqual(Array.from(api.filteredJournals(), (j) => j.id), ["journal-added"]);
  api.els.quartile.value = "all";
  for (const [index, ids] of [["SSCI", ["journal-old"]], ["ESCI", ["journal-zero"]], ["Scopus", ["journal-added", "journal-old"]]]) {
    api.els.index.value = index;
    assert.deepEqual(Array.from(api.filteredJournals(), (j) => j.id).sort(), ids);
  }
  api.els.index.value = "all";
  assert.equal(api.filteredJournals().length, 3, "Overlapping SSCI/Scopus coverage must not duplicate a journal");
  api.els.index.value = "Scopus";
  api.els.quartile.value = "Q4";
  assert.equal(api.filteredJournals().length, 0, "Quartile and index are independent intersecting filters");
});

test("names, aliases, ISSNs, country, index and source record identifiers are searchable", () => {
  const api = setup(); load(api);
  for (const query of ["Education Inquiry", "Educational Inquiry Review", "1234-5678", "United Kingdom", "entry-added"]) {
    api.els.search.value = query;
    assert.equal(api.filteredJournals()[0].id, "journal-added", query);
  }
  api.els.search.value = "SSCI";
  assert.deepEqual(Array.from(api.filteredJournals(), (j) => j.id), ["journal-old"]);
  assert.match(api.t("chatIdle"), /3 本/);
});

test("index selection drives KPI counts, cards, table badges and exported rows", async () => {
  const api = setup(); load(api);
  api.els.index.value = "Scopus";
  const selected = api.filteredJournals();
  api.renderKpis(selected);
  assert.match(api.els.kpis.innerHTML, /<strong>2<\/strong>/);
  api.renderRecommendations(selected);
  assert.match(api.els.recommendations.innerHTML, /index-badge">SSCI/);
  assert.match(api.els.recommendations.innerHTML, /index-badge">Scopus/);
  assert.ok(!api.els.recommendations.innerHTML.includes("Zero Journal"));
  api.renderTable(selected);
  assert.equal((api.els.tableBody.innerHTML.match(/<tr>/g) || []).length, 2);
  assert.match(api.els.tableBody.innerHTML, /aria-label="数据库收录"/);
  let download;
  api.context.URL = {
    createObjectURL: (blob) => { download = blob; return "blob:test-download"; },
    revokeObjectURL() {},
  };
  api.downloadVisibleCsv();
  const csv = await download.text();
  assert.match(csv.split("\n")[0], /languages,indexes,country/);
  assert.match(csv, /"SSCI; Scopus"/);
  assert.match(csv, /"Education Inquiry"/);
  assert.ok(!csv.includes("Zero Journal"));
});

test("historical ISSNs are searchable in formatted and compact form", () => {
  const api = setup(); load(api);
  api.state.journals.push({ id: "journal-historical", name: "Historical Education Review", issns: ["1984-7238"], historical_issns: ["1518-367X"], languages: ["English"], indexes: ["ESCI"], quartile: null });
  api.buildSearchIndex();
  for (const query of ["1518-367X", "1518367x", "19847238"]) {
    api.els.search.value = query;
    assert.equal(api.filteredJournals()[0]?.id, "journal-historical", query);
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

test("phone cards paginate the complete index-filtered list without mixing JCR and index coverage", () => {
  const api = setup();
  api.state.journals = Array.from({ length: 47 }, (_, i) => ({ ...journals[1], id: `mobile-${i}`, name: `Scopus journal ${i}` })).concat(journals[2]);
  api.buildSearchIndex();
  api.syncResponsiveLayout(true);
  api.els.index.value = "Scopus";
  api.renderTable(api.filteredJournals());
  assert.equal((api.els.mobileJournalList.innerHTML.match(/class="mobile-journal-card"/g) || []).length, 20);
  assert.match(api.els.mobileJournalList.innerHTML, /index-badge">Scopus/);
  assert.match(api.els.mobileJournalList.innerHTML, /mobile-journal-metrics"><span>JCR 未核验/);
  assert.ok(!api.els.mobileJournalList.innerHTML.includes("Zero Journal"));
  api.changeTablePage(1);
  assert.equal(api.state.tablePage, 1);
  assert.equal(api.els.index.value, "Scopus");
  assert.equal(api.els.journalResults.lastScroll.block, "start");
  api.changeTablePage(1);
  assert.equal((api.els.mobileJournalList.innerHTML.match(/class="mobile-journal-card"/g) || []).length, 7);
  assert.equal(api.els.toggleRows.disabled, true);
  assert.match(api.els.tablePage.textContent, /3 \/ 3/);
});

test("every journal filter is directly available without a disclosure in the shipped page", () => {
  const filterMarkup = pageMarkup.slice(pageMarkup.indexOf('<section class="radar-control-band"'), pageMarkup.indexOf('<section class="radar-card journal-results"'));
  for (const id of ["radarSearch", "radarIndexFilter", "radarTagFilter", "radarQuartileFilter", "radarPublisherFilter", "radarSpeedFilter", "mobileSort"]) {
    assert.match(filterMarkup, new RegExp(`<(?:input|select)[^>]*id="${id}"`), `${id} must remain a native visible filter control`);
  }
  assert.doesNotMatch(filterMarkup, /<(?:details|summary)\b/);
  assert.doesNotMatch(filterMarkup, /filterDisclosure|data-i18n="moreFilters"/);
  const fields = filterMarkup.slice(filterMarkup.indexOf('<div class="advanced-filters"'), filterMarkup.indexOf('<div class="active-filter-summary"'));
  assert.doesNotMatch(fields, /\bhidden\b|aria-hidden="true"/);
});

test("responsive setup retains always-visible filter selections and only folds secondary panels", () => {
  const api = setup(); load(api); api.refreshFilters();
  api.els.index.value = "Scopus";
  api.els.quartile.value = "__unknown__";
  api.syncResponsiveLayout(true);
  assert.equal(api.els.advisorDisclosure.open, false);
  assert.equal(api.els.analyticsDisclosure.open, false);
  assert.equal(api.els.filterDisclosure, undefined, "Filters no longer participate in responsive disclosure logic");
  api.renderFilterSummary();
  assert.equal(api.els.activeFilterSummary.hidden, false);
  assert.match(api.els.activeFilterText.textContent, /Scopus.*JCR 未核验/);
  api.els.advisorDisclosure.open = true;
  api.syncResponsiveLayout(true);
  assert.equal(api.els.advisorDisclosure.open, true);
  assert.deepEqual(Array.from(api.filteredJournals(), (journal) => journal.id), ["journal-added"]);
  api.syncResponsiveLayout(false);
  assert.equal(api.els.advisorDisclosure.open, true);
  assert.equal(api.els.analyticsDisclosure.open, true);
  assert.equal(api.els.index.value, "Scopus");
  assert.equal(api.els.quartile.value, "__unknown__");
  assert.deepEqual(Array.from(api.filteredJournals(), (journal) => journal.id), ["journal-added"]);
  api.resetFilters();
  api.renderFilterSummary();
  assert.equal(api.els.index.value, "all");
  assert.equal(api.els.quartile.value, "all");
  assert.equal(api.els.activeFilterSummary.hidden, true);
});

test("mobile sorting keeps unknown metrics last and resets to the first page", () => {
  const api = setup(); load(api); api.syncResponsiveLayout(true);
  api.state.tablePage = 2;
  api.setMobileSort("jif");
  assert.equal(api.state.tablePage, 0);
  const cardNames = [...api.els.mobileJournalList.innerHTML.matchAll(/data-open-journal="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(cardNames, ["journal-old", "journal-zero", "journal-added"]);
  assert.match(api.els.activeFilterText.textContent, /JIF 从高到低/);
  api.resetFilters();
  assert.equal(api.state.tableSort.key, "");
  assert.equal(api.els.mobileSort.value, "default");
});

test("phone searches defer secondary charts until expanded, while desktop renders the full workbench", () => {
  const api = setup(); load(api);
  api.context.renderCounts = { analytics: 0, recommendations: 0 };
  vm.runInContext("renderAnalytics = () => { renderCounts.analytics += 1; }; renderRecommendations = () => { renderCounts.recommendations += 1; };", api.context);
  api.state.ready = true;
  api.syncResponsiveLayout(true);
  assert.equal(api.context.renderCounts.analytics, 0);
  assert.equal(api.context.renderCounts.recommendations, 0);
  assert.match(api.els.mobileJournalList.innerHTML, /Original Journal/);
  api.els.analyticsDisclosure.open = true;
  api.renderAll();
  assert.equal(api.context.renderCounts.analytics, 1);
  api.syncResponsiveLayout(false);
  assert.equal(api.context.renderCounts.analytics, 2);
  assert.equal(api.context.renderCounts.recommendations, 1);
});

test("mobile anchor navigation reveals hidden sections and detail return retains page, filters and scroll", () => {
  const api = setup();
  api.state.journals = Array.from({ length: 45 }, (_, i) => ({ ...journals[1], id: `journal-${i}` }));
  api.buildSearchIndex(); api.syncResponsiveLayout(true); api.state.ready = true;
  api.els.index.value = "Scopus"; api.state.tablePage = 1;
  api.context.window.scrollY = 935;
  api.navigateToJournal("journal-25");
  api.state.selectedJournalId = "journal-25";
  api.els.dashboard.hidden = true;
  api.context.window.location.hash = "";
  api.context.window.scrollY = 0;
  api.renderRoute();
  assert.equal(api.state.tablePage, 1);
  assert.equal(api.els.index.value, "Scopus");
  assert.equal(api.context.window.scrollY, 935);
  assert.equal(api.els.dashboard.hidden, false);
  assert.equal(api.els.detailPage.hidden, true);
  assert.equal(api.revealDashboardSection("#journalTable"), true);
  assert.equal(api.els.journalResults.lastScroll.block, "start");
  api.revealDashboardSection("#radarChatForm");
  assert.equal(api.els.advisorDisclosure.open, true);
  assert.equal(api.els.chatForm.lastScroll.block, "start");
  vm.runInContext("renderAnalytics = () => {};", api.context);
  api.revealDashboardSection("#tagHeatmap");
  assert.equal(api.els.analyticsDisclosure.open, true);
  assert.equal(api.els.heatmap.lastScroll.block, "start");
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
  assert.match(html, /不证明 SSCI、ESCI 或 Scopus 收录/);
  assert.match(html, /Educational Inquiry Review/);
  assert.match(html, /数据库收录<\/dt><dd>Scopus/);
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

test("index evidence details display dated sources without duplicate category rows or unsafe URLs", () => {
  const api = setup();
  const proof = { index: "SSCI", source: "UEFISCDI published JCR list", snapshot_date: "2026-06", url: "https://example.org/jcr.xlsx", category: "Education" };
  const journal = { ...journals[0], index_evidence: [proof, { ...proof, category: "Psychology" }, { index: "Scopus", source: "Elsevier <source>", snapshot_date: "2026-08", url: "javascript:alert(1)" }] };
  const html = api.sourceListHtml(journal, []);
  assert.match(html, /数据库收录依据/);
  assert.match(html, /来源快照: 2026-06/);
  assert.match(html, /来源快照: 2026-08/);
  assert.equal((html.match(/href="https:\/\/example.org\/jcr.xlsx"/g) || []).length, 1);
  assert.match(html, /并非实时收录保证/);
  assert.match(html, /Elsevier &lt;source&gt;/);
  assert.ok(!html.includes("javascript:"));
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

test("English publication language remains searchable in either interface language without a language filter", () => {
  const api = setup();
  api.state.journals = [{ ...journals[0], languages: ["English"] }];
  assert.equal(api.languageLabel("English"), "英语");
  api.buildSearchIndex(); api.refreshFilters();
  assert.equal(api.els.journalLanguage, undefined);
  assert.equal(api.els.catalog, undefined);
  api.state.language = "en"; api.buildSearchIndex();
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
  api.els.index.value = "Scopus";
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
