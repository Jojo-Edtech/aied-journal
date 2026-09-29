const DEFAULT_MODEL = "Qwen/Qwen3.5-35B-A3B";
const DEFAULT_BASE_URL = "https://api-inference.modelscope.cn/v1";
const DEFAULT_DATA_BASE = "https://jojo-edtech.github.io/aied-journal/data/radar";
const KEY_PREFIX = "ajr:";
const DATA_TTL_MS = 10 * 60 * 1000;
const MAX_CONTEXT_JOURNALS = 8;

const dataCaches = new Map();
const dataLoads = new Map();

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return await health(request, env);
      if (request.method === "GET" && url.pathname === "/api/sources") return await sources(request, env);
      if (request.method === "POST" && url.pathname === "/api/chat") return await chat(request, env);
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
    indexed_journal_count: data.journals.length,
    data_version: data.dataVersion,
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
    indexed_journal_count: data.journals.length,
    data_version: data.dataVersion,
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
  let ranked = allRanked.slice(0, MAX_CONTEXT_JOURNALS);
  let genericFallback = false;
  if (!ranked.length && journalSeekingIntent(question)) {
    ranked = fallbackJournals(data, question);
    genericFallback = true;
  }
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
      data_version: data.dataVersion,
    });
  }

  const result = await callModelScope(env, question, ranked, data.journals.length, { genericFallback });
  if (!result.ok) {
    if (result.quotaStopped) await pauseProvider(env, result.message);
    return json(request, env, { error: result.error, detail: result.message }, result.status || 502);
  }

  const after = await recordSuccessfulUse(env, request);
  return json(request, env, {
    answer: result.answer,
    sources: ranked.flatMap((item) => sourcePayload(item).slice(0, 2)),
    remaining_quota: after.remainingGlobalDay,
    remaining_total_quota: after.remainingTotal,
    remaining_user_quota: after.remainingUserDay,
    remaining_user_hour_quota: after.remainingUserHour,
    provider: "modelscope",
    model: modelName(env),
    retrieval_scope: "full_journal_database",
    searched_journal_count: data.journals.length,
    matched_journal_count: allRanked.length,
    data_version: data.dataVersion,
    privacy_mode: "stateless_no_chat_history",
    stores_chat_history: false,
  });
}

async function callModelScope(env, question, ranked, searchedJournalCount, options = {}) {
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
      const sourceLines = displaySources(sources, journal)
        .slice(0, 3)
        .map((source) => `${source.source_type || "source"}: ${source.source_url || ""}`)
        .join(" | ");
      return [
        `${index + 1}. ${journal.name} (${journal.abbreviation || "no abbreviation"})`,
        `JCR: ${journal.quartile || "JCR unverified / JCR 未核验"}; 2025 JIF: ${journal.jif_2025 ?? "unavailable / 指标缺失"}; 2025 JCI: ${journal.jci_2025 ?? "unavailable / 指标缺失"}`,
        `Catalog sources (not proof of JCR inclusion): ${catalogRecords(journal).map((source) => `${source.label || source.id}: ${source.evidence_url || source.url || "record only"}`).join(" | ") || "not recorded"}`,
        `Languages: ${(journal.languages || []).join(", ") || "not recorded"}; country or region: ${journal.country || "not recorded"}`,
        `Other names / editions: ${(journal.aliases || []).join("; ") || "none recorded"}; current ISSNs: ${journalIdentifiers(journal, false).join(", ") || "not recorded"}; historical ISSNs: ${(journal.historical_issns || []).join(", ") || "none recorded"}`,
        `Recorded annual publication volume (missing years remain unknown): ${publicationSeries}`,
        `Publisher: ${journal.publisher_family || journal.publisher || "unknown"}; first decision: ${journal.first_decision_days ?? "pending"} days; review time: ${journal.review_time_days ?? "pending"} days`,
        `Themes: ${topicHints || "pending"}`,
        `Submission clue: ${journal.word_limit || "pending official verification"}`,
        `Sources: ${sourceLines || "pending official verification"}`,
      ].join("\n");
    })
    .join("\n\n");

  const system = `You are AIED Journal Radar, an evidence-backed education journal-selection advisor covering the multilingual education journal catalog.
The retrieval stage scanned the complete database of ${searchedJournalCount} journals. It did not use the frontend shortlist or current dashboard filters.
Directory inclusion (including DOAJ) does not establish JCR inclusion. Missing quartile, JIF and JCI mean unverified or unavailable, never zero or a negative quality judgment. A request for non-JCR journals can only be supported as JCR-unverified candidates unless explicit verified exclusion evidence exists. Preserve any language, directory or quartile constraints in the question.
Use only the retrieved radar context below. Do not invent journal requirements. If evidence is insufficient, say 当前雷达资料不足.
Annual publication volumes labelled as coming from the radar workbook are recorded workbook values, not forecasts. Do not call them predicted values.
Answer in the user's language. If the user asks a factual question about a named journal, answer that journal directly and do not force a recommendation table.
For journal-selection questions, recommend 3-6 journals in a compact Markdown table, then add 2-3 short caveats.
For each recommended journal include fit, main risk, annual publication volume, review speed if available, and what needs official verification.
Avoid long introductions, star ratings, or generic praise.
This is a stateless request. Do not refer to previous chat history.${
    options.genericFallback
      ? "\nNote: retrieval found no topic-specific match for this question, so the context is a general browsing sample that still respects the question's language, directory and quartile constraints. Say so briefly, answer with what the context supports, and ask the user for their research topic to narrow the list."
      : ""
  }`;

  const model = modelName(env);
  const response = await fetch(`${apiBase(env)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MODELSCOPE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(model.startsWith("Qwen/Qwen3") ? {
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      } : {}),
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
  const constraints = queryConstraints(question, data);
  const latinQuestionTokens = new Set((question.normalize("NFKC").toLowerCase().match(/[a-z0-9]+(?:[-.&+][a-z0-9]+)*/g) || []).map(normalizeLookupText));
  return data.journals
    .filter((journal) => matchesConstraints(journal, constraints))
    .map((journal) => {
      const articlePreferences = journal.article_preferences || {};
      const pieces = {
        name: [journal.name, journal.abbreviation, ...(journal.aliases || [])].join(" "),
        tags: [journal.main_tag, journal.secondary_tag, journal.tag_path].join(" "),
        topics: [
          Object.keys(journal.topic_hits || {}).join(" "),
          Object.keys(journal.method_hits || {}).join(" "),
          Object.keys(articlePreferences.topic_counts || {}).join(" "),
          Object.keys(articlePreferences.method_counts || {}).join(" "),
        ].join(" "),
        publisher: [journal.publisher, journal.publisher_family, journal.submission_system].join(" "),
        requirements: String(journal.word_limit || ""),
        identifiers: journalIdentifiers(journal).join(" "),
        catalog: catalogRecords(journal).flatMap((source) => [source.id, source.label, source.record_id]).join(" "),
      };
      const lower = Object.fromEntries(Object.entries(pieces).map(([key, value]) => [key, String(value).normalize("NFKC").toLowerCase()]));
      const directScore = directJournalMatchScore(journal, question, normalizedQuestion, latinQuestionTokens);
      let relevanceScore = directScore;
      queryTerms.forEach((term) => {
        if (lower.name.includes(term)) relevanceScore += 10;
        if (lower.tags.includes(term)) relevanceScore += 8;
        if (lower.topics.includes(term)) relevanceScore += 9;
        if (lower.requirements.includes(term)) relevanceScore += 3;
        if (lower.publisher.includes(term)) relevanceScore += 2;
        if (lower.identifiers.includes(term)) relevanceScore += 20;
        if (lower.catalog.includes(term)) relevanceScore += 3;
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
  const lower = question.normalize("NFKC").toLowerCase();
  const stopwords = new Set(["what", "which", "are", "the", "and", "for", "can", "you", "please", "recommend", "journal", "journals", "publish", "publication", "about", "have", "has", "any"]);
  const terms = new Set((lower.match(/[a-z0-9]+(?:[-.&+][a-z0-9]+)*/g) || []).filter((term) => term.length >= 2 && !stopwords.has(term)));
  const chineseStopwords = new Set(["哪些", "什么", "多少", "期刊", "杂志", "推荐", "投稿", "可以", "适合", "是否", "研究", "论文", "中文", "英文", "有关", "一下", "请问", "有没有", "有哪些", "是多少"]);
  for (const sequence of lower.match(/[\u4e00-\u9fff]+/g) || []) {
    for (const width of [2, 3]) {
      for (let i = 0; i <= sequence.length - width; i += 1) {
        const term = sequence.slice(i, i + width);
        if (!chineseStopwords.has(term)) terms.add(term);
      }
    }
  }
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
    [/生成式|generative|genai|大模型|llm|chatgpt/, ["generative ai", "genai", "large language models", "ai literacy"]],
    [/学习分析|analytics/, ["learning analytics", "educational data mining"]],
    [/政策|治理|policy/, ["policy", "governance", "equity and policy"]],
    [/教师发展|professional development/, ["teacher development", "professional development"]],
    [/数学|math/, ["mathematics education", "stem education"]],
    [/评估|assessment/, ["assessment", "evaluation"]],
    [/心理|motivation|wellbeing|well-being/, ["educational psychology", "motivation and wellbeing"]],
    [/混合方法|mixed/, ["mixed methods"]],
    [/实验|experiment/, ["experiment", "quasi-experiment"]],
    [/edtech|教育科技|教育技术|技术增强|数字化学习/, ["educational technology", "technology enhanced", "e-learning", "digital learning", "computer assisted", "教育技术"]],
    [/\baied\b|智能教育|教育人工智能|智慧教育/, ["artificial intelligence", "intelligent tutoring", "generative ai", "educational technology"]],
    [/人工智能|\bai\b/, ["artificial intelligence", "ai literacy", "generative ai"]],
    [/在线|远程|网络学习|online|distance|mooc/, ["online learning", "distance education", "open learning", "mooc", "e-learning"]],
    [/stem|科学教育|物理|化学|生物/, ["stem education", "science education", "科学教育"]],
    [/特殊教育|融合教育|special education|inclusive/, ["special education", "inclusive education"]],
    [/幼儿|早期|学前|early childhood|preschool/, ["early childhood", "childhood education"]],
    [/职业教育|vocational/, ["vocational education", "career education"]],
    [/阅读|读写|素养|literacy|reading/, ["literacy", "reading", "writing"]],
    [/游戏|game/, ["game-based learning", "gamification", "educational games"]],
    [/移动学习|mobile/, ["mobile learning", "ubiquitous learning"]],
    [/课程|curriculum/, ["curriculum", "curriculum studies"]],
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

function journalIdentifiers(journal, includeHistorical = true) {
  return [...new Set([journal.issn, journal.eissn, ...(journal.issns || []), ...(includeHistorical ? journal.historical_issns || [] : [])].filter(Boolean).map(String))];
}

function catalogRecords(journal) {
  return Array.isArray(journal.catalog_sources) ? journal.catalog_sources : [];
}

function directJournalMatchScore(journal, question, normalizedQuestion, latinQuestionTokens) {
  const names = [journal.name, ...(journal.aliases || [])].filter(Boolean).map(normalizeLookupText);
  const abbreviation = normalizeLookupText(journal.abbreviation);
  let score = 0;
  if (names.some((name) => name.length >= (/[\u4e00-\u9fff]/.test(name) ? 2 : 6) && normalizedQuestion.includes(name))) score += 120;
  if (abbreviation.length >= 2 && latinQuestionTokens.has(abbreviation)) score += 100;
  if (journalIdentifiers(journal).some((id) => {
    const normalized = normalizeLookupText(id);
    return normalized.length >= 7 && normalizedQuestion.includes(normalized);
  })) score += 120;
  return score;
}

const CATALOG_ALIASES = Object.freeze({
  doaj: ["doaj", "directory of open access journals", "开放获取期刊目录"],
  ebsco_education: ["ebsco", "ebsco education source", "ebsco education", "ebsco教育学全文数据库", "ebsco教育数据库"],
  ncpssd: ["ncpssd", "国家哲学社会科学文献中心", "国家哲社中心", "国家哲社文献中心", "哲社文献中心", "哲社中心"],
  eric: ["eric"],
  openalex: ["openalex"],
});

function mentionsCatalog(text, alias) {
  const phrase = String(alias || "").normalize("NFKC").toLowerCase().trim();
  if (!phrase) return false;
  if (/[\u4e00-\u9fff]/.test(phrase)) return text.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function queryConstraints(question, data) {
  const text = String(question || "").normalize("NFKC").toLowerCase();
  const language = /中文.{0,8}(?:期刊|杂志)|(?:推荐|寻找|只要|限定|优先|找).{0,16}中文|chinese(?:[- ]language)?\s+(?:education\s+)?journals?|journals?\s+(?:in|published in)\s+chinese/.test(text) ? "zh"
    : /英文.{0,8}(?:期刊|杂志)|(?:推荐|寻找|只要|限定|优先|找).{0,16}英文|english(?:[- ]language)?\s+(?:education\s+)?journals?|journals?\s+(?:in|published in)\s+english/.test(text) ? "en" : null;
  const unknownJcr = /(?:非|未核验|不在|没有|未收录).{0,4}jcr|jcr.{0,6}(?:未核验|未知)|non[- ]?jcr|unverified.{0,8}jcr|jcr.{0,8}(?:unknown|unverified)/.test(text);
  const quartiles = new Set();
  for (const [quartile, pattern] of [["Q1", /(?<![a-z0-9])q1(?![a-z0-9])|一区/], ["Q2", /(?<![a-z0-9])q2(?![a-z0-9])|二区/], ["Q3", /(?<![a-z0-9])q3(?![a-z0-9])|三区/], ["Q4", /(?<![a-z0-9])q4(?![a-z0-9])|四区/]]) {
    if (pattern.test(text)) quartiles.add(quartile);
  }
  const requested = new Set();
  Object.entries(CATALOG_ALIASES).forEach(([id, aliases]) => {
    if (aliases.some((alias) => mentionsCatalog(text, alias))) requested.add(id);
  });
  data.journals.forEach((journal) => catalogRecords(journal).forEach((source) => {
    if (!["jcr", "jcr_workbook"].includes(source.id) && [source.id, source.label].some((alias) => mentionsCatalog(text, alias))) requested.add(source.id);
  }));
  const requestedCatalogs = [...requested];
  const verifiedJcr = !unknownJcr && /\bjcr\b/.test(text) && journalSeekingIntent(question);
  return { language, unknownJcr, verifiedJcr, quartiles, catalogs: requestedCatalogs };
}

function matchesConstraints(journal, constraints) {
  if (constraints.language && !(journal.languages || []).some((language) => {
    const code = String(language).toLowerCase();
    return constraints.language === "zh" ? /^(zh(?:-|$)|chi$|zho$|chinese$|中文$)/.test(code) : /^(en(?:-|$)|eng$|english$|英文$)/.test(code);
  })) return false;
  const hasJcr = journal.has_jcr_record === true || ["Q1", "Q2", "Q3", "Q4"].includes(journal.quartile);
  if (constraints.unknownJcr && hasJcr) return false;
  if (constraints.verifiedJcr && !hasJcr) return false;
  if (constraints.quartiles.size && !constraints.quartiles.has(journal.quartile)) return false;
  if (constraints.catalogs.length && !catalogRecords(journal).some((source) => constraints.catalogs.some((id) => String(source.id).toLowerCase().includes(String(id).toLowerCase()) || String(source.label || "").toLowerCase().includes(String(id).toLowerCase())))) return false;
  return true;
}

function journalSeekingIntent(question) {
  return /期刊|选刊|投稿|发表|顶刊|杂志|journal|publish|submit|recommend|推荐/i.test(question || "");
}

function fallbackJournals(data, question = "") {
  const sourceMap = data.sourcesByJournal;
  const constraints = queryConstraints(question, data);
  return data.journals.filter((journal) => matchesConstraints(journal, constraints))
    .sort((a, b) => (Number(b.jif_2025) || 0) - (Number(a.jif_2025) || 0))
    .slice(0, MAX_CONTEXT_JOURNALS)
    .map((journal) => ({
      journal,
      sources: sourceMap.get(journal.id) || [],
      score: Number(journal.jif_2025) || 0,
      relevanceScore: 0,
      directMatch: false,
    }));
}

function isMachineUrl(url) {
  return /api\.crossref\.org|\bapi\./i.test(String(url || ""));
}

function displaySources(sources, journal) {
  const readable = orderedSources(sources).filter((source) => {
    const url = source.source_url || source.url || "";
    return source.source_type !== "article_metadata_api" && url && !isMachineUrl(url);
  });
  if (readable.length) {
    return readable.map((source) => ({
      source_url: source.source_url || source.url || "",
      source_type: source.source_type || "source",
      captured_at: source.captured_at || "",
      text_snippet: source.text_snippet || source.status || "",
    }));
  }
  const homepage = (journal.source_urls || []).find((url) => url && !isMachineUrl(url)) || "";
  return homepage ? [{ source_url: homepage, source_type: "journal_homepage", captured_at: "", text_snippet: "" }] : [];
}

function sourcePayload(item) {
  const journal = item.journal;
  const catalog = catalogRecords(journal).map((source) => ({
    journal_name: journal.name,
    source_url: source.evidence_url || source.url || "",
    source_type: ["jcr", "jcr_workbook"].includes(source.id) ? "jcr_workbook" : "catalog_source",
    title: source.label || source.id,
    captured_at: source.retrieved_at || "",
    text_snippet: `${source.label || source.id} catalog record ${source.record_id || ""}; directory inclusion does not establish JCR coverage`,
  }));
  if (!catalog.some((source) => source.source_type === "jcr_workbook") && (journal.has_jcr_record === true || (journal.has_jcr_record === undefined && ["Q1", "Q2", "Q3", "Q4"].includes(journal.quartile)))) {
    catalog.push({ journal_name: journal.name, source_url: "", source_type: "jcr_workbook", captured_at: "", text_snippet: "Original JCR workbook record; metrics retain the recorded year" });
  }
  const base = displaySources(item.sources, journal).slice(0, 2);
  return [...catalog, ...base.map((source) => ({ journal_name: journal.name, ...source }))];
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
  const base = String(env.PUBLIC_DATA_BASE || DEFAULT_DATA_BASE).replace(/\/+$/, "");
  const now = Date.now();
  const manifest = await fetchJson(`${base}/data-manifest.json`, { fresh: true }).catch((error) => {
    if (error.status === 404) return null; // Legacy deployment, bounded by the TTL below.
    throw error;
  });
  const version = String(manifest?.data_version || "legacy");
  const cached = dataCaches.get(base);
  if (cached && cached.dataVersion === version && now - cached.loadedAt < DATA_TTL_MS) return cached;
  const key = `${base}|${version}`;
  if (dataLoads.has(key)) return dataLoads.get(key);
  const pending = (async () => {
    const suffix = manifest ? `?v=${encodeURIComponent(version)}` : "";
    const [journals, sources, report] = await Promise.all([
      fetchJson(`${base}/journals.json${suffix}`),
      fetchJson(`${base}/journal_sources.json${suffix}`),
      fetchJson(`${base}/crawl_report.json${suffix}`).catch(() => ({})),
    ]);
    if (!Array.isArray(journals) || !Array.isArray(sources)) throw new Error("Invalid radar dataset");
    if (manifest) {
      const latest = await fetchJson(`${base}/data-manifest.json`, { fresh: true });
      if (latest.data_version !== manifest.data_version) {
        throw new Error("Radar dataset changed during loading; retry against the new manifest");
      }
      if (Number(manifest.journal_count) !== journals.length) throw new Error("Radar manifest count mismatch");
    }
    const sourcesByJournal = new Map();
    sources.forEach((source) => {
      if (!sourcesByJournal.has(source.journal_id)) sourcesByJournal.set(source.journal_id, []);
      sourcesByJournal.get(source.journal_id).push(source);
    });
    const data = { loadedAt: now, dataVersion: version, journals, sources, sourcesByJournal, report: report || {} };
    dataCaches.delete(base);
    dataCaches.set(base, data);
    if (dataCaches.size > 4) dataCaches.delete(dataCaches.keys().next().value);
    return data;
  })().finally(() => dataLoads.delete(key));
  dataLoads.set(key, pending);
  return pending;
}

async function fetchJson(url, { fresh = false } = {}) {
  // workerd rejects no-store combined with cf.cacheTtl, even when the TTL is 0.
  const options = fresh
    ? { cache: "no-store" }
    : { cf: { cacheTtl: 600, cacheEverything: true } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const error = new Error(`Data fetch failed: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      // A connection can also fail while streaming a large JSON response body.
      return await response.json();
    } catch (error) {
      const transportFailure = !error.status && /network connection lost|fetch failed|failed to fetch|econnreset|econnrefused|etimedout/i.test(String(error.message || ""));
      if (attempt || !transportFailure) throw error;
      // Public data GETs are idempotent. Model requests never use this helper.
    }
  }
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

export { expandQueryTerms, rankJournals, journalSeekingIntent, fallbackJournals, displaySources, sourcePayload, queryConstraints, matchesConstraints, loadRadarData };
