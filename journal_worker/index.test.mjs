import test from "node:test";
import assert from "node:assert/strict";

import worker, { expandQueryTerms, rankJournals, journalSeekingIntent, fallbackJournals, displaySources, sourcePayload, loadRadarData } from "./index.mjs";

const journals = [
  {
    id: "eait",
    name: "Education and Information Technologies",
    abbreviation: "EAIT",
    quartile: "Q1",
    jci_2025: 1.8,
    main_tag: "教育技术",
    publications: { "2022": 676, "2023": 829, "2024": 822, "2025": 604 },
    topic_hits: { "Generative AI": 24, "Educational technology": 3 },
  },
  {
    id: "ijethe",
    name: "International Journal of Educational Technology in Higher Education",
    abbreviation: "IJETHE",
    quartile: "Q1",
    jci_2025: 3.9,
    main_tag: "教育技术",
    topic_hits: { "Higher education": 20 },
  },
  {
    id: "tte",
    name: "Teaching and Teacher Education",
    abbreviation: "TTE",
    quartile: "Q1",
    jci_2025: 2.4,
    main_tag: "教师教育与教师发展",
    topic_hits: { "Teacher education": 30 },
  },
];

function data() {
  return { journals, sourcesByJournal: new Map() };
}

test("mixed English and Chinese query extracts the journal abbreviation", () => {
  assert.ok(expandQueryTerms("EAIT每年发文量多少").includes("eait"));
  const ranked = rankJournals("EAIT每年发文量多少", data());
  assert.equal(ranked[0].journal.id, "eait");
  assert.equal(ranked[0].directMatch, true);
});

test("topic query searches the full journal set", () => {
  const ranked = rankJournals("教师教育有什么期刊", data());
  assert.equal(ranked[0].journal.id, "tte");
});

test("unrelated queries do not fall back to default high-JCI journals", () => {
  assert.deepEqual(rankJournals("今天天气怎么样", data()), []);
});

test("edtech shorthand matches educational technology journals", () => {
  const ranked = rankJournals("edtech顶刊有哪些", data());
  assert.ok(ranked.length >= 2);
  assert.ok(ranked.every((item) => item.journal.main_tag === "教育技术"));
});

test("journal-seeking intent is detected for fallback, chit-chat is not", () => {
  assert.equal(journalSeekingIntent("有哪些值得投稿的期刊"), true);
  assert.equal(journalSeekingIntent("edtech顶刊有哪些"), true);
  assert.equal(journalSeekingIntent("今天天气怎么样"), false);
});

test("fallback ranks by JIF and keeps journal shape", () => {
  const withJif = {
    journals: journals.map((journal, index) => ({ ...journal, jif_2025: index + 1 })),
    sourcesByJournal: new Map(),
  };
  const fallback = fallbackJournals(withJif);
  assert.equal(fallback[0].journal.id, "tte");
  assert.equal(fallback[0].directMatch, false);
});

test("displaySources drops raw API endpoints and falls back to the homepage", () => {
  const sources = [
    { source_type: "article_metadata_api", url: "https://api.crossref.org/journals/1234-5678/works?filter=x" },
  ];
  const journal = { source_urls: ["https://api.crossref.org/journals/1234-5678/works", "https://www.springer.com/journal/123"] };
  const shown = displaySources(sources, journal);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].source_type, "journal_homepage");
  assert.equal(shown[0].source_url, "https://www.springer.com/journal/123");

  const readable = displaySources(
    [
      { source_type: "author_guidelines", url: "https://www.springer.com/journal/123/submission-guidelines" },
      { source_type: "article_metadata_api", url: "https://api.crossref.org/journals/1234-5678/works" },
    ],
    journal
  );
  assert.equal(readable.length, 1);
  assert.equal(readable[0].source_type, "author_guidelines");
});

function expandedData() {
  return {
    journals: [
      ...journals.map((journal) => ({ ...journal, languages: ["en"], has_jcr_record: true })),
      { id: "cn-short", name: "教育研究", aliases: ["教育探索别名"], issn: "1234-5678", issns: ["9876-543X"], languages: ["zh"], country: "China", quartile: null, has_jcr_record: false, jif_2025: null, jci_2025: null, main_tag: "教育技术", catalog_sources: [{ id: "doaj", label: "DOAJ", url: "https://doaj.org/toc/example", retrieved_at: "2026-09-29" }] },
      { id: "english-doaj", name: "Open Learning Research", languages: ["en"], quartile: null, has_jcr_record: false, main_tag: "教育技术", catalog_sources: [{ id: "doaj", label: "DOAJ" }] },
      { id: "cn-q2", name: "中文教师教育", languages: ["zh-Hans"], quartile: "Q2", has_jcr_record: true, jif_2025: 1, main_tag: "教师教育与教师发展", catalog_sources: [{ id: "doaj", label: "DOAJ" }] },
    ],
    sourcesByJournal: new Map(),
  };
}

test("four-character Chinese titles, aliases and all ISSNs are direct matches", () => {
  for (const query of ["教育研究每年发文量多少", "教育探索别名的信息", "12345678 的期刊", "9876-543X"]) {
    const ranked = rankJournals(query, expandedData());
    assert.equal(ranked[0]?.journal.id, "cn-short", query);
    assert.equal(ranked[0]?.directMatch, true);
  }
});

test("historical ISSNs identify the current journal without becoming current ISSNs", () => {
  const current = { id: "journal-issn-19847238", name: "Revista Linhas", issns: ["1984-7238"], historical_issns: ["1518-367X"], languages: ["Portuguese"], quartile: null };
  const data = { journals: [...journals, current], sourcesByJournal: new Map() };
  for (const query of ["1518-367X", "1518367x 的期刊"]) {
    const match = rankJournals(query, data)[0];
    assert.equal(match?.journal.id, current.id, query);
    assert.equal(match.directMatch, true);
    assert.deepEqual(match.journal.issns, ["1984-7238"]);
  }
});

test("Chinese language, directory and JCR-unverified constraints survive fallback", () => {
  const data = expandedData();
  const question = "推荐中文 DOAJ 非JCR期刊";
  assert.deepEqual(rankJournals(question, data).map((item) => item.journal.id), ["cn-short"]);
  assert.deepEqual(fallbackJournals(data, question).map((item) => item.journal.id), ["cn-short"]);
  assert.ok(fallbackJournals(data, "Chinese journals Q2 DOAJ").every((item) => item.journal.id === "cn-q2"));
  assert.equal(fallbackJournals(data, "中文 Q1 期刊").length, 0);
  assert.equal(fallbackJournals(data, "中文Q1期刊").length, 0);
  assert.deepEqual(fallbackJournals(data, "中文Q2期刊").map((item) => item.journal.id), ["cn-q2"]);
  assert.equal(fallbackJournals(data, "ERIC journals").length, 0);
  assert.ok(fallbackJournals(data, "JCR期刊有哪些").every((item) => item.journal.has_jcr_record));
});

test("quartile requests filter rather than merely boost mismatching journals", () => {
  const data = expandedData();
  const ranked = rankJournals("教师教育 Q2 期刊", data);
  assert.deepEqual(ranked.map((item) => item.journal.id), ["cn-q2"]);
  assert.ok(fallbackJournals(data, "Q1 English journals").every((item) => item.journal.quartile === "Q1"));
});

test("catalog-only journals cite their actual directory and do not acquire a workbook citation", () => {
  const journal = expandedData().journals.find((item) => item.id === "cn-short");
  const sources = sourcePayload({ journal, sources: [] });
  assert.equal(sources[0].source_type, "catalog_source");
  assert.equal(sources[0].source_url, "https://doaj.org/toc/example");
  assert.equal(sources[0].captured_at, "2026-09-29");
  assert.ok(sources.every((source) => source.source_type !== "jcr_workbook"));
  const original = sourcePayload({ journal: { ...journal, has_jcr_record: true }, sources: [] });
  assert.ok(original.some((source) => source.source_type === "jcr_workbook"));
});

test("tail journal beyond 3000 remains searchable and fallback context stays at eight", () => {
  const data = expandedData();
  const last = { ...data.journals.find((journal) => journal.id === "cn-short"), id: "tail", name: "边疆教育", aliases: [], issn: "7777-8888", issns: [] };
  data.journals = [...Array.from({ length: 3100 }, (_, index) => ({ id: `other-${index}`, name: `Unrelated Journal ${index}`, languages: ["en"] })), last];
  assert.equal(rankJournals("边疆教育发文情况", data)[0].journal.id, "tail");
  assert.equal(fallbackJournals(data).length, 8);
  assert.ok(Number.isFinite(rankJournals("7777-8888", data)[0].score));
});

function radarFetch(state, requests) {
  return async (input, options = {}) => {
    // Match workerd validation; Node fetch silently accepts this invalid mix.
    if (options.cache === "no-store" && options.cf?.cacheTtl !== undefined) throw new TypeError("CacheTtl is not compatible with cache: no-store");
    const url = new URL(String(input));
    requests.push({ url: url.href, options });
    const selected = state[url.hostname];
    assert.ok(selected, `Unexpected host ${url.hostname}; no real network calls allowed`);
    let body;
    if (url.pathname.endsWith("data-manifest.json")) body = { data_version: selected.version, journal_count: selected.journals.length };
    else if (url.pathname.endsWith("journals.json")) body = selected.journals;
    else if (url.pathname.endsWith("journal_sources.json")) body = [];
    else if (url.pathname.endsWith("crawl_report.json")) body = {};
    else assert.fail(`Unexpected dataset ${url.pathname}`);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
}

test("cache is isolated by PUBLIC_DATA_BASE and reloads immediately on manifest version change", async (t) => {
  const state = {
    "cache-a.example": { version: "v1", journals: [{ id: "a", name: "A" }] },
    "cache-b.example": { version: "v1", journals: [{ id: "b", name: "B" }] },
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", radarFetch(state, requests));
  const envA = { PUBLIC_DATA_BASE: "https://cache-a.example/radar" };
  const envB = { PUBLIC_DATA_BASE: "https://cache-b.example/radar" };
  const first = await loadRadarData(envA);
  assert.equal(first.journals[0].id, "a");
  assert.equal((await loadRadarData(envB)).journals[0].id, "b");
  const again = await loadRadarData(envA);
  assert.equal(first, again);
  assert.equal(requests.filter(({ url }) => url.includes("cache-a.example/radar/journals.json")).length, 1);
  state["cache-a.example"] = { version: "v2", journals: [{ id: "a" }, { id: "new" }] };
  const changed = await loadRadarData(envA);
  assert.equal(changed.dataVersion, "v2");
  assert.equal(changed.journals.length, 2);
  assert.ok(requests.some(({ url }) => url.endsWith("journals.json?v=v2")));
  assert.ok(requests.filter(({ url }) => url.includes("data-manifest")).every(({ options }) => options.cache === "no-store" && options.cf === undefined));
  assert.ok(requests.filter(({ url }) => !url.includes("data-manifest")).every(({ options }) => options.cf.cacheTtl === 600));
  assert.ok(requests.every(({ url }) => !/preferences|articles|rag_documents/.test(url)));
});

test("concurrent loads share dataset fetches and mismatched manifests never populate the cache", async (t) => {
  const state = { "concurrent.example": { version: "v1", journals: [{ id: "a" }] } };
  const requests = [];
  const fetcher = radarFetch(state, requests);
  let wrongCount = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetcher(url, options);
    if (wrongCount && String(url).includes("data-manifest")) return new Response(JSON.stringify({ data_version: "v2", journal_count: 999 }));
    return response;
  });
  const env = { PUBLIC_DATA_BASE: "https://concurrent.example/radar" };
  const [first, second] = await Promise.all([loadRadarData(env), loadRadarData(env)]);
  assert.equal(first, second);
  assert.equal(requests.filter(({ url }) => url.includes("/journals.json")).length, 1);
  wrongCount = true;
  await assert.rejects(loadRadarData(env), /manifest count mismatch/);
  wrongCount = false;
  state["concurrent.example"].version = "v2";
  assert.equal((await loadRadarData(env)).dataVersion, "v2");
});

test("health reports the loaded expanded dataset count and version without an AI call", async (t) => {
  const state = { "health.example": { version: "expanded-v1", journals: Array.from({ length: 3101 }, (_, id) => ({ id: String(id) })) } };
  const requests = [];
  t.mock.method(globalThis, "fetch", radarFetch(state, requests));
  const response = await worker.fetch(new Request("https://worker.example/api/health"), { PUBLIC_DATA_BASE: "https://health.example/radar", AIED_JOURNAL_RADAR_KV: { get: async () => null } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.journal_count, 3101);
  assert.equal(payload.indexed_journal_count, 3101);
  assert.equal(payload.data_version, "expanded-v1");
  assert.equal(payload.llm_configured, false);
  assert.ok(requests.every(({ url }) => !url.includes("chat/completions")));
});

for (const [label, configuredModel, expectedModel, thinkingDisabled] of [
  ["default Qwen3.5", undefined, "Qwen/Qwen3.5-35B-A3B", true],
  ["configured Qwen3", "Qwen/Qwen3.8-27B", "Qwen/Qwen3.8-27B", true],
  ["other model", "Qwen/Qwen2.5-72B-Instruct", "Qwen/Qwen2.5-72B-Instruct", false],
]) {
  test(`chat payload uses the selected model and scoped thinking flags: ${label}`, async (t) => {
    const state = { "chat-payload.example": { version: "chat-v1", journals } };
    const upstream = [];
    const fetchData = radarFetch(state, []);
    const answer = "EAIT：可依据期刊官网核验投稿要求。";
    t.mock.method(globalThis, "fetch", async (input, options) => {
      const url = new URL(String(input));
      if (url.hostname === "api-inference.modelscope.cn" && url.pathname === "/v1/chat/completions") {
        assert.equal(options.method, "POST");
        upstream.push(JSON.parse(options.body));
        return Response.json({ choices: [{ message: { content: answer, reasoning_content: "not returned to the user" } }] });
      }
      return fetchData(input, options);
    });
    const quota = new Map();
    const env = {
      MODELSCOPE_API_KEY: "mock-token-no-network",
      PUBLIC_DATA_BASE: "https://chat-payload.example/radar",
      ...(configuredModel ? { MODELSCOPE_MODEL: configuredModel } : {}),
      AIED_JOURNAL_RADAR_KV: { get: async (key) => quota.get(key) ?? null, put: async (key, value) => quota.set(key, value) },
    };
    const response = await worker.fetch(new Request("https://worker.example/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", "X-AIED-Client": "payload-test" },
      body: JSON.stringify({ question: "EAIT投稿要求" }),
    }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.answer, answer);
    assert.equal(result.model, expectedModel);
    assert.equal(result.searched_journal_count, journals.length);
    assert.equal(result.stores_chat_history, false);
    assert.equal(upstream.length, 1);
    const sent = upstream[0];
    assert.equal(sent.model, expectedModel);
    assert.equal(sent.stream, false);
    assert.equal(sent.max_tokens, 1100);
    assert.match(sent.messages[1].content, /Education and Information Technologies/);
    if (thinkingDisabled) {
      assert.equal(sent.enable_thinking, false);
      assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false });
    } else {
      assert.equal(Object.hasOwn(sent, "enable_thinking"), false);
      assert.equal(Object.hasOwn(sent, "chat_template_kwargs"), false);
    }
    assert.equal(quota.get("ajr:quota:total"), "1");
    assert.ok(result.sources.some((source) => source.journal_name === journals[0].name));
  });
}

test("public JSON GETs retry one transport failure during fetch or body streaming", async (t) => {
  const state = { "transport-retry.example": { version: "v1", journals: [{ id: "recovered" }] } };
  const requests = [];
  const fetcher = radarFetch(state, requests);
  const attempts = new Map();
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const path = new URL(String(input)).pathname;
    attempts.set(path, (attempts.get(path) || 0) + 1);
    if (attempts.get(path) === 1 && path.endsWith("data-manifest.json")) throw new Error("Network connection lost.");
    if (attempts.get(path) === 1 && path.endsWith("journals.json")) return { ok: true, json: async () => { throw new Error("Network connection lost."); } };
    return fetcher(input, options);
  });
  const result = await loadRadarData({ PUBLIC_DATA_BASE: "https://transport-retry.example/radar" });
  assert.equal(result.journals[0].id, "recovered");
  assert.equal(attempts.get("/radar/journals.json"), 2);
  assert.equal(attempts.get("/radar/data-manifest.json"), 3); // failed + retry + version recheck
  assert.ok(requests.every(({ url }) => !url.includes("chat/completions")));
});

test("public JSON transport retry is bounded and HTTP or invalid JSON failures are not retried", async (t) => {
  for (const [label, failure, expectedCalls] of [
    ["persistent-transport", () => { throw new Error("Network connection lost."); }, 2],
    ["http-error", () => new Response("unavailable", { status: 503 }), 1],
    ["invalid-json", () => new Response("not JSON", { status: 200 }), 1],
  ]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => { calls += 1; return failure(); });
    await assert.rejects(loadRadarData({ PUBLIC_DATA_BASE: `https://${label}.example/radar` }));
    assert.equal(calls, expectedCalls, label);
    mock.mock.restore();
  }
});

test("real EBSCO and NCPSSD catalog IDs honor English and Chinese source aliases", () => {
  const data = expandedData();
  data.journals.push(
    { id: "ebsco-real", name: "Education Source Review", main_tag: "Education", languages: ["English"], quartile: null, has_jcr_record: false, catalog_sources: [{ id: "ebsco_education", label: "EBSCO Education Source · Education" }] },
    { id: "ncpssd-real", name: "三明高等专科学校学报", main_tag: "Education", languages: ["Chinese"], quartile: null, has_jcr_record: false, catalog_sources: [{ id: "ncpssd", label: "国家哲学社会科学文献中心 · 教育学" }] },
  );
  for (const alias of ["EBSCO", "EBSCO Education Source", "ebsco_education"]) {
    const question = `推荐${alias}期刊`;
    assert.deepEqual(fallbackJournals(data, question).map((item) => item.journal.id), ["ebsco-real"], alias);
    assert.ok(rankJournals(question, data).every((item) => item.journal.id === "ebsco-real"), alias);
  }
  for (const alias of ["NCPSSD", "国家哲学社会科学文献中心", "国家哲社中心", "国家哲社文献中心", "哲社中心"]) {
    const question = `推荐${alias}的中文期刊`;
    assert.deepEqual(fallbackJournals(data, question).map((item) => item.journal.id), ["ncpssd-real"], alias);
    assert.ok(rankJournals(question, data).every((item) => item.journal.id === "ncpssd-real"), alias);
  }
});
