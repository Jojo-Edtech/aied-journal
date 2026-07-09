const RADAR_URLS = {
  journals: "data/radar/journals.json",
  sources: "data/radar/journal_sources.json",
  network: "data/radar/research_network.json",
  report: "data/radar/crawl_report.json",
  config: "data/radar/radar-config.json",
  preferences: "data/radar/journal_preferences.json",
  editorProfiles: "data/radar/editor_profiles.json",
};

const ACCESS_CODE_STORAGE_KEY = "ajr-access-code";

const state = {
  journals: [],
  sourcesByJournal: new Map(),
  network: { nodes: [], links: [] },
  report: null,
  config: { api_base_url: "" },
  preferencesByJournal: new Map(),
  editorProfilesByJournal: new Map(),
  selectedJournalId: "",
  networkExpanded: false,
  themeRenderTimer: 0,
  accessRequired: false,
  ready: false,
  language: localStorage.getItem("ajr-language") || "zh",
};

const els = {
  language: document.querySelector("#languageSelect"),
  search: document.querySelector("#radarSearch"),
  tag: document.querySelector("#radarTagFilter"),
  quartile: document.querySelector("#radarQuartileFilter"),
  publisher: document.querySelector("#radarPublisherFilter"),
  speed: document.querySelector("#radarSpeedFilter"),
  kpis: document.querySelector("#radarKpis"),
  scatter: document.querySelector("#jifJciScatter"),
  speedChart: document.querySelector("#speedChart"),
  publisherChart: document.querySelector("#publisherChart"),
  heatmap: document.querySelector("#tagHeatmap"),
  network: document.querySelector("#researchNetwork"),
  networkNote: document.querySelector("#networkNote"),
  networkToggle: document.querySelector("#toggleNetwork"),
  recommendations: document.querySelector("#recommendationList"),
  tableMeta: document.querySelector("#tableMeta"),
  tableBody: document.querySelector("#journalTable tbody"),
  download: document.querySelector("#downloadVisible"),
  dashboard: document.querySelector("#radarDashboard"),
  detailPage: document.querySelector("#journalDetailPage"),
  detailContent: document.querySelector("#journalDetailContent"),
  chatStatus: document.querySelector("#chatStatus"),
  chatForm: document.querySelector("#radarChatForm"),
  accessField: document.querySelector("#accessCodeField"),
  chatCode: document.querySelector("#radarAccessCode"),
  chatQuestion: document.querySelector("#radarQuestion"),
  chatAnswer: document.querySelector("#chatAnswer"),
};

const I18N = {
  zh: {
    skip: "跳到选刊工作台",
    subtitle: "AIED选刊：教育学 JCR 期刊研究与投稿定位工作台",
    language: "语言",
    downloadData: "期刊数据",
    downloadReport: "抓取报告",
    controlTitle: "从期刊指标到研究主题网络",
    topicSearch: "研究主题",
    topicPlaceholder: "例如：generative AI、teacher education、language learning",
    mainTag: "主标签",
    quartile: "JCR 分区",
    publisher: "出版社",
    speed: "审稿速度",
    all: "全部",
    allQuartiles: "全部分区",
    fastDecision: "First decision ≤ 14 天",
    knownSpeed: "有审稿时间数据",
    chatTitle: "AI助手",
    chatLoading: "正在读取后端配置...",
    chatReady: "已配置服务器端 AI 代理；token 仅应存在服务器环境变量。",
    chatConnected: "AI 已连接：{provider} / {model}；今日剩余 {quota}，公开总剩余 {total}。",
    chatQuotaStopped: "AI 已暂停：模型免费额度可能已用完，今日停止继续调用。",
    chatOffline: "后端未连接；静态雷达可用，AI 助手待连接 ModelScope 代理。",
    chatIdle: "公开试用开启后，访问者只需要输入选刊问题；ModelScope token 只保存在服务器环境变量中。",
    chatHealthFailed: "后端地址已配置，但健康检查暂时失败；请稍后重试。",
    accessCode: "访问口令",
    accessPlaceholder: "输入站点访问口令",
    accessHint: "口令由站点管理员提供，不是 ModelScope token；不会写入 GitHub。",
    accessMissing: "请先输入访问口令。这个口令由站点管理员提供，不是 ModelScope token。",
    accessInvalid: "访问口令未通过验证。请检查是否复制了多余空格，或联系站点管理员确认当前口令。",
    accessUnconfigured: "服务器尚未配置访问口令，AI 助手暂时不可用。",
    publicBackendNeedsRestart: "前端已切换为公开限额模式，但当前服务器仍在旧口令模式。请等待后端重启后再试。",
    questionLabel: "你的论文/选刊问题",
    questionPlaceholder: "例如：我做中学英语教师使用生成式AI进行反馈的混合方法研究，哪些期刊更合适？",
    exampleFeedback: "教师反馈",
    exampleAnalytics: "学习分析",
    exampleTeacherDev: "教师发展",
    generateAdvice: "生成选刊建议",
    shortlistTitle: "选刊候选清单",
    shortlistCopy: "先给出 6 个高匹配候选；筛选或搜索后会实时更新。",
    scatterTitle: "JIF 与 JCI 分布",
    scatterCopy: "每个点是一份教育学 JCR 期刊，横轴为 JIF，纵轴为 JCI；颜色表示 JCR 分区，点大小表示 2025 年发文量。",
    speedTitle: "审稿速度",
    speedCopy: "First decision 与 review time 的可用数据对比。",
    speedCoverage: "First decision {first}/{total}；Review time {review}/{total}；Submission to acceptance {accept}/{total}",
    firstDecision: "First decision",
    reviewTime: "Review time",
    pendingVerification: "待核验",
    publisherTitle: "出版社分布",
    publisherCopy: "按 publisher family 汇总当前筛选期刊数量。",
    heatmapTitle: "主副标签热力图",
    heatmapCopy: "横向是副标签，纵向是主标签；颜色越深表示组合越常见。",
    networkTitle: "期刊-主题-出版社网络",
    networkNote: "默认显示筛选后的高信号节点。点击期刊节点可查看详情。",
    expandNetwork: "展开网络",
    collapseNetwork: "收起网络",
    legendJournal: "期刊",
    legendTopic: "主题",
    legendPublisher: "出版社",
    legendMethod: "方法/主题",
    tableTitle: "期刊明细",
    loadingData: "正在读取数据...",
    exportCurrent: "导出当前筛选",
    colJournal: "期刊",
    colTag: "分区 / 标签",
    colPublisher: "出版社",
    colEvidence: "官网证据",
    colPublicationVolume: "年发文量",
    publicationVolume: "年发文量",
    publicationVolume2025: "2025 年发文量",
    publicationVolumeExcel: "Excel 年发文量",
    publicationTrend: "年度发文量",
    publicationTrendNote: "来自 Excel 的 2022-2025 发文量，用于判断期刊容量与投稿拥挤度。",
    noPublicationVolume: "暂无发文量",
    publicationsCount: "{value} 篇",
    pointSizeLegend: "点大小 = 2025 年发文量",
    methodTitle: "数据说明",
    methodCopy: "期刊基础数据来自本地工作簿 Education_JCR_latest_refresh_2026-06-26.xlsx 的总表与本轮更新日志。网页只发布公开指标、官网链接、抓取状态和可引用片段；ModelScope / AI token、访问口令和限额配置只属于阿里云轻量服务器环境变量。",
    footer: "AIED Journal Radar 用于选刊与研究网络理解；最终投稿前仍需回到期刊官网确认最新 scope、格式要求和审稿政策。",
    missing: "未标注",
    noSecondary: "无副标签",
    noExtraTopic: "暂无额外主题命中",
    currentJournals: "当前期刊",
    q1InAll: "其中 Q1 {q1} 本 / 全表 {total} 本",
    medianJif: "JIF 中位数",
    medianJci: "JCI 中位数",
    medianFirstDecision: "First decision 中位数",
    medianPublicationVolume: "2025 发文量中位数",
    markedOnly: "仅统计已标注期刊",
    evidenceCoverage: "证据覆盖",
    articleSamples: "文章样本 {ok}/{total}",
    days: "{value}天",
    medianLabel: "中位：JIF {jif} / JCI {jci}",
    insufficientScatter: "当前筛选下可绘制的 JIF/JCI 点不足。",
    emptyData: "当前筛选下没有可显示的数据。",
    emptyNetwork: "当前筛选下没有可显示的网络节点。",
    networkSummary: "显示 {nodes} 个节点、{links} 条关系；默认只显示最相关的 {limit} 本期刊，搜索或筛选后会自动重绘。",
    noCandidates: "没有匹配的候选期刊。",
    decisionSpeed: "{days}天一审",
    speedUnknown: "审稿时间待核",
    evidenceText: "{pages}个官网页 / {articles}篇最新文章样本",
    matchClues: "匹配线索：{topics}；证据覆盖：{evidence}。",
    tableMeta: "显示 {shown} / {filtered} 本；源表全量 {total} 本。",
    pagesArticles: "{pages}页 / {articles}篇",
    preferenceTitle: "文章偏好可视化",
    themeMapTitle: "主题地图",
    themeMapCopy: "按 General / Specific / Very specific 三层显示柱状偏好图；点击条形查看支撑文章。",
    timeSlice: "时间范围",
    recent3Issues: "近3期",
    last1Year: "近1年",
    last2Years: "近2年",
    last3Years: "近3年",
    last5Years: "近5年",
    allYears: "All",
    latestIssueFilter: "Latest issue",
    rangeSampleMeta: "{count} 篇样本 · {description}",
    sampleDepthFallback: "样本时间集中，已按最近文章深度区分",
    issueMonthFallback: "期次字段为连续出版，已按最新月份近似",
    generalLevel: "General",
    specificLevel: "Specific",
    verySpecificLevel: "Very specific",
    themeEvidence: "支撑文章",
    noThemeEvidence: "点击条形后显示支撑文章。",
    noPreferenceData: "当前时间范围没有足够文章样本。",
    preferenceCopy: "基于已抓取的最近文章标题、摘要和关键词自动归纳；样本数 {count} 篇。",
    topicPreference: "主题偏好",
    methodPreference: "方法/形态偏好",
    insufficientPreference: "当前文章样本不足，暂时无法形成偏好判断。",
    latestIssue: "Latest issue 线索",
    latestIssueText: "{label}；样本文章 {count} 篇。",
    noIssue: "当前样本未识别到卷期信息",
    noLatestTitles: "暂无最新卷期标题样本。",
    yearlyTrend: "近年趋势",
    insufficientTopics: "当前样本不足",
    editorsTitle: "编辑与副编辑",
    editorChief: "Editor-in-Chief",
    associateEditors: "Associate / Section Editors",
    notCaptured: "当前未抓取到。",
    editorNote: "编辑团队为公开网页自动抽取字段；投稿前请回官网核验。",
    editorSource: "编辑团队来源页面",
    editorRoleAll: "全部角色",
    affiliation: "单位",
    countryOrRegion: "地区",
    verification: "核验状态",
    journalDetail: "期刊详情",
    backToRadar: "返回选刊工作台",
    latestArticles: "Latest issue / 近期文章",
    articleSamplesTitle: "文章样本",
    askAiAboutJournal: "用 AI 助手询问这本期刊",
    submissionSpeed: "投稿要求",
    speedAndWorkflow: "流程与速度",
    manuscriptRequirements: "稿件要求",
    manuscriptLength: "稿件长度",
    submissionSystem: "投稿系统",
    firstDecision: "首次决定",
    reviewTime: "评审用时",
    acceptanceTime: "接收到录用",
    keySubmissionSources: "关键投稿来源",
    submissionGuidelines: "投稿指南",
    authorInfo: "作者说明",
    journalHomepage: "期刊主页",
    journalMetrics: "期刊指标",
    articleSample: "文章样本",
    officialVerificationNote: "投稿前请回官网确认最新格式、栏目、开放获取和审稿政策。",
    noRequirementLinks: "暂无可识别的投稿来源链接。",
    topicNetworkClues: "主题网络线索",
    topicPositioning: "主题定位",
    journalSources: "官网来源",
    noSources: "暂无官网链接。",
    crawlStatus: "抓取状态",
    noCrawl: "当前本地数据尚未抓取该刊官网页面。",
    sourceChars: "{type} · {chars} chars",
    jifAxis: "2025 JIF（对数缩放）",
    jciAxis: "2025 JCI（对数缩放）",
    apiMissing: "后端 API 尚未配置。部署服务器端 ModelScope 代理后，把公开 API 地址写入 data/radar/radar-config.json 的 api_base_url。",
    questionMissing: "请先输入论文主题或选刊问题。",
    chatWorking: "正在检索期刊证据并调用 AI 模型...",
    modelUsed: "模型：{provider} / {model}",
    requestFailed: "请求失败：HTTP {status}",
    noAnswer: "没有生成回答。",
    quota: "剩余额度：{quota}",
    quotaWithTotal: "剩余额度：今日 {quota} / 公开总额 {total}",
    sources: "引用来源：",
    noSourcesShort: "无",
    backendUnreachable: "后端暂时无法访问。请确认服务器服务已启动、CORS 允许当前域名，并且没有把 token 放到前端。",
    loadFailed: "AIED Journal Radar 数据读取失败：{message}",
    csvName: "aied-journal-radar-filtered-journals.csv",
  },
  en: {
    skip: "Skip to journal radar",
    subtitle: "A research-oriented journal selection workspace for education JCR journals",
    language: "Language",
    downloadData: "Journal data",
    downloadReport: "Crawl report",
    controlTitle: "From journal metrics to research-topic networks",
    topicSearch: "Research topic",
    topicPlaceholder: "e.g., generative AI, teacher education, language learning",
    mainTag: "Main tag",
    quartile: "JCR quartile",
    publisher: "Publisher",
    speed: "Review speed",
    all: "All",
    allQuartiles: "All quartiles",
    fastDecision: "First decision ≤ 14 days",
    knownSpeed: "Has review-time data",
    chatTitle: "AI Advisor",
    chatLoading: "Loading backend configuration...",
    chatReady: "Server-side AI proxy configured; tokens should only exist in server environment variables.",
    chatConnected: "AI connected: {provider} / {model}; today {quota}, public total {total}.",
    chatQuotaStopped: "AI paused: model free quota may be exhausted, so calls stop for today.",
    chatOffline: "Backend not connected; static radar is available while the ModelScope proxy is pending.",
    chatIdle: "In public limited mode, visitors only enter a journal-fit question; the ModelScope token stays in server environment variables.",
    chatHealthFailed: "Backend URL is configured, but the health check is temporarily unavailable.",
    accessCode: "Access code",
    accessPlaceholder: "Enter the site access code",
    accessHint: "Provided by the site admin; this is not a ModelScope token and is not stored in GitHub.",
    accessMissing: "Please enter the site access code first. It is provided by the site admin, not your ModelScope token.",
    accessInvalid: "The access code was not accepted. Check for extra spaces or ask the site admin for the current code.",
    accessUnconfigured: "The server has not configured an access code, so the AI Advisor is temporarily unavailable.",
    publicBackendNeedsRestart: "The frontend is now in public limited mode, but the running server is still using the old access-code mode. Please retry after the backend restarts.",
    questionLabel: "Your manuscript / journal-fit question",
    questionPlaceholder: "e.g., I study generative AI-supported feedback with secondary English teachers. Which journals fit?",
    exampleFeedback: "Teacher feedback",
    exampleAnalytics: "Learning analytics",
    exampleTeacherDev: "Teacher development",
    generateAdvice: "Generate advice",
    shortlistTitle: "Journal shortlist",
    shortlistCopy: "Shows 6 high-fit candidates first; filters and search update it live.",
    scatterTitle: "JIF and JCI distribution",
    scatterCopy: "Each point is an education JCR journal. X = JIF, Y = JCI; color = JCR quartile; point size = 2025 publication volume.",
    speedTitle: "Review speed",
    speedCopy: "Compares available first-decision and review-time data.",
    speedCoverage: "First decision {first}/{total}; review time {review}/{total}; submission to acceptance {accept}/{total}",
    firstDecision: "First decision",
    reviewTime: "Review time",
    pendingVerification: "Pending verification",
    publisherTitle: "Publisher distribution",
    publisherCopy: "Counts journals in the current filter by publisher family.",
    heatmapTitle: "Primary / secondary tag heatmap",
    heatmapCopy: "Rows are main tags, columns are secondary tags; darker cells are more common.",
    networkTitle: "Journal-topic-publisher network",
    networkNote: "High-signal nodes are shown by default. Click a journal node for details.",
    expandNetwork: "Expand network",
    collapseNetwork: "Collapse network",
    legendJournal: "Journal",
    legendTopic: "Topic",
    legendPublisher: "Publisher",
    legendMethod: "Method/theme",
    tableTitle: "Journal details",
    loadingData: "Loading data...",
    exportCurrent: "Export current filter",
    colJournal: "Journal",
    colTag: "Quartile / tag",
    colPublisher: "Publisher",
    colEvidence: "Evidence",
    colPublicationVolume: "Annual volume",
    publicationVolume: "Annual volume",
    publicationVolume2025: "2025 publication volume",
    publicationVolumeExcel: "Excel publication volume",
    publicationTrend: "Annual publication volume",
    publicationTrendNote: "2022-2025 publication counts from the Excel workbook, useful for judging journal capacity and submission crowding.",
    noPublicationVolume: "No publication volume",
    publicationsCount: "{value} articles",
    pointSizeLegend: "Point size = 2025 publication volume",
    methodTitle: "Data notes",
    methodCopy: "Journal data comes from the local workbook Education_JCR_latest_refresh_2026-06-26.xlsx. The static site publishes only public metrics, source links, crawl status, and citeable snippets; ModelScope / AI tokens, access codes, and quotas belong only in server environment variables.",
    footer: "AIED Journal Radar supports journal selection and research-network interpretation; always confirm current scope, formatting, and review policies on the journal website before submission.",
    missing: "Missing",
    noSecondary: "No secondary tag",
    noExtraTopic: "No extra topic hits yet",
    currentJournals: "Current journals",
    q1InAll: "Q1 {q1} / all {total}",
    medianJif: "Median JIF",
    medianJci: "Median JCI",
    medianFirstDecision: "Median first decision",
    medianPublicationVolume: "Median 2025 volume",
    markedOnly: "Only journals with available data",
    evidenceCoverage: "Evidence coverage",
    articleSamples: "Article samples {ok}/{total}",
    days: "{value} days",
    medianLabel: "Median: JIF {jif} / JCI {jci}",
    insufficientScatter: "Not enough JIF/JCI points for the current filter.",
    emptyData: "No displayable data for the current filter.",
    emptyNetwork: "No network nodes for the current filter.",
    networkSummary: "Showing {nodes} nodes and {links} links; the {limit} most relevant journals are drawn by default.",
    noCandidates: "No matching candidate journals.",
    decisionSpeed: "{days}-day first decision",
    speedUnknown: "Review time pending",
    evidenceText: "{pages} official pages / {articles} recent article samples",
    matchClues: "Match clues: {topics}; evidence coverage: {evidence}.",
    tableMeta: "Showing {shown} / {filtered}; source table has {total} journals.",
    pagesArticles: "{pages} pages / {articles} articles",
    preferenceTitle: "Article preference map",
    themeMapTitle: "Theme map",
    themeMapCopy: "Shows layered bar preference charts across General / Specific / Very specific levels. Click a bar for supporting articles.",
    timeSlice: "Time range",
    recent3Issues: "Recent 3 issues",
    last1Year: "Last 1 year",
    last2Years: "Last 2 years",
    last3Years: "Last 3 years",
    last5Years: "Last 5 years",
    allYears: "All",
    latestIssueFilter: "Latest issue",
    rangeSampleMeta: "{count} samples · {description}",
    sampleDepthFallback: "Limited time spread; using recent-sample depth",
    issueMonthFallback: "Continuous issue metadata; approximated by latest publication month",
    generalLevel: "General",
    specificLevel: "Specific",
    verySpecificLevel: "Very specific",
    themeEvidence: "Supporting articles",
    noThemeEvidence: "Click a bar to show supporting articles.",
    noPreferenceData: "There are not enough article samples for this time range.",
    preferenceCopy: "Inferred from captured recent article titles, abstracts, and keywords; sample size {count}.",
    topicPreference: "Topic preference",
    methodPreference: "Method / format preference",
    insufficientPreference: "Article samples are currently insufficient for preference inference.",
    latestIssue: "Latest issue signal",
    latestIssueText: "{label}; {count} sampled articles.",
    noIssue: "No volume/issue detected in the current sample",
    noLatestTitles: "No latest-issue title samples yet.",
    yearlyTrend: "Yearly trend",
    insufficientTopics: "Insufficient sample",
    editorsTitle: "Editors and associate editors",
    editorChief: "Editor-in-Chief",
    associateEditors: "Associate / Section Editors",
    notCaptured: "Not captured yet.",
    editorNote: "Editorial names are extracted from public pages and should be verified on the journal website.",
    editorSource: "Editorial source page",
    editorRoleAll: "All roles",
    affiliation: "Affiliation",
    countryOrRegion: "Region",
    verification: "Verification",
    journalDetail: "Journal detail",
    backToRadar: "Back to radar",
    latestArticles: "Latest issue / recent articles",
    articleSamplesTitle: "Article samples",
    askAiAboutJournal: "Ask AI about this journal",
    submissionSpeed: "Submission requirements",
    speedAndWorkflow: "Workflow and speed",
    manuscriptRequirements: "Manuscript requirements",
    manuscriptLength: "Manuscript length",
    submissionSystem: "Submission system",
    firstDecision: "First decision",
    reviewTime: "Review time",
    acceptanceTime: "Submission to acceptance",
    keySubmissionSources: "Key submission sources",
    submissionGuidelines: "Submission guidelines",
    authorInfo: "Author information",
    journalHomepage: "Journal homepage",
    journalMetrics: "Journal metrics",
    articleSample: "Article sample",
    officialVerificationNote: "Confirm the latest formatting, article types, open-access, and review policies on the official journal site before submission.",
    noRequirementLinks: "No recognizable submission source links yet.",
    topicNetworkClues: "Topic-network clues",
    topicPositioning: "Topic positioning",
    journalSources: "Journal sources",
    noSources: "No source links yet.",
    crawlStatus: "Crawl status",
    noCrawl: "This journal has no captured official pages in the local data yet.",
    sourceChars: "{type} · {chars} chars",
    jifAxis: "2025 JIF (log scale)",
    jciAxis: "2025 JCI (log scale)",
    apiMissing: "Backend API is not configured. After deploying the server-side ModelScope proxy, write its public URL to data/radar/radar-config.json.",
    questionMissing: "Please enter a manuscript topic or journal-fit question first.",
    chatWorking: "Retrieving journal evidence and calling the AI model...",
    modelUsed: "Model: {provider} / {model}",
    requestFailed: "Request failed: HTTP {status}",
    noAnswer: "No answer was generated.",
    quota: "Remaining quota: {quota}",
    quotaWithTotal: "Remaining quota: today {quota} / public total {total}",
    sources: "Sources:",
    noSourcesShort: "None",
    backendUnreachable: "Backend is temporarily unreachable. Check the server service, CORS origin, and keep tokens out of frontend code.",
    loadFailed: "AIED Journal Radar data failed to load: {message}",
    csvName: "aied-journal-radar-filtered-journals.csv",
  },
};

function t(key, vars = {}) {
  const template = (I18N[state.language] && I18N[state.language][key]) || I18N.zh[key] || key;
  return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), template);
}

const COLORS = {
  journal: "#2563a8",
  topic: "#9a6b18",
  publisher: "#2d6a4f",
  method_or_theme: "#c75246",
  line: "#d3dad1",
  text: "#202124",
  muted: "#626a73",
  gold: "#b7791f",
  blue: "#2563a8",
  coral: "#c75246",
  green: "#2d6a4f",
};

const QUARTILE_COLORS = {
  Q1: "#2563a8",
  Q2: "#2d6a4f",
  Q3: "#b7791f",
  Q4: "#7b8794",
};

const TIME_RANGE_OPTIONS = ["recent_3_issues", "latest_issue", "rolling_1y", "rolling_2y", "rolling_3y", "rolling_5y", "all"];

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fmt(value, digits = 1) {
  const parsed = number(value);
  return parsed === null ? t("missing") : parsed.toFixed(digits).replace(/\.0$/, "");
}

function storedAccessCode() {
  try {
    return sessionStorage.getItem(ACCESS_CODE_STORAGE_KEY) || "";
  } catch (error) {
    return "";
  }
}

function rememberAccessCode(code) {
  try {
    if (code) sessionStorage.setItem(ACCESS_CODE_STORAGE_KEY, code);
  } catch (error) {
    // Session storage can be blocked in strict privacy modes; the form still works.
  }
}

function markAccessCodeInvalid(invalid) {
  els.chatCode?.classList.toggle("is-invalid", invalid);
}

function updateAccessMode(required) {
  state.accessRequired = Boolean(required);
  els.accessField?.classList.toggle("is-hidden", !state.accessRequired);
  if (!state.accessRequired) {
    markAccessCodeInvalid(false);
    if (els.chatCode) els.chatCode.value = "";
  }
}

function chatErrorMessage(status, data = {}) {
  const detail = typeof data.detail === "string" ? data.detail : "";
  const error = typeof data.error === "string" ? data.error : "";
  const message = detail || error;
  if (status === 401 && !state.accessRequired) return t("publicBackendNeedsRestart");
  if (status === 401) return t("accessInvalid");
  if (status === 503 && message.includes("访问口令")) return t("accessUnconfigured");
  return message || t("requestFailed", { status });
}

function quotaMessage(daily, total) {
  const dailyValue = daily ?? t("missing");
  if (total === undefined || total === null) return t("quota", { quota: dailyValue });
  return t("quotaWithTotal", { quota: dailyValue, total });
}

function integerValue(value) {
  const parsed = number(value);
  return parsed === null ? null : Math.round(parsed);
}

function publicationVolume(journal, year = "2025") {
  return integerValue(journal?.publications?.[year]);
}

function publicationLabel(journal, year = "2025") {
  const value = publicationVolume(journal, year);
  return value === null ? t("noPublicationVolume") : t("publicationsCount", { value });
}

function publicationSeries(journal) {
  return ["2022", "2023", "2024", "2025"]
    .map((year) => ({ year, value: publicationVolume(journal, year) }))
    .filter((item) => item.value !== null);
}

function stableOffset(seed, axis, amplitude) {
  const text = `${seed}-${axis}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 9973;
  }
  return ((hash / 9973) * 2 - 1) * amplitude;
}

function median(values) {
  const nums = values.map(number).filter((value) => value !== null).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function countBy(items, key) {
  const counts = new Map();
  items.forEach((item) => {
    const value = item[key] || t("missing");
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"));
}

function terms(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[\s,;，；、/]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function termJoin(values) {
  return values.filter(Boolean).join(state.language === "zh" ? "、" : ", ");
}

function journalSearchText(journal) {
  return [
    journal.name,
    journal.abbreviation,
    journal.main_tag,
    journal.secondary_tag,
    journal.publisher,
    journal.publisher_family,
    journal.quartile,
    journal.submission_system,
    Object.keys(journal.topic_hits || {}).join(" "),
    Object.keys(journal.method_hits || {}).join(" "),
    Object.keys(journal.article_preferences?.topic_counts || {}).join(" "),
    Object.keys(journal.article_preferences?.method_counts || {}).join(" "),
    journal.word_limit,
  ]
    .join(" ")
    .toLowerCase();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

function fillFilter(select, values, allLabel = t("all")) {
  select.innerHTML = "";
  [allLabel, ...values].forEach((value) => {
    const option = document.createElement("option");
    option.value = value === allLabel ? "all" : value;
    option.textContent = value;
    select.append(option);
  });
}

function refreshFilters() {
  const previous = {
    tag: els.tag.value,
    quartile: els.quartile.value,
    publisher: els.publisher.value,
  };
  fillFilter(els.tag, unique(state.journals.map((journal) => journal.main_tag)), t("all"));
  fillFilter(els.quartile, unique(state.journals.map((journal) => journal.quartile)), t("allQuartiles"));
  fillFilter(els.publisher, unique(state.journals.map((journal) => journal.publisher_family)), t("all"));
  Object.entries(previous).forEach(([key, value]) => {
    const select = els[key];
    if ([...select.options].some((option) => option.value === value)) {
      select.value = value;
    }
  });
}

function applyTranslations() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  if (els.language) els.language.value = state.language;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  });
}

async function updateChatStatus() {
  if (!els.chatStatus) return;
  const apiBase = String(state.config.api_base_url || "").replace(/\/+$/, "");
  updateAccessMode((state.config.access_mode || "") === "semi_public_code");
  if (!apiBase) {
    els.chatStatus.textContent = t("chatOffline");
    if (els.chatAnswer && (!els.chatAnswer.textContent || els.chatAnswer.dataset.idle === "true")) {
      els.chatAnswer.dataset.idle = "true";
      els.chatAnswer.textContent = t("chatIdle");
    }
    return;
  }

  els.chatStatus.textContent = t("chatReady");
  if (els.chatAnswer && (!els.chatAnswer.textContent || els.chatAnswer.dataset.idle === "true")) {
    els.chatAnswer.dataset.idle = "true";
    els.chatAnswer.textContent = "";
  }

  try {
    const response = await fetch(`${apiBase}/api/health`, { cache: "no-store" });
    if (!response.ok) throw new Error("health check failed");
    const health = await response.json();
    updateAccessMode(Object.prototype.hasOwnProperty.call(health, "access_required") ? Boolean(health.access_required) : state.accessRequired);
    if (health.provider_quota_exhausted) {
      els.chatStatus.textContent = t("chatQuotaStopped");
      return;
    }
    els.chatStatus.textContent = t("chatConnected", {
      provider: health.llm_provider || "AI",
      model: health.llm_model || t("missing"),
      quota: health.remaining_quota ?? t("missing"),
      total: health.remaining_total_quota ?? t("missing"),
    });
    if (!health.llm_configured) {
      els.chatStatus.textContent = t("chatReady");
    }
  } catch (error) {
    els.chatStatus.textContent = t("chatHealthFailed");
  }
}

function filteredJournals() {
  const queryTerms = terms(els.search.value);
  return state.journals
    .filter((journal) => {
      if (els.tag.value !== "all" && journal.main_tag !== els.tag.value) return false;
      if (els.quartile.value !== "all" && journal.quartile !== els.quartile.value) return false;
      if (els.publisher.value !== "all" && journal.publisher_family !== els.publisher.value) return false;
      if (els.speed.value === "fast" && !(number(journal.first_decision_days) !== null && journal.first_decision_days <= 14)) {
        return false;
      }
      if (
        els.speed.value === "known" &&
        number(journal.first_decision_days) === null &&
        number(journal.review_time_days) === null
      ) {
        return false;
      }
      if (queryTerms.length === 0) return true;
      const haystack = journalSearchText(journal);
      return queryTerms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => {
      const scoreDiff = recommendationScore(b) - recommendationScore(a);
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      return (number(b.jif_2025) || 0) - (number(a.jif_2025) || 0);
    });
}

function recommendationScore(journal) {
  const queryTerms = terms(els.search.value);
  const haystack = journalSearchText(journal);
  let score = 0;
  queryTerms.forEach((term) => {
    if (haystack.includes(term)) score += 10;
    if (String(journal.name || "").toLowerCase().includes(term)) score += 6;
  });
  score += Math.min(18, (number(journal.jif_2025) || 0) * 1.2);
  score += Math.min(12, (number(journal.jci_2025) || 0) * 2);
  score += Math.min(5, (publicationVolume(journal, "2025") || 0) / 30);
  if (number(journal.first_decision_days) !== null) score += Math.max(0, 12 - journal.first_decision_days / 7);
  if ((journal.source_pages_crawled || 0) > 0) score += 2;
  if ((journal.article_count_crawled || 0) > 0) score += 3;
  if (journal.quartile === "Q1") score += 2;
  return score;
}

function renderKpis(journals) {
  const report = state.report || {};
  const sourcePages = report.source_pages || {};
  const articles = report.articles || {};
  const q1Count = journals.filter((journal) => journal.quartile === "Q1").length;
  const kpis = [
    [t("currentJournals"), journals.length, t("q1InAll", { q1: q1Count, total: state.journals.length })],
    [t("medianJif"), fmt(median(journals.map((journal) => journal.jif_2025))), "2025 Journal Impact Factor"],
    [t("medianJci"), fmt(median(journals.map((journal) => journal.jci_2025))), "2025 Journal Citation Indicator"],
    [t("medianFirstDecision"), t("days", { value: fmt(median(journals.map((journal) => journal.first_decision_days)), 0) }), t("markedOnly")],
    [t("medianPublicationVolume"), publicationLabel({ publications: { 2025: median(journals.map((journal) => journal.publications?.["2025"])) } }, "2025"), t("publicationVolumeExcel")],
    [t("evidenceCoverage"), `${sourcePages.ok || 0}/${sourcePages.total || 0}`, t("articleSamples", { ok: articles.ok || 0, total: articles.total || 0 })],
  ];
  els.kpis.innerHTML = kpis
    .map(
      ([label, value, note]) => `
        <div class="radar-kpi">
          <strong>${value}</strong>
          <span>${label}</span>
          <small>${note}</small>
        </div>
      `
    )
    .join("");
}

function clear(element) {
  element.innerHTML = "";
}

function svg(width, height) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", `0 0 ${width} ${height}`);
  node.setAttribute("role", "img");
  return node;
}

function svgNode(name, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function renderScatter(journals) {
  clear(els.scatter);
  const data = journals.filter((journal) => number(journal.jif_2025) !== null && number(journal.jci_2025) !== null);
  if (data.length < 8) {
    els.scatter.innerHTML = `<div class="empty-radar">${t("insufficientScatter")}</div>`;
    return;
  }

  const width = 1280;
  const height = 560;
  const margin = { top: 44, right: 80, bottom: 70, left: 76 };
  const chart = svg(width, height);
  const maxX = Math.log1p(Math.max(...data.map((journal) => number(journal.jif_2025))) * 1.05);
  const maxY = Math.log1p(Math.max(...data.map((journal) => number(journal.jci_2025))) * 1.08);
  const x = (value) => margin.left + (Math.log1p(value) / maxX) * (width - margin.left - margin.right);
  const y = (value) => height - margin.bottom - (Math.log1p(value) / maxY) * (height - margin.top - margin.bottom);
  const maxPublications = Math.max(...data.map((journal) => publicationVolume(journal, "2025") || 0), 1);
  const pointRadius = (journal) => {
    const publications = publicationVolume(journal, "2025") || 0;
    return Math.max(3.4, Math.min(10.2, 3.6 + Math.sqrt(publications / maxPublications) * 6.6));
  };
  const positioned = data.map((journal) => {
    const jitter = data.length > 80 ? 13 : 7;
    return {
      journal,
      x: Math.max(margin.left + 4, Math.min(width - margin.right - 4, x(journal.jif_2025) + stableOffset(journal.id, "x", jitter))),
      y: Math.max(margin.top + 4, Math.min(height - margin.bottom - 4, y(journal.jci_2025) + stableOffset(journal.id, "y", jitter))),
      radius: pointRadius(journal),
    };
  });
  const medJif = median(data.map((journal) => journal.jif_2025));
  const medJci = median(data.map((journal) => journal.jci_2025));
  const quartiles = ["Q1", "Q2", "Q3", "Q4"].filter((quartile) => data.some((journal) => journal.quartile === quartile));
  const quartileColor = (quartile) => QUARTILE_COLORS[quartile] || COLORS.muted;
  const labelIds = new Set(
    [...data]
      .sort((a, b) => {
        const aScore = (number(a.jif_2025) || 0) * 1.4 + (number(a.jci_2025) || 0) * 4 + (publicationVolume(a, "2025") || 0) / 60;
        const bScore = (number(b.jif_2025) || 0) * 1.4 + (number(b.jci_2025) || 0) * 4 + (publicationVolume(b, "2025") || 0) / 60;
        return bScore - aScore;
      })
      .slice(0, 6)
      .map((journal) => journal.id)
  );

  [0.25, 0.5, 0.75, 1].forEach((step) => {
    const gx = margin.left + step * (width - margin.left - margin.right);
    const gy = margin.top + step * (height - margin.top - margin.bottom);
    chart.append(svgNode("line", { x1: gx, y1: margin.top, x2: gx, y2: height - margin.bottom, class: "grid-line" }));
    chart.append(svgNode("line", { x1: margin.left, y1: gy, x2: width - margin.right, y2: gy, class: "grid-line" }));
  });

  chart.append(svgNode("line", { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, stroke: "#59616a" }));
  chart.append(svgNode("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, stroke: "#59616a" }));
  if (medJif !== null && medJci !== null) {
    chart.append(svgNode("line", { x1: x(medJif), y1: margin.top, x2: x(medJif), y2: height - margin.bottom, class: "median-line" }));
    chart.append(svgNode("line", { x1: margin.left, y1: y(medJci), x2: width - margin.right, y2: y(medJci), class: "median-line" }));
    const medianLabel = svgNode("text", { x: x(medJif) + 8, y: y(medJci) - 8, class: "chart-annotation" });
    medianLabel.textContent = t("medianLabel", { jif: fmt(medJif), jci: fmt(medJci) });
    chart.append(medianLabel);
  }

  positioned.forEach(({ journal, x: pointX, y: pointY, radius }) => {
    const circle = svgNode("circle", {
      cx: pointX,
      cy: pointY,
      r: radius,
      fill: quartileColor(journal.quartile),
      "fill-opacity": journal.quartile === "Q1" ? "0.64" : "0.46",
      tabindex: "0",
    });
    circle.append(svgNode("title"));
    circle.querySelector("title").textContent = `${journal.name}\n${journal.quartile} · JIF ${fmt(journal.jif_2025)} · JCI ${fmt(journal.jci_2025)} · ${t("publicationVolume2025")} ${publicationLabel(journal, "2025")}\n${journal.main_tag}`;
    circle.addEventListener("click", () => navigateToJournal(journal.id));
    chart.append(circle);
    if (labelIds.has(journal.id)) {
      const label = svgNode("text", {
        x: pointX + radius + 5,
        y: pointY - radius - 3,
        class: "point-label",
      });
      label.textContent = (journal.abbreviation || journal.name).slice(0, 24);
      chart.append(label);
    }
  });

  const xLabel = svgNode("text", { x: width / 2, y: height - 12, class: "axis-label", "text-anchor": "middle" });
  xLabel.textContent = t("jifAxis");
  chart.append(xLabel);
  const yLabel = svgNode("text", {
    x: 16,
    y: height / 2,
    class: "axis-label",
    "text-anchor": "middle",
    transform: `rotate(-90 16 ${height / 2})`,
  });
  yLabel.textContent = t("jciAxis");
  chart.append(yLabel);
  els.scatter.append(chart);
  const legend = document.createElement("div");
  legend.className = "tag-legend";
  legend.innerHTML = quartiles
    .map((quartile) => `<span><i style="background:${quartileColor(quartile)}"></i>${escapeHtml(quartile)}</span>`)
    .join("") + `<span class="size-legend">${escapeHtml(t("pointSizeLegend"))}</span>`;
  els.scatter.append(legend);
}

function renderHorizontalBars(container, rows, options = {}) {
  clear(container);
  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-radar">${t("emptyData")}</div>`;
    return;
  }
  const width = options.width || 560;
  const rowHeight = options.rowHeight || 30;
  const margin = { top: 8, right: 48, bottom: 18, left: options.left || 190 };
  const height = margin.top + margin.bottom + rows.length * rowHeight;
  const maxValue = Math.max(...rows.map((row) => row.value), 1);
  const chart = svg(width, height);
  rows.forEach((row, index) => {
    const y = margin.top + index * rowHeight + 5;
    const barWidth = (row.value / maxValue) * (width - margin.left - margin.right);
    const label = svgNode("text", { x: margin.left - 8, y: y + 14, class: "bar-label", "text-anchor": "end" });
    label.textContent = row.label.length > 28 ? `${row.label.slice(0, 27)}…` : row.label;
    chart.append(label);
    chart.append(svgNode("rect", { x: margin.left, y, width: Math.max(2, barWidth), height: 17, rx: 4, fill: row.color || COLORS.green }));
    const value = svgNode("text", { x: margin.left + barWidth + 6, y: y + 14, class: "bar-label" });
    value.textContent = row.valueLabel || row.value;
    chart.append(value);
  });
  container.append(chart);
}

function renderSpeedChart(journals) {
  clear(els.speedChart);
  const coverage = state.report?.speed_coverage || {};
  const rows = journals
    .filter((journal) => number(journal.first_decision_days) !== null || number(journal.review_time_days) !== null)
    .sort((a, b) => {
      const aValue = Math.min(number(a.first_decision_days) ?? 9999, number(a.review_time_days) ?? 9999);
      const bValue = Math.min(number(b.first_decision_days) ?? 9999, number(b.review_time_days) ?? 9999);
      return aValue - bValue;
    })
    .slice(0, 12);
  if (rows.length === 0) {
    els.speedChart.innerHTML = `<div class="empty-radar">${t("emptyData")}</div>`;
    return;
  }
  const note = document.createElement("p");
  note.className = "chart-note";
  note.textContent = t("speedCoverage", {
    first: coverage.first_decision_days ?? state.journals.filter((journal) => number(journal.first_decision_days) !== null).length,
    review: coverage.review_time_days ?? state.journals.filter((journal) => number(journal.review_time_days) !== null).length,
    accept: coverage.submission_to_accept_days ?? state.journals.filter((journal) => number(journal.submission_to_accept_days) !== null).length,
    total: coverage.total ?? state.journals.length,
  });
  els.speedChart.append(note);

  const width = 640;
  const rowHeight = 38;
  const margin = { top: 22, right: 94, bottom: 16, left: 172 };
  const height = margin.top + margin.bottom + rows.length * rowHeight;
  const maxValue = Math.max(...rows.flatMap((journal) => [number(journal.first_decision_days), number(journal.review_time_days)]).filter((value) => value !== null), 1);
  const chart = svg(width, height);
  rows.forEach((journal, index) => {
    const y = margin.top + index * rowHeight;
    const label = svgNode("text", { x: margin.left - 10, y: y + 19, class: "bar-label", "text-anchor": "end" });
    const journalLabel = journal.abbreviation || journal.name;
    label.textContent = journalLabel.length > 21 ? `${journalLabel.slice(0, 20)}…` : journalLabel;
    chart.append(label);
    [
      ["first_decision_days", COLORS.coral, 0, t("firstDecision")],
      ["review_time_days", COLORS.blue, 15, t("reviewTime")],
    ].forEach(([field, color, offset, title]) => {
      const value = number(journal[field]);
      const yBar = y + offset + 4;
      if (value === null) {
        const missing = svgNode("text", { x: margin.left + 4, y: yBar + 11, class: "bar-label muted-label" });
        missing.textContent = t("pendingVerification");
        chart.append(missing);
        return;
      }
      const barWidth = Math.max(3, (value / maxValue) * (width - margin.left - margin.right));
      chart.append(svgNode("rect", { x: margin.left, y: yBar, width: barWidth, height: 10, rx: 5, fill: color }));
      const valueLabel = svgNode("text", { x: margin.left + barWidth + 6, y: yBar + 10, class: "bar-label" });
      valueLabel.textContent = `${title}: ${t("days", { value })}`;
      chart.append(valueLabel);
    });
  });
  els.speedChart.append(chart);
}

function renderPublisherChart(journals) {
  const rows = countBy(journals, "publisher_family")
    .slice(0, 10)
    .map(([label, value]) => ({ label, value, color: COLORS.green }));
  renderHorizontalBars(els.publisherChart, rows, { left: 154 });
}

function renderHeatmap(journals) {
  const mainTags = countBy(journals, "main_tag").slice(0, 10).map(([label]) => label);
  const secondaryTags = countBy(
    journals.map((journal) => ({ secondary_tag: journal.secondary_tag || t("noSecondary") })),
    "secondary_tag"
  )
    .slice(0, 9)
    .map(([label]) => label);
  const counts = new Map();
  journals.forEach((journal) => {
    const row = journal.main_tag || t("missing");
    const col = journal.secondary_tag || t("noSecondary");
    counts.set(`${row}|${col}`, (counts.get(`${row}|${col}`) || 0) + 1);
  });
  const maxValue = Math.max(...counts.values(), 1);
  els.heatmap.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "heatmap-grid";
  grid.style.gridTemplateColumns = `150px repeat(${secondaryTags.length}, minmax(82px, 1fr))`;
  grid.append(cell("heatmap-label", ""));
  secondaryTags.forEach((tag) => grid.append(cell("heatmap-label", tag)));
  mainTags.forEach((mainTag) => {
    grid.append(cell("heatmap-label", mainTag));
    secondaryTags.forEach((secondaryTag) => {
      const value = counts.get(`${mainTag}|${secondaryTag}`) || 0;
      const intensity = value / maxValue;
      const node = cell("heatmap-cell", value ? String(value) : "");
      node.style.background = value
        ? `rgba(37, 99, 168, ${0.16 + intensity * 0.62})`
        : "#f6f8f5";
      node.title = `${mainTag} / ${secondaryTag}: ${value}`;
      grid.append(node);
    });
  });
  els.heatmap.append(grid);
}

function cell(className, text) {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

function compactNetworkLinks(rawLinks) {
  const compacted = new Map();
  rawLinks.forEach((link) => {
    const source = link.source < link.target ? link.source : link.target;
    const target = link.source < link.target ? link.target : link.source;
    const key = `${source}|${target}|${link.relation || ""}`;
    const existing = compacted.get(key);
    if (!existing || (number(link.weight) || 1) > (number(existing.weight) || 1)) {
      compacted.set(key, link);
    }
  });
  return [...compacted.values()];
}

function limitNetworkLinks(rawLinks, expanded = false) {
  const deduped = compactNetworkLinks(rawLinks);
  const grouped = new Map();
  deduped.forEach((link) => {
    const journalId = String(link.source).startsWith("journal-") ? link.source : String(link.target).startsWith("journal-") ? link.target : "";
    if (!journalId) return;
    if (!grouped.has(journalId)) grouped.set(journalId, []);
    grouped.get(journalId).push(link);
  });
  const relationLimits = expanded
    ? { publisher: 1, jcr_tag: 1, text_topic: 4, method_or_theme: 2 }
    : { publisher: 1, jcr_tag: 1, text_topic: 2, method_or_theme: 1 };
  const kept = [];
  grouped.forEach((links) => {
    const buckets = new Map();
    links
      .sort((a, b) => (number(b.weight) || 1) - (number(a.weight) || 1))
      .forEach((link) => {
        const relation = link.relation || "other";
        if (!buckets.has(relation)) buckets.set(relation, []);
        buckets.get(relation).push(link);
      });
    Object.entries(relationLimits).forEach(([relation, limit]) => {
      kept.push(...(buckets.get(relation) || []).slice(0, limit));
    });
  });
  return kept;
}

function renderNetwork(journals) {
  clear(els.network);
  els.network.classList.toggle("is-expanded", state.networkExpanded);
  const hasActiveFilter =
    terms(els.search.value).length > 0 ||
    els.tag.value !== "all" ||
    els.quartile.value !== "all" ||
    els.publisher.value !== "all" ||
    els.speed.value !== "all";
  const visibleLimit = state.networkExpanded ? 32 : hasActiveFilter ? 20 : 12;
  const visibleJournalIds = new Set(journals.slice(0, visibleLimit).map((journal) => journal.id));
  const links = limitNetworkLinks(
    state.network.links.filter((link) => visibleJournalIds.has(link.source) || visibleJournalIds.has(link.target)),
    state.networkExpanded
  );
  const needed = new Set();
  links.forEach((link) => {
    needed.add(link.source);
    needed.add(link.target);
  });
  const nodes = state.network.nodes.filter((node) => needed.has(node.id));
  if (nodes.length === 0) {
    els.network.innerHTML = `<div class="empty-radar">${t("emptyNetwork")}</div>`;
    return;
  }

  const width = state.networkExpanded ? 1480 : 1280;
  const height = state.networkExpanded ? 1020 : 860;
  const chart = svg(width, height);
  const nodeMap = new Map(nodes.map((node) => [node.id, { ...node }]));
  const center = { x: width / 2, y: height / 2 };
  const typeAnchors = {
    journal: { x: width * 0.52, y: height * 0.60 },
    topic: { x: width * 0.50, y: height * 0.18 },
    publisher: { x: width * 0.16, y: height * 0.60 },
    method_or_theme: { x: width * 0.84, y: height * 0.66 },
  };

  [...nodeMap.values()].forEach((node, index) => {
    const anchor = typeAnchors[node.type] || center;
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    node.x = anchor.x + Math.cos(angle) * (node.type === "journal" ? 190 : 128);
    node.y = anchor.y + Math.sin(angle) * (node.type === "journal" ? 145 : 96);
    node.vx = 0;
    node.vy = 0;
  });

  const simLinks = links
    .map((link) => ({ ...link, sourceNode: nodeMap.get(link.source), targetNode: nodeMap.get(link.target) }))
    .filter((link) => link.sourceNode && link.targetNode);

  for (let tick = 0; tick < 230; tick += 1) {
    simLinks.forEach((link) => {
      const dx = link.targetNode.x - link.sourceNode.x;
      const dy = link.targetNode.y - link.sourceNode.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = link.relation === "publisher" ? 365 : link.relation === "method_or_theme" ? 335 : 300;
      const force = (distance - desired) * 0.00135 * Math.min(2, link.weight || 1);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      link.sourceNode.vx += fx;
      link.sourceNode.vy += fy;
      link.targetNode.vx -= fx;
      link.targetNode.vy -= fy;
    });

    const allNodes = [...nodeMap.values()];
    for (let i = 0; i < allNodes.length; i += 1) {
      for (let j = i + 1; j < allNodes.length; j += 1) {
        const a = allNodes[i];
        const b = allNodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(8, Math.hypot(dx, dy));
        if (distance > 340) continue;
        const force = 280 / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    allNodes.forEach((node) => {
      const anchor = typeAnchors[node.type] || center;
      const anchorStrength = node.type === "journal" ? 0.00135 : 0.0032;
      node.vx += (anchor.x - node.x) * anchorStrength;
      node.vy += (anchor.y - node.y) * anchorStrength;
      node.x = Math.max(56, Math.min(width - 56, node.x + node.vx));
      node.y = Math.max(56, Math.min(height - 56, node.y + node.vy));
      node.vx *= 0.7;
      node.vy *= 0.7;
    });
  }

  const journalLabelIds = new Set(
    [...nodeMap.values()]
      .filter((node) => node.type === "journal")
      .sort((a, b) => (number(b.jif) || 0) - (number(a.jif) || 0))
      .slice(0, state.networkExpanded ? 8 : 2)
      .map((node) => node.id)
  );
  const nodeStrength = new Map();
  simLinks.forEach((link) => {
    const weight = number(link.weight) || 1;
    nodeStrength.set(link.sourceNode.id, (nodeStrength.get(link.sourceNode.id) || 0) + weight);
    nodeStrength.set(link.targetNode.id, (nodeStrength.get(link.targetNode.id) || 0) + weight);
  });
  const nonJournalLabelIds = new Set(
    [...nodeMap.values()]
      .filter((node) => node.type !== "journal")
      .sort((a, b) => (nodeStrength.get(b.id) || 0) - (nodeStrength.get(a.id) || 0))
      .slice(0, state.networkExpanded ? 14 : 7)
      .map((node) => node.id)
  );

  simLinks.forEach((link) => {
    chart.append(
      svgNode("line", {
        x1: link.sourceNode.x,
        y1: link.sourceNode.y,
        x2: link.targetNode.x,
        y2: link.targetNode.y,
        class: "network-link",
        "stroke-width": Math.max(0.45, Math.min(state.networkExpanded ? 2.8 : 2.1, Math.sqrt(link.weight || 1))),
      })
    );
  });

  const placedLabels = [];
  [...nodeMap.values()].forEach((node) => {
    const radius = node.type === "journal" ? Math.max(4.6, Math.min(10.5, 4 + (number(node.jif) || 2) / 3.4)) : 8;
    const circle = svgNode("circle", {
      cx: node.x,
      cy: node.y,
      r: radius,
      fill: COLORS[node.type] || COLORS.muted,
      class: `network-node ${node.id === state.selectedJournalId ? "is-selected" : ""}`,
    });
    circle.append(svgNode("title"));
    circle.querySelector("title").textContent = node.label;
    if (node.type === "journal") {
      circle.addEventListener("click", () => navigateToJournal(node.id));
    }
    chart.append(circle);

    const shouldLabel =
      (node.type === "journal" && journalLabelIds.has(node.id)) ||
      node.type === "publisher" ||
      (node.type !== "journal" && nonJournalLabelIds.has(node.id));
    if (shouldLabel) {
      const limit = node.type === "journal" ? 26 : 30;
      const text = node.label.length > limit ? `${node.label.slice(0, limit - 1)}…` : node.label;
      const xPos = node.x + radius + 4;
      const yPos = node.y + 4;
      const box = {
        x: xPos,
        y: yPos - 13,
        width: Math.max(32, text.length * 6.8),
        height: 17,
      };
      const overlaps = placedLabels.some(
        (item) =>
          box.x < item.x + item.width &&
          box.x + box.width > item.x &&
          box.y < item.y + item.height &&
          box.y + box.height > item.y
      );
      if (overlaps) return;
      placedLabels.push(box);
      const label = svgNode("text", {
        x: xPos,
        y: yPos,
        class: "point-label",
      });
      label.textContent = text;
      chart.append(label);
    }
  });

  els.networkNote.textContent = t("networkSummary", { nodes: nodes.length, links: simLinks.length, limit: visibleLimit });
  if (els.networkToggle) els.networkToggle.textContent = state.networkExpanded ? t("collapseNetwork") : t("expandNetwork");
  els.network.append(chart);
}

function renderRecommendations(journals) {
  const top = journals.slice(0, 6);
  if (top.length === 0) {
    els.recommendations.innerHTML = `<div class="empty-radar">${t("noCandidates")}</div>`;
    return;
  }
  els.recommendations.innerHTML = top
    .map((journal, index) => {
      const speed = number(journal.first_decision_days) !== null ? t("decisionSpeed", { days: journal.first_decision_days }) : t("speedUnknown");
      const evidence = t("evidenceText", { pages: journal.source_pages_crawled || 0, articles: journal.article_count_crawled || 0 });
      const topics =
        termJoin(Object.keys(journal.article_preferences?.topic_counts || {}).slice(0, 3)) ||
        termJoin(Object.keys(journal.topic_hits || {}).slice(0, 3)) ||
        journal.tag_path;
      return `
        <article class="recommendation-item">
          <h4>${index + 1}. <button type="button" data-open-journal="${journal.id}">${escapeHtml(journal.name)}</button></h4>
          <div class="recommendation-meta">
            <span>${escapeHtml(journal.quartile || "JCR")}</span>
            <span>JIF ${fmt(journal.jif_2025)}</span>
            <span>JCI ${fmt(journal.jci_2025)}</span>
            <span>${escapeHtml(t("publicationVolume2025"))} ${escapeHtml(publicationLabel(journal, "2025"))}</span>
            <span>${escapeHtml(speed)}</span>
            <span>${escapeHtml(journal.publisher_family)}</span>
          </div>
          <p>${escapeHtml(t("matchClues", { topics, evidence }))}</p>
        </article>
      `;
    })
    .join("");
  els.recommendations.querySelectorAll("[data-open-journal]").forEach((button) => {
    button.addEventListener("click", () => navigateToJournal(button.dataset.openJournal));
  });
}

function renderTable(journals) {
  const rows = journals.slice(0, 120);
  els.tableMeta.textContent = t("tableMeta", { shown: rows.length, filtered: journals.length, total: state.journals.length });
  els.tableBody.innerHTML = rows
    .map(
      (journal) => `
        <tr>
          <td><button type="button" data-open-journal="${journal.id}">${escapeHtml(journal.name)}</button></td>
          <td>${escapeHtml(journal.quartile || t("missing"))} · ${escapeHtml(journal.tag_path || journal.main_tag || t("missing"))}</td>
          <td>${fmt(journal.jif_2025)}</td>
          <td>${fmt(journal.jci_2025)}</td>
          <td>${escapeHtml(publicationLabel(journal, "2025"))}</td>
          <td>${number(journal.first_decision_days) === null ? t("missing") : t("days", { value: journal.first_decision_days })}</td>
          <td>${escapeHtml(journal.publisher_family || journal.publisher || t("missing"))}</td>
          <td>${t("pagesArticles", { pages: journal.source_pages_crawled || 0, articles: journal.article_count_crawled || 0 })}</td>
        </tr>
      `
    )
    .join("");
  els.tableBody.querySelectorAll("[data-open-journal]").forEach((button) => {
    button.addEventListener("click", () => navigateToJournal(button.dataset.openJournal));
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function objectEntries(object = {}) {
  return Object.entries(object || {}).sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0], "zh-Hans-CN"));
}

function miniBars(object = {}, limit = 6) {
  const rows = objectEntries(object).slice(0, limit);
  if (rows.length === 0) return `<p class="drawer-muted">${t("insufficientPreference")}</p>`;
  const maxValue = Math.max(...rows.map(([, value]) => Number(value) || 0), 1);
  return `
    <div class="drawer-mini-bars">
      ${rows
        .map(([label, value]) => {
          const width = Math.max(6, (Number(value) / maxValue) * 100);
          return `
            <div class="mini-bar-row">
              <span>${escapeHtml(label)}</span>
              <i><b style="width:${width}%"></b></i>
              <em>${escapeHtml(value)}</em>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderPreferenceSection(journal) {
  const prefs = journal.article_preferences || {};
  const latest = prefs.latest_issue || {};
  const latestLabel = [latest.year, latest.volume ? `Vol. ${latest.volume}` : "", latest.issue ? `Issue ${latest.issue}` : ""]
    .filter(Boolean)
    .join(" · ");
  const yearly = (prefs.yearly_topics || [])
    .slice(0, 4)
    .map((row) => {
      const chips = objectEntries(row.topics || {})
        .slice(0, 4)
        .map(([label]) => `<span>${escapeHtml(label)}</span>`)
        .join("");
      return `<li><strong>${escapeHtml(row.year)}</strong>${chips || `<span>${t("insufficientTopics")}</span>`}</li>`;
    })
    .join("");
  const titles = (latest.sample_titles || [])
    .slice(0, 4)
    .map((title) => `<li>${escapeHtml(title)}</li>`)
    .join("");
  return `
    <section class="drawer-section">
      <h3>${t("preferenceTitle")}</h3>
      <p class="drawer-muted">${t("preferenceCopy", { count: prefs.article_sample_count || 0 })}</p>
      <div class="drawer-two-col">
        <div>
          <h4>${t("topicPreference")}</h4>
          ${miniBars(prefs.topic_counts, 7)}
        </div>
        <div>
          <h4>${t("methodPreference")}</h4>
          ${miniBars(prefs.method_counts, 5)}
        </div>
      </div>
      <div class="latest-issue-box">
        <strong>${t("latestIssue")}</strong>
        <p>${escapeHtml(t("latestIssueText", { label: latestLabel || t("noIssue"), count: latest.article_count || 0 }))}</p>
        ${miniBars(latest.top_topics, 5)}
        <ul class="drawer-list latest-title-list">${titles || `<li>${t("noLatestTitles")}</li>`}</ul>
      </div>
      <ul class="yearly-topic-list">${yearly || `<li><strong>${t("yearlyTrend")}</strong><span>${t("insufficientTopics")}</span></li>`}</ul>
    </section>
  `;
}

function renderEditorsSection(journal) {
  const editors = journal.editors || {};
  const chief = (editors.editors_in_chief || []).map((name) => `<li>${escapeHtml(name)}</li>`).join("");
  const associate = (editors.associate_editors || []).slice(0, 12).map((name) => `<li>${escapeHtml(name)}</li>`).join("");
  const source = editors.source_url
    ? `<p><a href="${escapeHtml(editors.source_url)}" target="_blank" rel="noreferrer">${t("editorSource")}</a></p>`
    : "";
  return `
    <section class="drawer-section">
      <h3>${t("editorsTitle")}</h3>
      <div class="drawer-two-col">
        <div>
          <h4>${t("editorChief")}</h4>
          <ul class="drawer-list">${chief || `<li>${t("notCaptured")}</li>`}</ul>
        </div>
        <div>
          <h4>${t("associateEditors")}</h4>
          <ul class="drawer-list">${associate || `<li>${t("notCaptured")}</li>`}</ul>
        </div>
      </div>
      <p class="drawer-muted">${escapeHtml(editors.note || t("editorNote"))}</p>
      ${source}
    </section>
  `;
}

function navigateToJournal(journalId) {
  if (!journalId) return;
  const hash = `#journal=${encodeURIComponent(journalId)}`;
  if (window.location.hash === hash) {
    renderRoute();
  } else {
    window.location.hash = hash;
  }
}

function scrollToPageTop() {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
}

function showDashboard() {
  state.selectedJournalId = "";
  els.dashboard.hidden = false;
  els.detailPage.hidden = true;
  if (els.detailContent) els.detailContent.innerHTML = "";
  renderNetwork(filteredJournals());
}

function renderRoute() {
  if (!state.ready) return;
  const match = window.location.hash.match(/^#journal=([^&]+)/);
  if (!match) {
    showDashboard();
    scrollToPageTop();
    return;
  }
  renderJournalDetail(decodeURIComponent(match[1]));
  scrollToPageTop();
}

function profileRows(journalId) {
  const record = state.editorProfilesByJournal.get(journalId);
  const profiles = record?.profiles || [];
  if (profiles.length > 0) return profiles;
  const journal = state.journals.find((item) => item.id === journalId);
  const editors = journal?.editors || {};
  const rows = [];
  (editors.editors_in_chief || []).forEach((name) => rows.push({ name, role: t("editorChief"), affiliation: "", country_or_region: "", verification_status: t("pendingVerification"), source_url: editors.source_url || "" }));
  (editors.associate_editors || []).forEach((name) => rows.push({ name, role: t("associateEditors"), affiliation: "", country_or_region: "", verification_status: t("pendingVerification"), source_url: editors.source_url || "" }));
  return rows;
}

function sourceListHtml(journal, sources) {
  const urls = journal.source_urls || [];
  const sourceLinks =
    urls
      .slice(0, 8)
      .map((url) => `<li><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></li>`)
      .join("") || `<li>${t("noSources")}</li>`;
  const sourceStatus =
    sources
      .slice(0, 10)
      .map(
        (source) => `
          <li>
            <span class="source-pill">${escapeHtml(source.status)}</span>
            ${escapeHtml(t("sourceChars", { type: source.source_type, chars: source.text_chars || 0 }))}
            ${source.error ? ` · ${escapeHtml(source.error)}` : ""}
          </li>
        `
      )
      .join("") || `<li>${t("noCrawl")}</li>`;
  return `
    <div class="detail-two-col">
      <section class="detail-card">
        <h3>${t("journalSources")}</h3>
        <ul class="drawer-list">${sourceLinks}</ul>
      </section>
      <section class="detail-card">
        <h3>${t("crawlStatus")}</h3>
        <ul class="drawer-list">${sourceStatus}</ul>
      </section>
    </div>
  `;
}

function renderEditorTable(journalId) {
  const rows = profileRows(journalId);
  if (rows.length === 0) return `<p class="drawer-muted">${t("notCaptured")}</p>`;
  const roles = unique(rows.map((profile) => profile.role));
  return `
    <label class="editor-role-filter">
      <span>${t("verification") === "Verification" ? "Role" : "角色"}</span>
      <select id="editorRoleFilter">
        <option value="all">${t("editorRoleAll")}</option>
        ${roles.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(role)}</option>`).join("")}
      </select>
    </label>
    <div class="editor-table-wrap">
      <table class="editor-table">
        <thead>
          <tr>
            <th>${t("colJournal") === "Journal" ? "Name" : "姓名"}</th>
            <th>${t("verification") === "Verification" ? "Role" : "角色"}</th>
            <th>${t("affiliation")}</th>
            <th>${t("countryOrRegion")}</th>
            <th>${t("verification")}</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (profile) => `
                <tr data-editor-role="${escapeHtml(profile.role || t("missing"))}">
                  <td>${escapeHtml(profile.name || t("missing"))}</td>
                  <td>${escapeHtml(profile.role || t("missing"))}</td>
                  <td>${escapeHtml(profile.affiliation || t("pendingVerification"))}</td>
                  <td>${escapeHtml(profile.country_or_region || t("pendingVerification"))}</td>
                  <td>${profile.source_url ? `<a href="${escapeHtml(profile.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(profile.verification_status || "public_source")}</a>` : escapeHtml(profile.verification_status || t("pendingVerification"))}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function timeSliceLabel(key) {
  if (key === "recent_3_issues") return t("recent3Issues");
  if (key === "all") return t("allYears");
  if (key === "latest_issue") return t("latestIssueFilter");
  if (key === "rolling_1y") return t("last1Year");
  if (key === "rolling_2y") return t("last2Years");
  if (key === "rolling_3y") return t("last3Years");
  if (key === "rolling_5y") return t("last5Years");
  return key;
}

function preferredTimeSlice(preference) {
  const slices = preference?.slices || {};
  return ["recent_3_issues", "rolling_1y", "latest_issue", "all"].find((key) => (slices[key]?.sample_count || 0) > 0) || "all";
}

function localizedRangeDescription(description) {
  const text = String(description || "");
  if (state.language !== "zh") return text;
  return text
    .replaceAll("All captured samples", "全部已抓取样本")
    .replace(/latest (\d+)\/(\d+) samples \(limited time spread\)/g, "最近 $1/$2 篇样本")
    .replace(/(\d+) articles/g, "$1 篇文章");
}

function rangeMetaText(slice, key) {
  const count = slice?.sample_count || 0;
  const description = localizedRangeDescription(slice?.description || timeSliceLabel(key));
  const fallbackLabels = {
    recent_sample_depth: t("sampleDepthFallback"),
    month_approximation: t("issueMonthFallback"),
  };
  const note = slice?.fallback_mode ? ` · ${fallbackLabels[slice.fallback_mode] || t("sampleDepthFallback")}` : "";
  return `${t("rangeSampleMeta", { count, description })}${note}`;
}

function latestIssueSummary(preference) {
  const latest = preference?.latest_issue || {};
  const latestSlice = preference?.slices?.latest_issue || {};
  const fallbackLabels = {
    month_approximation: t("issueMonthFallback"),
    recent_sample_depth: t("sampleDepthFallback"),
  };
  const rawDescription =
    latest.description ||
    latestSlice.description ||
    [latest.year, latest.volume ? `Vol. ${latest.volume}` : "", latest.issue ? `Issue ${latest.issue}` : ""]
      .filter(Boolean)
      .join(" · ");
  const label = localizedRangeDescription(rawDescription) || t("noIssue");
  const fallbackMode = latest.fallback_mode || latestSlice.fallback_mode;
  const note = fallbackMode ? ` · ${fallbackLabels[fallbackMode] || t("sampleDepthFallback")}` : "";
  return `${label}${note}`;
}

function collectEvidence(items = [], limit = 8) {
  const seen = new Set();
  const evidence = [];
  items.forEach((item) => {
    (item.evidence || []).forEach((entry) => {
      const key = entry.doi || entry.url || entry.title;
      if (!key || seen.has(key)) return;
      seen.add(key);
      evidence.push(entry);
    });
  });
  return evidence.slice(0, limit);
}

function evidenceListHtml(evidence = []) {
  if (evidence.length === 0) return `<div class="empty-radar">${t("noLatestTitles")}</div>`;
  return `
    <ul class="article-sample-list">
      ${evidence
        .map((entry) => {
          const title = escapeHtml(entry.title || t("missing"));
          const meta = [entry.year, entry.volume ? `Vol. ${entry.volume}` : "", entry.issue ? `Issue ${entry.issue}` : ""].filter(Boolean).join(" · ");
          const link = entry.url ? `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer">${title}</a>` : title;
          return `<li>${link}${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</li>`;
        })
        .join("")}
    </ul>
  `;
}

function latestArticleList(preference) {
  const slice = preference?.slices?.latest_issue || preference?.slices?.all;
  if (!slice || slice.sample_count === 0) return `<div class="empty-radar">${t("noLatestTitles")}</div>`;
  const evidence = collectEvidence([...(slice.general || []), ...(slice.specific || []), ...(slice.very_specific || [])], 10);
  return evidenceListHtml(evidence);
}

function renderThemeEvidence(item, animate = true) {
  const box = els.detailContent.querySelector("#themeEvidence");
  if (!box) return;
  box.classList.remove("is-refreshing", "is-switching");
  const evidence = item ? item.evidence || [] : [];
  box.innerHTML = `
    <h4>${t("themeEvidence")}${item ? ` · ${escapeHtml(item.label)}` : ""}</h4>
    ${evidenceListHtml(evidence.slice(0, 8))}
  `;
  if (animate) {
    window.requestAnimationFrame(() => box.classList.add("is-refreshing"));
  }
}

function renderThemeMap(journalId, sliceKey = "all", options = {}) {
  const container = els.detailContent.querySelector("#journalThemeMap");
  if (!container) return;
  const shouldAnimate = options.animate !== false;
  const previousHeight = container.offsetHeight;
  if (previousHeight) container.style.minHeight = `${previousHeight}px`;
  container.setAttribute("aria-busy", "true");
  container.classList.remove("is-refreshing", "is-switching");
  const preference = state.preferencesByJournal.get(journalId);
  const slice = preference?.slices?.[sliceKey] || (sliceKey === "all" ? preference?.slices?.all : null);
  const meta = els.detailContent.querySelector("#themeRangeMeta");
  if (meta) {
    meta.classList.remove("is-refreshing", "is-switching");
    meta.textContent = rangeMetaText(slice, sliceKey);
    if (shouldAnimate) window.requestAnimationFrame(() => meta.classList.add("is-refreshing"));
  }
  if (!slice || slice.sample_count === 0) {
    container.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty-radar";
    empty.textContent = t("noPreferenceData");
    container.append(empty);
    renderThemeEvidence(null, shouldAnimate);
    if (shouldAnimate) {
      window.requestAnimationFrame(() => container.classList.add("is-refreshing"));
    }
    container.removeAttribute("aria-busy");
    window.setTimeout(() => {
      container.style.minHeight = "";
    }, 320);
    return;
  }

  const levels = [
    { key: "general", label: t("generalLevel"), color: COLORS.gold },
    { key: "specific", label: t("specificLevel"), color: COLORS.green },
    { key: "very_specific", label: t("verySpecificLevel"), color: COLORS.coral },
  ];
  const board = document.createElement("div");
  board.className = "theme-bar-board";

  levels.forEach((level, levelIndex) => {
    const panel = document.createElement("section");
    panel.className = "theme-bar-panel";
    panel.style.setProperty("--panel-index", levelIndex);
    panel.style.setProperty("--accent", level.color);
    panel.style.setProperty("--accent-soft", `${level.color}22`);
    panel.innerHTML = `
      <div class="theme-bar-panel-head">
        <span>${escapeHtml(level.label)}</span>
        <small>${level.key === "very_specific" ? "micro signals" : level.key}</small>
      </div>
    `;
    const list = document.createElement("div");
    list.className = "theme-bar-list";
    const items = (slice[level.key] || []).slice(0, level.key === "very_specific" ? 8 : 7);
    if (items.length === 0) {
      list.innerHTML = `<div class="empty-radar">${t("insufficientTopics")}</div>`;
      panel.append(list);
      board.append(panel);
      return;
    }
    const maxValue = Math.max(...items.map((item) => Number(item.value) || 1), 1);
    items.forEach((item, index) => {
      const value = Number(item.value) || 0;
      const width = Math.max(10, Math.round((value / maxValue) * 100));
      const evidenceCount = (item.evidence || []).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "theme-bar-row";
      button.style.setProperty("--bar-width", `${width}%`);
      button.style.setProperty("--row-index", index);
      button.innerHTML = `
        <span class="theme-bar-label">${escapeHtml(item.label)}</span>
        <span class="theme-bar-track"><i></i></span>
        <span class="theme-bar-value">${escapeHtml(value)}</span>
        <span class="theme-bar-evidence">${escapeHtml(evidenceCount)} refs</span>
      `;
      button.addEventListener("click", () => renderThemeEvidence(item));
      list.append(button);
    });
    panel.append(list);
    board.append(panel);
  });
  container.replaceChildren(board);
  const firstItem = [...(slice.general || []), ...(slice.specific || []), ...(slice.very_specific || [])][0];
  if (!container.querySelector(".theme-bar-row")) {
    renderThemeEvidence(null, shouldAnimate);
  } else {
    renderThemeEvidence(firstItem || null, shouldAnimate);
  }
  if (shouldAnimate) {
    window.requestAnimationFrame(() => container.classList.add("is-refreshing"));
  }
  container.removeAttribute("aria-busy");
  window.setTimeout(() => {
    container.style.minHeight = "";
  }, 360);
}

function sourceUrlMeta(url) {
  const lower = String(url || "").toLowerCase();
  if (/submission-guidelines|guide-for-authors|author-guidelines|instructions-for-authors|for-authors|submit|manuscript/.test(lower)) {
    return { label: t("submissionGuidelines"), priority: 1 };
  }
  if (/how-to-publish|publish-with-us|author-information|author-services|authors/.test(lower)) {
    return { label: t("authorInfo"), priority: 2 };
  }
  if (/metrics|journal-metrics|about|aims|scope/.test(lower)) {
    return { label: t("journalMetrics"), priority: 3 };
  }
  if (/\/article\/|doi\.org|\/content\//.test(lower)) {
    return { label: t("articleSample"), priority: 5 };
  }
  return { label: t("journalHomepage"), priority: 4 };
}

function requirementLinksHtml(journal) {
  const seen = new Set();
  const links = (journal.source_urls || [])
    .map((url) => ({ url, ...sourceUrlMeta(url) }))
    .filter((item) => {
      if (!item.url || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 5);

  if (!links.length) return `<div class="requirement-empty">${t("noRequirementLinks")}</div>`;
  return `
    <div class="requirement-links">
      ${links
        .map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.label)}</a>`)
        .join("")}
    </div>
  `;
}

function requirementItemHtml(label, value, options = {}) {
  const className = ["requirement-item", options.wide ? "is-wide" : "", options.compact ? "is-compact" : ""].filter(Boolean).join(" ");
  const displayValue = value ? escapeHtml(value) : t("pendingVerification");
  return `
    <div class="${className}">
      <span>${escapeHtml(label)}</span>
      <strong>${displayValue}</strong>
    </div>
  `;
}

function submissionRequirementsHtml(journal, dayValue) {
  return `
    <div class="submission-requirements">
      <div class="requirement-block">
        <div class="requirement-block-title">
          <span>${t("speedAndWorkflow")}</span>
          <small>${t("officialVerificationNote")}</small>
        </div>
        <div class="requirement-grid">
          ${requirementItemHtml(t("firstDecision"), dayValue(journal.first_decision_days), { compact: true })}
          ${requirementItemHtml(t("reviewTime"), dayValue(journal.review_time_days), { compact: true })}
          ${requirementItemHtml(t("acceptanceTime"), dayValue(journal.submission_to_accept_days), { compact: true })}
          ${requirementItemHtml(t("submissionSystem"), journal.submission_system || "", { compact: true })}
        </div>
      </div>
      <div class="requirement-block">
        <div class="requirement-block-title">
          <span>${t("manuscriptRequirements")}</span>
        </div>
        <div class="requirement-grid">
          ${requirementItemHtml(t("manuscriptLength"), journal.word_limit || "", { wide: true })}
        </div>
      </div>
      <div class="requirement-block">
        <div class="requirement-block-title">
          <span>${t("publicationTrend")}</span>
          <small>${t("publicationTrendNote")}</small>
        </div>
        ${publicationTrendHtml(journal)}
      </div>
      <div class="requirement-block">
        <div class="requirement-block-title">
          <span>${t("keySubmissionSources")}</span>
        </div>
        ${requirementLinksHtml(journal)}
      </div>
    </div>
  `;
}

function publicationTrendHtml(journal) {
  const series = publicationSeries(journal);
  if (!series.length) return `<div class="requirement-empty">${t("noPublicationVolume")}</div>`;
  const maxValue = Math.max(...series.map((item) => item.value), 1);
  return `
    <div class="publication-trend">
      ${series
        .map((item) => {
          const height = Math.max(14, Math.round((item.value / maxValue) * 68));
          return `
            <div class="publication-trend-item">
              <span>${escapeHtml(t("publicationsCount", { value: item.value }))}</span>
              <i style="height:${height}px"></i>
              <b>${escapeHtml(item.year)}</b>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function topicCluesHtml(topicClues) {
  const items = String(topicClues || "")
    .split(state.language === "zh" ? "、" : ",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (!items.length) return `<p>${t("noExtraTopic")}.</p>`;
  return `
    <div class="topic-clue-list">
      ${items.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
    </div>
  `;
}

function latestIssueSignalHtml(preference) {
  const latestCount = preference?.slices?.latest_issue?.sample_count || 0;
  const allCount = preference?.slices?.all?.sample_count || 0;
  const latestLabel = latestIssueSummary(preference);
  return `
    <div class="latest-signal">
      <div class="latest-signal-main">${escapeHtml(latestLabel)}</div>
      <div class="latest-signal-stats">
        <span>${escapeHtml(t("rangeSampleMeta", { count: latestCount, description: t("latestIssue") }))}</span>
        <span>${escapeHtml(t("rangeSampleMeta", { count: allCount, description: t("allYears") }))}</span>
      </div>
    </div>
  `;
}

function renderThemeMapSlice(journalId, sliceKey) {
  const container = els.detailContent.querySelector("#journalThemeMap");
  const evidence = els.detailContent.querySelector("#themeEvidence");
  const meta = els.detailContent.querySelector("#themeRangeMeta");
  window.clearTimeout(state.themeRenderTimer);
  container?.classList.remove("is-refreshing");
  evidence?.classList.remove("is-refreshing");
  meta?.classList.remove("is-refreshing");
  container?.classList.add("is-switching");
  evidence?.classList.add("is-switching");
  meta?.classList.add("is-switching");
  state.themeRenderTimer = window.setTimeout(() => {
    renderThemeMap(journalId, sliceKey, { animate: true });
  }, 90);
}

function renderJournalDetail(journalId) {
  const journal = state.journals.find((item) => item.id === journalId);
  if (!journal) {
    showDashboard();
    return;
  }
  state.selectedJournalId = journalId;
  els.dashboard.hidden = true;
  els.detailPage.hidden = false;
  const sources = state.sourcesByJournal.get(journalId) || [];
  const preference = state.preferencesByJournal.get(journalId);
  const defaultTimeSlice = preferredTimeSlice(preference);
  const dayValue = (value) => (number(value) === null ? t("pendingVerification") : t("days", { value }));
  const topicClues =
    termJoin(Object.keys(journal.topic_hits || {}).slice(0, 8)) ||
    journal.tag_path ||
    t("noExtraTopic");
  els.detailContent.innerHTML = `
    <section class="detail-hero">
      <button class="button button-secondary" type="button" data-back-to-radar>${t("backToRadar")}</button>
      <p class="eyebrow">${t("journalDetail")}</p>
      <h2>${escapeHtml(journal.name)}</h2>
      <div class="recommendation-meta detail-meta">
        <span>${escapeHtml(journal.quartile || "JCR")}</span>
        <span>JIF ${fmt(journal.jif_2025)}</span>
        <span>JCI ${fmt(journal.jci_2025)}</span>
        <span>${escapeHtml(t("publicationVolume2025"))} ${escapeHtml(publicationLabel(journal, "2025"))}</span>
        <span>${escapeHtml(journal.main_tag || t("missing"))}</span>
        <span>${escapeHtml(journal.publisher_family || t("missing"))}</span>
      </div>
    </section>
    <section class="detail-grid detail-grid-submission">
      <article class="detail-card submission-requirements-card">
        <h3>${t("submissionSpeed")}</h3>
        ${submissionRequirementsHtml(journal, dayValue)}
      </article>
      <article class="detail-card topic-clues-card">
        <h3>${t("topicPositioning")}</h3>
        <p>${t("topicNetworkClues")}</p>
        ${topicCluesHtml(topicClues)}
      </article>
      <article class="detail-card latest-signal-card">
        <h3>${t("latestIssue")}</h3>
        ${latestIssueSignalHtml(preference)}
      </article>
    </section>
    <section class="detail-card theme-map-card">
      <div class="detail-card-header">
        <div>
          <h3>${t("themeMapTitle")}</h3>
          <p>${t("themeMapCopy")}</p>
        </div>
        <label class="time-slice-control">
          <span>${t("timeSlice")}</span>
          <select id="themeTimeSlice">
            ${TIME_RANGE_OPTIONS.map((key) => `<option value="${escapeHtml(key)}" ${key === defaultTimeSlice ? "selected" : ""}>${escapeHtml(timeSliceLabel(key))}</option>`).join("")}
          </select>
          <small id="themeRangeMeta" class="time-slice-meta"></small>
        </label>
      </div>
      <div class="theme-map-shell" id="journalThemeMap"></div>
      <div class="theme-evidence" id="themeEvidence">${t("noThemeEvidence")}</div>
    </section>
    <section class="detail-card">
      <h3>${t("latestArticles")}</h3>
      ${latestArticleList(preference)}
    </section>
    <section class="detail-card">
      <h3>${t("editorsTitle")}</h3>
      ${renderEditorTable(journalId)}
    </section>
    ${sourceListHtml(journal, sources)}
    <section class="detail-card">
      <h3>${t("askAiAboutJournal")}</h3>
      <button class="button button-primary" type="button" data-ask-about-journal>${t("askAiAboutJournal")}</button>
    </section>
  `;
  els.detailContent.querySelector("[data-back-to-radar]")?.addEventListener("click", () => {
    history.pushState("", document.title, window.location.pathname + window.location.search);
    renderRoute();
  });
  els.detailContent.querySelector("[data-ask-about-journal]")?.addEventListener("click", () => {
    history.pushState("", document.title, window.location.pathname + window.location.search);
    renderRoute();
    els.chatQuestion.value = state.language === "zh"
      ? `请根据雷达资料分析 ${journal.name} 是否适合我的论文，并说明匹配理由、风险和需要回官网确认的信息。`
      : `Using the radar evidence, assess whether ${journal.name} fits my manuscript. Explain fit, risks, and what I should verify on the journal website.`;
    els.chatQuestion.focus();
  });
  const sliceSelect = els.detailContent.querySelector("#themeTimeSlice");
  sliceSelect?.addEventListener("change", () => renderThemeMapSlice(journalId, sliceSelect.value));
  const editorRoleFilter = els.detailContent.querySelector("#editorRoleFilter");
  editorRoleFilter?.addEventListener("change", () => {
    els.detailContent.querySelectorAll("[data-editor-role]").forEach((row) => {
      row.hidden = editorRoleFilter.value !== "all" && row.dataset.editorRole !== editorRoleFilter.value;
    });
  });
  renderThemeMap(journalId, sliceSelect?.value || defaultTimeSlice, { animate: false });
  renderNetwork(filteredJournals());
}

function renderAll() {
  const journals = filteredJournals();
  renderKpis(journals);
  renderScatter(journals);
  renderSpeedChart(journals);
  renderPublisherChart(journals);
  renderHeatmap(journals);
  renderNetwork(journals);
  renderRecommendations(journals);
  renderTable(journals);
}

function downloadVisibleCsv() {
  const journals = filteredJournals();
  const headers = ["name", "quartile", "main_tag", "secondary_tag", "jif_2025", "jci_2025", "publications_2022", "publications_2023", "publications_2024", "publications_2025", "first_decision_days", "publisher_family", "source_url"];
  const lines = [
    headers.join(","),
    ...journals.map((journal) =>
      headers
        .map((field) => {
          const publicationMatch = field.match(/^publications_(\d{4})$/);
          const value = publicationMatch
            ? journal.publications?.[publicationMatch[1]] ?? ""
            : field === "source_url"
              ? (journal.source_urls || [])[0] || ""
              : journal[field] ?? "";
          return `"${String(value).replaceAll('"', '""')}"`;
        })
        .join(",")
    ),
  ];
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = t("csvName");
  link.click();
  URL.revokeObjectURL(link.href);
}

async function submitChat(event) {
  event.preventDefault();
  els.chatAnswer.dataset.idle = "false";
  const apiBase = String(state.config.api_base_url || "").replace(/\/+$/, "");
  if (!apiBase) {
    els.chatAnswer.textContent = t("apiMissing");
    return;
  }
  const question = els.chatQuestion.value.trim();
  if (!question) {
    els.chatAnswer.textContent = t("questionMissing");
    return;
  }
  const accessCode = state.accessRequired ? els.chatCode.value.trim() : "";
  if (state.accessRequired && !accessCode) {
    markAccessCodeInvalid(true);
    els.chatCode.focus();
    els.chatAnswer.textContent = t("accessMissing");
    return;
  }
  markAccessCodeInvalid(false);
  els.chatAnswer.textContent = t("chatWorking");
  try {
    const body = {
      question,
      top_k: 8,
    };
    if (accessCode) body.access_code = accessCode;
    const response = await fetch(`${apiBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.accessRequired) markAccessCodeInvalid(true);
      els.chatAnswer.textContent = chatErrorMessage(response.status, data);
      return;
    }
    if (state.accessRequired) rememberAccessCode(accessCode);
    const sources = (data.sources || [])
      .map((source, index) => `${index + 1}. ${source.journal_name || source.title}\n   ${source.source_url || ""}`)
      .join("\n");
    const modelLine = data.provider || data.model ? `\n${t("modelUsed", { provider: data.provider || t("missing"), model: data.model || t("missing") })}` : "";
    els.chatAnswer.textContent = `${data.answer || t("noAnswer")}\n\n${quotaMessage(data.remaining_quota, data.remaining_total_quota)}${modelLine}\n\n${t("sources")}\n${sources || t("noSourcesShort")}`;
  } catch (error) {
    els.chatAnswer.textContent = t("backendUnreachable");
  }
}

async function init() {
  applyTranslations();
  try {
    const [journals, sources, network, report, config, preferences, editorProfiles] = await Promise.all([
      fetchJson(RADAR_URLS.journals),
      fetchJson(RADAR_URLS.sources),
      fetchJson(RADAR_URLS.network),
      fetchJson(RADAR_URLS.report),
      fetchJson(RADAR_URLS.config),
      fetchJson(RADAR_URLS.preferences),
      fetchJson(RADAR_URLS.editorProfiles),
    ]);
    state.journals = journals;
    state.network = network;
    state.report = report;
    state.config = config || { api_base_url: "" };
    updateAccessMode((state.config.access_mode || "") === "semi_public_code");
    if (state.accessRequired && els.chatCode && !els.chatCode.value) {
      els.chatCode.value = storedAccessCode();
    }
    state.preferencesByJournal = new Map((preferences || []).map((record) => [record.journal_id, record]));
    state.editorProfilesByJournal = new Map((editorProfiles || []).map((record) => [record.journal_id, record]));
    sources.forEach((source) => {
      if (!state.sourcesByJournal.has(source.journal_id)) state.sourcesByJournal.set(source.journal_id, []);
      state.sourcesByJournal.get(source.journal_id).push(source);
    });

    refreshFilters();
    updateChatStatus();
    state.ready = true;
    renderAll();
    renderRoute();
  } catch (error) {
    document.querySelector(".radar-main").innerHTML = `<section class="empty-radar">${escapeHtml(t("loadFailed", { message: error.message }))}</section>`;
  }
}

[els.search, els.tag, els.quartile, els.publisher, els.speed].forEach((control) => {
  control.addEventListener("input", renderAll);
  control.addEventListener("change", renderAll);
});
if (els.language) {
  els.language.addEventListener("change", () => {
    state.language = els.language.value;
    localStorage.setItem("ajr-language", state.language);
    applyTranslations();
    refreshFilters();
    updateChatStatus();
    renderAll();
    renderRoute();
  });
}
els.networkToggle?.addEventListener("click", () => {
  state.networkExpanded = !state.networkExpanded;
  renderNetwork(filteredJournals());
});
els.download.addEventListener("click", downloadVisibleCsv);
els.chatForm.addEventListener("submit", submitChat);
els.chatCode?.addEventListener("input", () => markAccessCodeInvalid(false));
document.querySelectorAll("[data-example-zh]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = state.language === "en" ? "exampleEn" : "exampleZh";
    els.chatQuestion.value = button.dataset[key] || button.dataset.exampleZh || "";
    els.chatQuestion.focus();
  });
});
window.addEventListener("resize", () => {
  if (state.ready) renderNetwork(filteredJournals());
});
window.addEventListener("hashchange", renderRoute);

init();
