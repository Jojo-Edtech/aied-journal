# AIED Journal Radar API

这个目录是阿里云轻量服务器上的 RAG + AI 模型代理后端。GitHub Pages 只调用这里的公开 API，不保存 ModelScope / DeepSeek token。

## 环境变量

```text
RADAR_LLM_PROVIDER=modelscope
MODELSCOPE_API_KEY=你的魔搭 API token
MODELSCOPE_MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507
RADAR_REQUIRE_ACCESS_CODE=false
RADAR_ACCESS_CODE=
RAG_DAILY_LIMIT=60
RAG_TOTAL_LIMIT=1990
RADAR_RATE_LIMIT_PER_MIN=6
RADAR_MAX_QUESTION_CHARS=1200
MODELSCOPE_MAX_TOKENS=900
ALLOWED_ORIGIN=https://jojo-edtech.github.io,http://localhost:4183
RADAR_DATA_DIR=/path/to/aied-journal/data/radar
RADAR_QUOTA_FILE=/var/tmp/aied-journal-quota.json
RADAR_PROVIDER_QUOTA_FILE=/var/tmp/aied-journal-provider-quota.json
```

默认 provider 是 `modelscope`，默认模型是 `Qwen/Qwen3-30B-A3B-Instruct-2507`，默认接口是 `https://api-inference.modelscope.cn/v1/chat/completions`。这个模型已通过当前魔搭 API 实测可返回；更小的 Qwen/Qwen2.5 候选在当前 API 下不可用或空返回，因此不作为默认模型。

如果你在魔搭后台发现这个模型免费额度已用过，可以只改模型名，例如：

```text
MODELSCOPE_MODEL=Qwen/Qwen3-8B
```

后端也兼容 `DASHSCOPE_API_KEY` 作为 token 环境变量名。保留 DeepSeek 备用方式：

```text
RADAR_LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的 DeepSeek key
DEEPSEEK_MODEL=deepseek-v4-flash
```

限额建议：

- `RADAR_REQUIRE_ACCESS_CODE=false`：公开限额模式，访问者不需要输入口令；ModelScope token 仍只放服务器环境变量。
- `RAG_DAILY_LIMIT=60`：每日公开回答次数。
- `RAG_TOTAL_LIMIT=1990`：站点公开总成功回答次数，达到后即停，保护免费额度。
- `RADAR_RATE_LIMIT_PER_MIN=6`：单 IP 每分钟次数。
- `RADAR_PROVIDER_QUOTA_FILE`：记录模型服务当天是否已额度熔断；魔搭免费额度用完后当天即停。
- `MODELSCOPE_MAX_TOKENS=900`：单次最大输出，省 token。
- `RADAR_MAX_QUESTION_CHARS=1200`：问题长度限制。

线上 Cloudflare Worker 会按匿名浏览器访客隔离个人额度，并且不保存聊天记录。FastAPI 版本也只做一次性问答，不提供历史记录接口；生产日志不要记录用户问题全文。

## 本地运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
RADAR_REQUIRE_ACCESS_CODE=false MODELSCOPE_API_KEY=... uvicorn app:app --host 0.0.0.0 --port 8000
```

检查：

```bash
curl http://127.0.0.1:8000/api/health
```

把公网 API 地址写入 `data/radar/radar-config.json`：

```json
{
  "api_base_url": "https://your-domain.example.com",
  "access_mode": "public_limited"
}
```

不要把 `MODELSCOPE_API_KEY`、`DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`、访问口令或服务器日志提交到 GitHub。公开模式也只公开 API 入口，不公开 token。
