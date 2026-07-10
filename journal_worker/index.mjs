const DEFAULT_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507";
const DEFAULT_BASE_URL = "https://api-inference.modelscope.cn/v1";
const DEFAULT_DATA_BASE = "https://jojo-edtech.github.io/aied-journal/data/radar";
const KEY_PREFIX = "ajr:";
const DATA_TTL_MS = 10 * 60 * 1000;
const MAX_CONTEXT_JOURNALS = 8;

let dataCache = null;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return health(request, env);
      if (request.method === "GET" && url.pathname === "/api/sources") return sources(request, env);
      if (request.method === "POST" && url.pathname === "/api/chat") return chat(request, env);
      return json(request, env, { error: "not_found" }, 404);
    } catch (error) {
      return json(
        request,
        env,
        {
          error: "worker_error",
          message: "AI 助手暂时不可用，请稍后再试。",
        },
        500
      );
    }
  },
};

async function health(request, env) {
  const data = await loadRadarData(env);
  const usage = await readUsage(env, request);
  const paused = await providerPaused(env);
  return json(request, env, {
    ok: data.journals.length > 0,
    documents: data.journals.length,
    journal_count: data.journals.length,
    retrieval_scope: "full_journal_database",
    network_nodes: 0,
    network_links: 0,
    llm_provider: "modelscope",
    llm_model: modelName(env),
    llm_configured: Boolean(env.MODELSCOPE_API_KEY),
    modelscope_configured: Boolean(env.MODELSCOPE_API_KEY),
    deepseek_configured: false,
    provider_quota_exhausted: Boolean(paused),
    provider_quota_reason: paused || "",
    access_required: false,
    access_mode: "public_limited",
    access_code_configured: false,
    daily_limit: usage.limits.globalDay,
    total_limit: usage.limits.total,
    remaining_quota: usage.remainingGlobalDay,
    remaining_total_quota: usage.remainingTotal,
    user_daily_limit: usage.limits.userDay,
    user_hourly_limit: usage.limits.userHour,
    remaining_user_quota: usage.remainingUserDay,
    remaining_user_hour_quota: usage.remainingUserHour,
    privacy_mode: "stateless_no_chat_history",
    stores_chat_history: false,
  });
}

async function sources(request, env) {
  const data = await loadRadarData(env);
  return json(request, env, {
    journal_count: data.journals.length,
    report: data.report,
    top_journals: data.journals.slice(0, 12),
    privacy_mode: "stateless_no_chat_history",
  });
}

async function chat(request, env) {
  if (!env.MODELSCOPE_API_KEY) {
    return json(request, env, { error: "missing_key", detail: "服务器尚未配置 ModelScope token。" }, 503);
  }
  const paused = await providerPaused(env);
  if (paused) {
    return json(request, env, { error: "provider_quota_exhausted", detail: "ModelScope 免费额度保护已触发，AI 助手今日暂停调用。" }, 429);
  }

  const payload = await readJson(request);
  const question = String(payload.question || "").trim();
  if (!question) return json(request, env, { error: "empty_question", detail: "请先输入论文主题或选刊问题。" }, 400);
  if (question.length > 1200) return json(request, env, { error: "question_too_long", detail: "问题太长，请控制在 1200 字以内。" }, 400);

  const usage = await ensureQuota(env, request);
  if (!usage.ok) return json(request, env, { error: "usage_limit_reached", detail: usage.message }, 429);

  const data = await loadRadarData(env);
  const allRanked = rankJournals(question, data);
  const ranked = allRanked.slice(0, MAX_CONTEXT_JOURNALS);
  if (!ranked.length) {
    return json(request, env, {
      answer: "当前雷达资料不足。请补充研究主题、方法、学段、研究对象或目标期刊类型。",
      sources: [],
      remaining_quota: usage.remainingGlobalDay,
      remaining_total_quota: usage.remainingTotal,
      remaining_user_quota: usage.remainingUserDay,
      remaining_user_hour_quota: usage.remainingUserHour,
      privacy_mode: "stateless_no_chat_history",
      stores_chat_history: false,
      retrieval_scope: "full_journal_database",
      searched_journal_count: data.journals.length,
      matched_journal_count: 0,
    });
  }

  const result = await callModelScope(env, question, ranked, data.journals.length);
  if (!result.ok) {
    if (result.quotaStopped) await pauseProvider(env, result.message);
    return json(request, env, { error: result.error, detail: result.message }, result.status || 502);
  }

  const after = await recordSuccessfulUse(env, request);
  return json(request, env, {
    answer: result.answer,
    sources: ranked.flatMap((item) => sourcePayload(item)).slice(0, 12),
    remaining_quota: after.remainingGlobalDay,
    remaining_total_quota: after.remainingTotal,
    remaining_user_quota: after.remainingUserDay,
    remaining_user_hour_quota: after.remainingUserHour,
    provider: "modelscope",
    model: modelName(env),
    retrieval_scope: "full_journal_database",
    searched_journal_count: data.journals.length,
    matched_journal_count: allRanked.length,
    privacy_mode: "stateless_no_chat_history",
    stores_chat_history: false,
  });
}

async function callModelScope(env, question, ranked, searchedJournalCount) {
  const context = ranked
    .map(({ journal, sources }, index) => {
      const topicHints = [
        journal.main_tag,
        journal.secondary_tag,
        journal.tag_path,
        Object.keys(journal.topic_hits || {}).slice(0, 8).join(", "),
        Object.keys(journal.method_hits || {}).slice(0, 5).join(", "),
      ]
        .filter(Boolean)
        .join("; ");
      const publications = journal.publications || {};
      const publicationSeries = ["2022", "2023", "2024", "2025"]
        .map((year) => `${year}: ${publications[year] ?? "unknown"}`)
        .join("; ");
      const sourceLines = orderedSources(sources)
        .slice(0, 3)
        .map((source) => `${source.source_type || "source"}: ${source.source_url || source.url || ""}`)
        .join(" | ");
      return [
        `${index + 1}. ${journal.name} (${journal.abbreviation || "no abbreviation"})`,
        `JCR: ${journal.quartile || "unknown"}; JIF: ${journal.jif_2025 ?? "unknown"}; JCI: ${journal.jci_2025 ?? "unknown"}`,
        `Annual publication volume from the radar workbook: ${publicationSeries}`,
        `Publisher: ${journal.publisher_family || journal.publisher || "unknown"}; first decision: ${journal.first_decision_days ?? "pending"} days; review time: ${journal.review_time_days ?? "pending"} days`,
        `Themes: ${topicHints || "pending"}`,
        `Submission clue: ${journal.word_limit || "pending official verification"}`,
        `Sources: ${sourceLines || "pending official verification"}`,
      ].join("\n");
    })
    .join("\n\n");

  const system = `You are AIED Journal Radar, an evidence-backed education JCR journal-selection advisor.
The retrieval stage scanned the complete database of ${searchedJournalCount} journals. It did not use the frontend shortlist or current dashboard filters.
Use only the retrieved radar context below. Do not invent journal requirements. If evidence is insufficient, say 当前雷达资料不足.
Annual publication volumes labelled as coming from the radar workbook are recorded workbook values, not forecasts. Do not call them predicted values.
Answer in the user's language. If the user asks a factual question about a named journal, answer that journal directly and do not force a recommendation table.
For journal-selection questions, recommend 3-6 journals in a compact Markdown table, then add 2-3 short caveats.
For each recommended journal include fit, main risk, annual publication volume, review speed if available, and what needs official verification.
Avoid long introductions, star ratings, or generic praise.
This is a stateless request. Do not refer to previous chat history.`;

  const response = await fetch(`${apiBase(env)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MODELSCOPE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName(env),
      messages: [
        { role: "system", content: system },
        { role: "user", content: `User question:\n${question}\n\nRadar context:\n${context}` },
      ],
      temperature: 0.2,
      max_tokens: readInt(env.MODELSCOPE_MAX_TOKENS, 1100),
      stream: false,
    }),
  });

  const text = await response.text();
  const data = safeJson(text, {});
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text.slice(0, 500) || `ModelScope HTTP ${response.status}`;
    const quotaStopped = response.status === 402 || response.status === 429 || /quota|free tier|balance|额度|余额|限流/i.test(message);
    return {
      ok: false,
      quotaStopped,
      status: quotaStopped ? 429 : response.status,
      error: quotaStopped ? "modelscope_quota_exhausted" : "modelscope_error",
      message: quotaStopped ? "ModelScope 免费额度或限流保护已触发，AI 助手今日暂停继续调用。" : message,
    };
  }
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const answer = String(choice?.message?.content || choice?.text || "").trim();
  if (!answer) return { ok: false, status: 502, error: "empty_model_response", message: "ModelScope 返回为空，请稍后重试。" };
  return { ok: true, answer };
}

function rankJournals(question, data) {
  const queryTerms = expandQueryTerms(question);
  const sourceMap = data.sourcesByJournal;
  const normalizedQuestion = normalizeLookupText(question);
  const latinQuestionTokens = new Set((question.toLowerCase().match(/[a-z0-9]+(?:[-.&+][a-z0-9]+)*/g) || []).map(normalizeLookupText));
  return data.journals
    .map((journal) => {
      const articlePreferences = journal.article_preferences || {};
      const pieces = {
        name: [journal.name, journal.abbreviation].join(" "),
        tags: [journal.main_tag, journal.secondary_tag, journal.tag_path].join(" "),
        topics: [
          Object.keys(journal.topic_hits || {}).join(" "),
          Object.keys(journal.method_hits || {}).join(" "),
          Object.keys(articlePreferences.topic_counts || {}).join(" "),
          Object.keys(articlePreferences.method_counts || {}).join(" "),
        ].join(" "),
        publisher: [journal.publisher, journal.publisher_family, journal.submission_system].join(" "),
        requirements: String(journal.word_limit || ""),
        identifiers: [journal.issn, journal.eissn].join(" "),
      };
      const lower = Object.fromEntries(Object.entries(pieces).map(([key, value]) => [key, String(value).toLowerCase()]));
      const directScore = directJournalMatchScore(journal, question, normalizedQuestion, latinQuestionTokens);
      let relevanceScore = directScore;
      queryTerms.forEach((term) => {
        if (lower.name.includes(term)) relevanceScore += 10;
        if (lower.tags.includes(term)) relevanceScore += 8;
        if (lower.topics.includes(term)) relevanceScore += 9;
        if (lower.requirements.includes(term)) relevanceScore += 3;
        if (lower.publisher.includes(term)) relevanceScore += 2;
        if (lower.identifiers.includes(term)) relevanceScore += 20;
      });
      if (relevanceScore <= 0) return null;

      let score = relevanceScore;
      if (/q1|一区|top|高影响/i.test(question) && journal.quartile === "Q1") score += 8;
      if (/q2|二区/i.test(question) && journal.quartile === "Q2") score += 8;
      if (/稳妥|safer|保底|容易|快/i.test(question) && Number(journal.first_decision_days || 999) <= 30) score += 4;
      score += journal.quartile === "Q1" ? 2.5 : journal.quartile === "Q2" ? 1.4 : 0;
      score += Math.min(2.5, Number(journal.jci_2025 || 0));
      const sources = sourceMap.get(journal.id) || [];
      if (sources.length) score += 0.8;
      return { journal, sources, score, relevanceScore, directMatch: directScore > 0 };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.directMatch) - Number(a.directMatch) || b.score - a.score);
}

function expandQueryTerms(question) {
  const lower = question.toLowerCase();
  const terms = new Set((lower.match(/[a-z0-9]+(?:[-.&+][a-z0-9]+)*/g) || []).filter((term) => term.length >= 2));
  const chinesePhrases = [
    "教师教育", "教师发展", "教育技术", "高等教育", "语言教育", "语言学习", "教育政策",
    "学习分析", "生成式人工智能", "人工智能", "混合方法", "教育心理", "课程教学", "科学教育", "数学教育",
  ];
  chinesePhrases.forEach((phrase) => {
    if (lower.includes(phrase)) terms.add(phrase);
  });
  const synonyms = [
    [/教师|teacher/, ["teacher", "teacher education", "teacher development", "teacher feedback"]],
    [/反馈|feedback/, ["feedback", "teacher feedback", "formative feedback"]],
    [/高等|大学|higher/, ["higher education", "university", "college"]],
    [/语言|英语|language|english/, ["language learning", "language teaching", "english", "second language"]],
    [/生成式|generative|genai|大模型|llm/, ["generative ai", "genai", "large language models", "ai literacy"]],
    [/学习分析|analytics/, ["learning analytics", "educational data mining"]],
    [/政策|治理|policy/, ["policy", "governance", "equity and policy"]],
    [/教师发展|professional development/, ["teacher development", "professional development"]],
    [/数学|math/, ["mathematics education", "stem education"]],
    [/评估|assessment/, ["assessment", "evaluation"]],
    [/心理|motivation|wellbeing|well-being/, ["educational psychology", "motivation and wellbeing"]],
    [/混合方法|mixed/, ["mixed methods"]],
    [/实验|experiment/, ["experiment", "quasi-experiment"]],
  ];
  synonyms.forEach(([pattern, values]) => {
    if (pattern.test(lower)) values.forEach((value) => terms.add(value));
  });
  return [...terms].map((term) => term.toLowerCase());
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function directJournalMatchScore(journal, question, normalizedQuestion, latinQuestionTokens) {
  const name = normalizeLookupText(journal.name);
  const abbreviation = normalizeLookupText(journal.abbreviation);
  const rawQuestion = String(question || "").toLowerCase();
  let score = 0;
  if (name.length >= 6 && normalizedQuestion.includes(name)) score += 120;
  if (abbreviation.length >= 2 && latinQuestionTokens.has(abbreviation)) score += 100;
  [journal.issn, journal.eissn].filter(Boolean).forEach((identifier) => {
    if (rawQuestion.includes(String(identifier).toLowerCase())) score += 120;
  });
  return score;
}

function sourcePayload(item) {
  const workbookSource = {
    journal_name: item.journal.name,
    source_url: "",
    source_type: "jcr_workbook",
    captured_at: "",
    text_snippet: "JCR indicators and annual publication volume from the radar workbook",
  };
  const base = item.sources.length
    ? orderedSources(item.sources).slice(0, 2)
    : [{ journal_name: item.journal.name, source_url: (item.journal.source_urls || [])[0] || "", source_type: "journal_homepage" }];
  return [workbookSource, ...base.map((source) => ({
    journal_name: item.journal.name,
    source_url: source.source_url || source.url || "",
    source_type: source.source_type || "source",
    captured_at: source.captured_at || "",
    text_snippet: source.text_snippet || source.status || "",
  }))];
}

function orderedSources(sources) {
  const priority = {
    author_guidelines: 1,
    journal_page: 2,
    journal_metrics: 3,
    editorial_board: 4,
    article_metadata_api: 5,
  };
  const statusRank = (source) => (source.status === "ok" ? 0 : 1);
  return [...(sources || [])].sort((a, b) => {
    const statusDelta = statusRank(a) - statusRank(b);
    if (statusDelta) return statusDelta;
    return (priority[a.source_type] || 99) - (priority[b.source_type] || 99);
  });
}

async function loadRadarData(env) {
  const now = Date.now();
  if (dataCache && now - dataCache.loadedAt < DATA_TTL_MS) return dataCache;
  const base = String(env.PUBLIC_DATA_BASE || DEFAULT_DATA_BASE).replace(/\/+$/, "");
  const [journals, sources, report] = await Promise.all([
    fetchJson(`${base}/journals.json`),
    fetchJson(`${base}/journal_sources.json`),
    fetchJson(`${base}/crawl_report.json`).catch(() => ({})),
  ]);
  const sourcesByJournal = new Map();
  (sources || []).forEach((source) => {
    if (!sourcesByJournal.has(source.journal_id)) sourcesByJournal.set(source.journal_id, []);
    sourcesByJournal.get(source.journal_id).push(source);
  });
  dataCache = { loadedAt: now, journals: journals || [], sources: sources || [], sourcesByJournal, report: report || {} };
  return dataCache;
}

async function fetchJson(url) {
  const response = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!response.ok) throw new Error(`Data fetch failed: ${response.status}`);
  return response.json();
}

async function readUsage(env, request) {
  const today = dayKey();
  const userHash = await userKey(request);
  const limits = {
    userHour: readInt(env.MAX_REQUESTS_PER_USER_HOUR, 5),
    userDay: readInt(env.MAX_REQUESTS_PER_USER_DAY, 20),
    globalDay: readInt(env.MAX_GLOBAL_REQUESTS_PER_DAY, 60),
    total: readInt(env.MODELSCOPE_FREE_TOTAL_CALLS, 1990),
  };
  const [globalDay, total, userDay, userHour] = await Promise.all([
    kvInt(env, `${KEY_PREFIX}quota:global:${today}`),
    kvInt(env, `${KEY_PREFIX}quota:total`),
    kvInt(env, `${KEY_PREFIX}quota:user:${userHash}:${today}`),
    kvInt(env, `${KEY_PREFIX}quota:user-hour:${userHash}:${hourKey()}`),
  ]);
  return {
    limits,
    globalDay,
    total,
    userDay,
    userHour,
    remainingGlobalDay: remaining(limits.globalDay, globalDay),
    remainingTotal: remaining(limits.total, total),
    remainingUserDay: remaining(limits.userDay, userDay),
    remainingUserHour: remaining(limits.userHour, userHour),
  };
}

async function ensureQuota(env, request) {
  const usage = await readUsage(env, request);
  if (usage.limits.total > 0 && usage.total >= usage.limits.total) return { ...usage, ok: false, message: "公开免费总额度已用完，AI 助手已暂停。" };
  if (usage.limits.globalDay > 0 && usage.globalDay >= usage.limits.globalDay) return { ...usage, ok: false, message: "今日公开额度已用完，请明天再试。" };
  if (usage.limits.userDay > 0 && usage.userDay >= usage.limits.userDay) return { ...usage, ok: false, message: "你今天的使用次数已达上限，请明天再试。" };
  if (usage.limits.userHour > 0 && usage.userHour >= usage.limits.userHour) return { ...usage, ok: false, message: "请求稍微有点频繁，请稍后再试。" };
  return { ...usage, ok: true };
}

async function recordSuccessfulUse(env, request) {
  const today = dayKey();
  const userHash = await userKey(request);
  const hour = hourKey();
  await Promise.all([
    kvIncrement(env, `${KEY_PREFIX}quota:global:${today}`, 86400 * 2),
    kvIncrement(env, `${KEY_PREFIX}quota:total`, 60 * 60 * 24 * 365),
    kvIncrement(env, `${KEY_PREFIX}quota:user:${userHash}:${today}`, 86400 * 2),
    kvIncrement(env, `${KEY_PREFIX}quota:user-hour:${userHash}:${hour}`, 60 * 90),
  ]);
  return readUsage(env, request);
}

async function providerPaused(env) {
  return env.AIED_JOURNAL_RADAR_KV.get(`${KEY_PREFIX}provider-paused:${dayKey()}`);
}

async function pauseProvider(env, reason) {
  await env.AIED_JOURNAL_RADAR_KV.put(`${KEY_PREFIX}provider-paused:${dayKey()}`, String(reason || "quota").slice(0, 200), {
    expirationTtl: 86400,
  });
}

async function kvInt(env, key) {
  const value = await env.AIED_JOURNAL_RADAR_KV.get(key);
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function kvIncrement(env, key, ttl) {
  const next = (await kvInt(env, key)) + 1;
  await env.AIED_JOURNAL_RADAR_KV.put(key, String(next), { expirationTtl: ttl });
  return next;
}

async function userKey(request) {
  const client = String(request.headers.get("X-AIED-Client") || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
  const raw = [
    client ? `client:${client}` : "client:missing",
    request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown",
    request.headers.get("User-Agent") || "unknown",
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hourKey() {
  return new Date().toISOString().slice(0, 13);
}

function remaining(limit, used) {
  return limit <= 0 ? -1 : Math.max(0, limit - used);
}

function modelName(env) {
  return env.MODELSCOPE_MODEL || DEFAULT_MODEL;
}

function apiBase(env) {
  return String(env.MODELSCOPE_API_BASE || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "https://jojo-edtech.github.io")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const allowOrigin = allowed.includes(origin.replace(/\/+$/, "")) ? origin : allowed[0] || "https://jojo-edtech.github.io";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-AIED-Client",
    "Vary": "Origin",
  };
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Conversation-Mode": "stateless",
      "X-Chat-History-Stored": "false",
    },
  });
}

export { expandQueryTerms, rankJournals };
