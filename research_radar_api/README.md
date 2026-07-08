# AIED Journal Radar API

这个目录是阿里云轻量服务器上的 RAG + AI 模型代理后端。GitHub Pages 只调用这里的公开 API，不保存 ModelScope / DeepSeek token。

## 环境变量

```text
RADAR_LLM_PROVIDER=modelscope
MODELSCOPE_API_KEY=你的魔搭 API token
MODELSCOPE_MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507
RADAR_ACCESS_CODE=半公开访问口令
RAG_DAILY_LIMIT=30
RADAR_RATE_LIMIT_PER_MIN=6
RADAR_MAX_QUESTION_CHARS=1200
MODELSCOPE_MAX_TOKENS=900
ALLOWED_ORIGIN=https://jojo-edtech.github.io,http://localhost:4183
RADAR_DATA_DIR=/path/to/aied-journal/data/radar
RADAR_PROVIDER_QUOTA_FILE=/var/tmp/aied-journal-provider-quota.json
```

默认 provider 是 `modelscope`，默认模型是 `Qwen/Qwen3-30B-A3B-Instruct-2507`，默认接口是 `https://api-inference.modelscope.cn/v1/chat/completions`。这个模型支持魔搭 API 推理，本次实测可正常返回且比 35B 候选更快，优先速度和免费额度消耗控制。

如果你在魔搭后台发现这个模型免费额度已用过，可以只改模型名：

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

- `RAG_DAILY_LIMIT=30`：每日总回答次数。
- `RADAR_RATE_LIMIT_PER_MIN=6`：单 IP 每分钟次数。
- `RADAR_PROVIDER_QUOTA_FILE`：记录模型服务当天是否已额度熔断；魔搭免费额度用完后当天即停。
- `MODELSCOPE_MAX_TOKENS=900`：单次最大输出，省 token。
- `RADAR_MAX_QUESTION_CHARS=1200`：问题长度限制。

## 本地运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
RADAR_ACCESS_CODE=test MODELSCOPE_API_KEY=... uvicorn app:app --host 0.0.0.0 --port 8000
```

检查：

```bash
curl http://127.0.0.1:8000/api/health
```

把公网 API 地址写入 `data/radar/radar-config.json`：

```json
{
  "api_base_url": "https://your-domain.example.com",
  "access_mode": "semi_public_code"
}
```

不要把 `MODELSCOPE_API_KEY`、`DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`、访问口令或服务器日志提交到 GitHub。
