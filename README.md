# AIED Journal Radar

AIED Journal Radar 是一个独立的研究导向选刊网站，不属于教学案例站 AIED Case Hub。它面向教育学 JCR 期刊的投稿定位、主题网络理解、latest issue 偏好观察和 RAG 证据辅助选刊。

规划的 GitHub Pages 地址：

```text
https://jojo-edtech.github.io/aied-journal/
```

## 本地预览

```bash
python3 -m http.server 4183
```

打开：

```text
http://localhost:4183
```

## 数据

静态公开数据在 `data/radar/`：

- `journals.json`：全量 268 本教育学 JCR 期刊。
- `journals_q1.json`：135 本 Q1 子集。
- `journal_sources.json`：官网、投稿指南、metrics、编辑页抓取状态。
- `research_network.json`：期刊、主题、出版社、方法/主题网络。
- `journal_articles.jsonl`：近年文章公开元数据样本。
- `rag_documents.jsonl`：后端检索使用的公开证据片段。
- `crawl_report.json`：数量校验、字段缺失率、抓取状态和编辑团队覆盖情况。
- `radar-config.json`：公开 API 地址配置，不包含密钥。
- `source_workbook_snapshot.json`：从本地 Excel 生成的公开源表快照，供 GitHub Actions 在无法访问本机桌面文件时继续刷新。

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
npm run build:static
```

## ModelScope AI 后端

后端在 `research_radar_api/`，部署到阿里云轻量服务器。GitHub Pages 只调用公开 API 地址；ModelScope / DeepSeek token、访问口令、限额和日志不得进入 GitHub、前端 JS、JSON 或浏览器。

服务器环境变量：

```text
RADAR_LLM_PROVIDER=modelscope
MODELSCOPE_API_KEY=你的魔搭 API token
MODELSCOPE_MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507
RADAR_REQUIRE_ACCESS_CODE=false
RADAR_ACCESS_CODE=
RAG_DAILY_LIMIT=60
RAG_TOTAL_LIMIT=1990
RADAR_RATE_LIMIT_PER_MIN=6
ALLOWED_ORIGIN=https://jojo-edtech.github.io,http://localhost:4183
RADAR_DATA_DIR=/path/to/aied-journal/data/radar
RADAR_QUOTA_FILE=/var/tmp/aied-journal-quota.json
RADAR_PROVIDER_QUOTA_FILE=/var/tmp/aied-journal-provider-quota.json
```

默认模型 `Qwen/Qwen3-30B-A3B-Instruct-2507` 已通过魔搭 OpenAI-compatible API 实测可返回。更小的 Qwen/Qwen2.5 候选在当前 API 下返回 `no provider supported` 或空响应，因此不作为默认模型。若你在魔搭后台发现其他支持 API-Inference 的快速模型额度可用，可只改 `MODELSCOPE_MODEL`。

额度保护：公开站点不要求访问口令，但只有 AI 成功返回后才扣额度；Cloudflare Worker 版本按匿名浏览器访客隔离个人额度，并同时维护全站每日额度和 1990 次公开总额度，达到后即停。如果魔搭返回额度耗尽或限流信号，后端会标记当天已熔断，当天后续请求直接停止调用模型。

隐私边界：AI 请求是 stateless 的。后端不保存聊天记录，不提供历史记录接口；额度计数只保存匿名哈希/随机访客 ID 的数字计数，不保存问题、回答或来源文本。

## 自动更新

`.github/workflows/daily-research-radar-update.yml` 每天香港/北京时间 06:00 自动运行：

- 为全部 268 本期刊刷新 Crossref 近期文章元数据，并重新计算 Latest issue、近 3 期、近 1/2/3/5 年主题与关键词偏好。
- 每天轮换深爬约 80 本期刊的公开官网页面，约 4 天覆盖全表；未轮到的期刊保留上次已验证的官网与编辑资料。
- 重新生成期刊网络、RAG 文档和抓取报告，通过数据校验后提交到 `main`，再由 Pages 工作流自动发布。
- 有明确卷期号时，Latest issue 严格按 `year + volume + issue` 识别；仅在没有 issue 元数据的连续出版期刊中使用月份近似，并在数据中标注 fallback。

官网深爬只使用公开可访问页面；被登录、付费墙、反爬或动态页面拦截时记录失败原因。ModelScope token、AI 额度文件和访问配置不参与 GitHub Actions，也不会写入公开数据。
