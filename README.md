# AIED Journal Radar

AIED Journal Radar 面向中英文教育及教育相关期刊的投稿定位、主题网络、近期文章样本和 AI 证据辅助选刊。目录由原 JCR 工作簿与可核验的公开教育期刊目录合并；公开目录收录不等于 JCR 收录、质量评级或仍在接收投稿。

在线地址：

```text
https://jojo-edtech.github.io/aied-journal/
```

## 本地预览

可以直接双击 `index.html` 浏览期刊、图表和主题偏好。首次下载源码或手动更新 JSON 后，先运行一次：

```bash
npm run prepare:local
```

它将首页所需的公开索引打包为 `data/radar/local-data.js`，各刊偏好详情另存为按需加载的 JS 分片，供源码目录中的 `file://` 预览使用。打包文件不进入 Git；静态构建和 npm 数据更新命令会自动重新生成。HTTP(S) 网页读取 JSON 与按刊分片，发布用 `dist/` 不复制这些离线 JS 数据包，避免重复发布整份数据。发布 JSON 仅移除排版空白；构建超过 900 MB 时会停止部署并保留源数据及现有线上版本。历史样本会持续累积，达到预算前需审核归档或保留策略；单次抓取条数不是历史保留上限。

本地文件模式不调用 AI API，页面提供在线 AI 助手入口。需要通过本地 HTTP 地址预览时，在项目目录运行：

```bash
npm run build:static
python3 -m http.server 4183 --bind 127.0.0.1 --directory dist
```

打开：

```text
http://localhost:4183
```

## 数据

静态公开数据在 `data/radar/`：

- `journals.json`：合并后的全量期刊，包含语言、其他刊名/分版、现用及历史 ISSN 和目录来源。
- `journals_q1.json`：保留原 JCR 工作簿 Q1 字段的子集；未核验指标不参与 JIF/JCI 中位数与散点图。
- `journal_sources.json`：公开目录来源及官网、投稿指南、metrics、编辑页抓取状态。
- `research_network.json`：期刊、主题、出版社、方法/主题网络。
- `journal_articles_index.json` 与 `journal_articles/*.jsonl`：按刊保存的近年文章公开元数据样本。
- `journal_preferences_index.json` 与 `journal_preferences/*.json`：偏好摘要与按需加载详情。
- `rag_documents_index.json` 与 `rag_documents/*.jsonl`：后端检索使用的公开证据片段。
- `data-manifest.json`：共同数据版本与数量，用于避免混用新旧索引。
- `crawl_report.json`：数量校验、字段缺失率、抓取状态和编辑团队覆盖情况。
- `radar-config.json`：公开 API 地址配置，不包含密钥。
- `source_workbook_snapshot.json`：从本地 Excel 生成的公开源表快照，供 GitHub Actions 在无法访问本机桌面文件时继续刷新。

目录来源与合并审计在 `data/catalog/`，静态发布仅包含前端和检索需要的公开文件。扩充采用以下来源：

- [DOAJ 官方 CSV](https://doaj.org/csv)：纳入 Education 学科分支；另从该分支之外，按原始 `Journal title` 中的整词 `education`、`educational`、`teaching`、`pedagogy` 或 `didactics` 定位跨学科教育期刊，匹配不区分大小写，不扩展到别名或关键词。两种选择方式共用 `doaj` 来源，分别记录 `selection_basis=education_subject_branch` 与 `selection_basis=title_keyword_outside_education_branch`；后者保留原学科分类，并标注 `education_scope=interdisciplinary_title_derived`。记录中的 `selection_evidence` 保存标题、原学科、命中词、选择规则和 DOAJ 记录链接。已有更名续刊与会议系列排除规则继续适用。
- [EBSCO Education Source](https://about.ebsco.com/m/ee/Marketing/titleLists/eue-subject.htm)：Education / Academic Journal 记录。
- [国家哲学社会科学文献中心](https://www.ncpssd.org/journal/list?page=1&t=1&langType=1&clazz=C%3DG4%2CG5%2CG6%2CG7)：中文教育目录。

来源间重叠以 ISSN 和可核验的沿革证据合并；同名但 ISSN 不同的期刊保留为不同记录，原 JCR 期刊 ID 和指标保留。DOAJ 元数据按其 [CC0 条款](https://doaj.org/terms/) 使用。期刊总数随目录与身份核对更新，以 `data/radar/data-manifest.json` 的 `journal_count` 和页面显示为准。

这是一组公开目录的可追溯并集，不是全球教育期刊全集，也不是所有仍在接收投稿期刊的清单。标题命中只说明本目录的教育相关选择依据，不能据此推断当前出版或收稿状态。国家哲社目录含综合性高校学报，记录会标注教育相关范围；目录未提供的语言、出版状态与 JCR 指标不作推断。“未核验 JCR”不代表已确认未被 JCR 收录。来源目录快照需人工核对后更新；日常自动更新刷新文章与官网证据，不自动宣称目录已覆盖所有新刊。

从已保存来源重新构建目录：

```bash
python3 scripts/build-education-catalog.py
npm run check:catalog
```

文章偏好是当前抓取样本的描述，不是期刊全部发表内容或录用概率。新刊首次抓取每个 ISSN 至多 40 条近五年 Crossref 记录；原有样本保留。无可用文章数据的期刊仍进入检索与数量统计，详情明确显示样本不足。

重新生成：

```bash
npm run radar:generate
```

快速从工作簿/快照生成，不深爬官网：

```bash
npm run radar:generate:quick
```

校验与构建：

```bash
npm run validate:data
npm run check:pipeline
npm run check:catalog-ui
npm run check:worker
npm run build:static
npm run check:data-loader
```

## ModelScope AI 后端

Python 后端在 `research_radar_api/`，Cloudflare Worker 版本在 `journal_worker/`。GitHub Pages 只调用 `radar-config.json` 配置的公开 API 地址；ModelScope / DeepSeek token、访问口令、限额和日志不得进入 GitHub、前端 JS、JSON 或浏览器。Pages 发布与 Worker 发布相互独立，修改 Worker 后需在其目录运行 `npx wrangler deploy`，并核对 `/api/health` 的期刊数和 `data_version` 与站点一致。

服务器环境变量：

```text
RADAR_LLM_PROVIDER=modelscope
MODELSCOPE_API_KEY=你的魔搭 API token
MODELSCOPE_MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507
RADAR_REQUIRE_ACCESS_CODE=true
RADAR_ACCESS_CODE=
RADAR_ENABLE_API_DOCS=false
RAG_DAILY_LIMIT=60
RAG_TOTAL_LIMIT=1990
RADAR_RATE_LIMIT_PER_MIN=6
RADAR_MAX_RATE_LIMIT_CLIENTS=5000
RADAR_MAX_LLM_RESPONSE_BYTES=4194304
RADAR_MAX_BODY_BYTES=65536
ALLOWED_ORIGIN=https://jojo-edtech.github.io,http://localhost:4183
RADAR_DATA_DIR=/path/to/aied-journal/data/radar
RADAR_QUOTA_FILE=/var/tmp/aied-journal-quota.json
RADAR_PROVIDER_QUOTA_FILE=/var/tmp/aied-journal-provider-quota.json
```

默认模型 `Qwen/Qwen3-30B-A3B-Instruct-2507` 已通过魔搭 OpenAI-compatible API 实测可返回。更小的 Qwen/Qwen2.5 候选在当前 API 下返回 `no provider supported` 或空响应，因此不作为默认模型。若你在魔搭后台发现其他支持 API-Inference 的快速模型额度可用，可只改 `MODELSCOPE_MODEL`。

额度保护：当前服务器使用访问口令，并在调用模型前预留一次额度，避免并发请求突破每日额度和 1990 次总额度；即使上游调用失败，该次预留仍会计入安全上限。Cloudflare Worker 版本另按匿名浏览器访客隔离个人额度。如果魔搭返回额度耗尽或限流信号，后端会标记当天已熔断，当天后续请求直接停止调用模型。

隐私边界：AI 请求是 stateless 的。后端不保存聊天记录，不提供历史记录接口；额度计数只保存匿名哈希/随机访客 ID 的数字计数，不保存问题、回答或来源文本。

## 自动更新

`.github/workflows/daily-research-radar-update.yml` 每天香港/北京时间 06:00 自动运行：

- 从完整目录中按持久游标每天轮换最多 500 本期刊的 Crossref 文章元数据，每刊默认最多 40 条，再计算 Latest issue、近 3 期、近 1/2/3/5 年样本主题与关键词。大目录不会每天全部重新抓取。
- 每天轮换深爬最多 80 本期刊的公开官网页面；请求受总时间预算约束。未轮到、失败或空返回的期刊保留历史样本及其真实采集日期，报告分别列出已更新、失败、延期和保留数量。
- 重新生成期刊网络、RAG 文档和抓取报告，通过数据校验后提交到 `main`；每日刷新任务成功结束后，Pages 工作流自动读取最新 `main` 并发布。
- 有明确卷期号时，Latest issue 严格按 `year + volume + issue` 识别；仅在没有 issue 元数据的连续出版期刊中使用月份近似，并在数据中标注 fallback。

官网深爬只使用公开可访问页面；被登录、付费墙、反爬或动态页面拦截时记录失败原因。ModelScope token、AI 额度文件和访问配置不参与 GitHub Actions，也不会写入公开数据。
