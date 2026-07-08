from __future__ import annotations

import json
import math
import os
import re
import tempfile
import time
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException, Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


APP_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("RADAR_DATA_DIR", str(APP_ROOT / "data" / "radar"))).expanduser()
DEFAULT_PROVIDER = "modelscope"
DEFAULT_MODELSCOPE_MODEL = "Qwen/Qwen3-4B"
DEFAULT_MODELSCOPE_API_BASE = "https://api-inference.modelscope.cn/v1"
DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash"
DEFAULT_DEEPSEEK_API_BASE = "https://api.deepseek.com/chat/completions"
MAX_QUESTION_CHARS = int(os.getenv("RADAR_MAX_QUESTION_CHARS", "1200"))
TOP_K_DEFAULT = int(os.getenv("RADAR_TOP_K", "8"))
MAX_CONTEXT_CHARS = int(os.getenv("RADAR_MAX_CONTEXT_CHARS", "11000"))
DAILY_LIMIT = int(os.getenv("RAG_DAILY_LIMIT", "60"))
RATE_LIMIT_PER_MIN = int(os.getenv("RADAR_RATE_LIMIT_PER_MIN", "12"))
QUOTA_FILE = Path(os.getenv("RADAR_QUOTA_FILE", str(Path(tempfile.gettempdir()) / "aied_research_radar_quota.json")))
PROVIDER_QUOTA_FILE = Path(
    os.getenv(
        "RADAR_PROVIDER_QUOTA_FILE",
        str(Path(tempfile.gettempdir()) / "aied_research_radar_provider_quota.json"),
    )
)


def allowed_origins() -> list[str]:
    raw = os.getenv(
        "ALLOWED_ORIGIN",
        "http://localhost:4183,http://127.0.0.1:4183,https://jojo-edtech.github.io",
    )
    return [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]


app = FastAPI(title="AIED Journal Radar API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@dataclass
class Document:
    doc_id: str
    journal_id: str
    journal_name: str
    source_url: str
    source_type: str
    title: str
    text: str
    tokens: list[str]
    counts: Counter
    length: int


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=MAX_QUESTION_CHARS)
    access_code: str = Field(default="", max_length=200)
    top_k: int = Field(default=TOP_K_DEFAULT, ge=3, le=12)


class RadarIndex:
    def __init__(self, documents: list[Document], journals: dict[str, dict[str, Any]]) -> None:
        self.documents = documents
        self.journals = journals
        self.avg_length = sum(doc.length for doc in documents) / max(1, len(documents))
        self.doc_freq = Counter()
        for doc in documents:
            self.doc_freq.update(set(doc.tokens))

    def search(self, query: str, top_k: int) -> list[tuple[Document, float]]:
        query_tokens = tokenize(query)
        if not query_tokens:
            return []
        query_counts = Counter(query_tokens)
        total_docs = max(1, len(self.documents))
        results: list[tuple[Document, float]] = []
        lowered_query = query.lower()

        for doc in self.documents:
            score = 0.0
            for token, query_weight in query_counts.items():
                frequency = doc.counts.get(token, 0)
                if frequency == 0:
                    continue
                idf = math.log((total_docs - self.doc_freq[token] + 0.5) / (self.doc_freq[token] + 0.5) + 1)
                denominator = frequency + 1.4 * (1 - 0.72 + 0.72 * doc.length / self.avg_length)
                score += query_weight * idf * (frequency * 2.4) / denominator

            journal = self.journals.get(doc.journal_id, {})
            journal_text = " ".join(
                str(value)
                for value in [
                    journal.get("name", ""),
                    journal.get("main_tag", ""),
                    journal.get("secondary_tag", ""),
                    journal.get("publisher_family", ""),
                    " ".join((journal.get("topic_hits") or {}).keys()),
                    " ".join((journal.get("method_hits") or {}).keys()),
                ]
            ).lower()
            if lowered_query and lowered_query in doc.title.lower():
                score += 5.0
            if lowered_query and lowered_query in journal_text:
                score += 4.0
            if doc.source_type == "jcr_workbook":
                score += 0.8
            if doc.source_type in {"author_guidelines", "journal_metrics"}:
                score += 1.2
            if doc.source_type == "article":
                score += 1.6
            if score > 0:
                results.append((doc, score))

        results.sort(key=lambda item: item[1], reverse=True)
        return results[:top_k]


INDEX: RadarIndex | None = None
INDEX_ERROR: str | None = None
IP_BUCKETS: defaultdict[str, deque[float]] = defaultdict(deque)


def tokenize(text: str) -> list[str]:
    lowered = (text or "").lower()
    tokens = re.findall(r"[a-z0-9][a-z0-9_+.-]*", lowered)
    for sequence in re.findall(r"[\u4e00-\u9fff]+", text or ""):
        tokens.extend(sequence)
        for width in (2, 3):
            if len(sequence) >= width:
                tokens.extend(sequence[index : index + width] for index in range(len(sequence) - width + 1))
    return tokens


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def load_documents() -> RadarIndex:
    global INDEX, INDEX_ERROR
    if INDEX is not None:
        return INDEX

    try:
        journals_list = load_json(DATA_DIR / "journals.json", [])
        if not journals_list:
            journals_list = load_json(DATA_DIR / "journals_q1.json", [])
        journals = {journal.get("id"): journal for journal in journals_list if journal.get("id")}
        docs: list[Document] = []
        with (DATA_DIR / "rag_documents.jsonl").open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                item = json.loads(line)
                text = item.get("text_snippet", "")
                tokens = tokenize(f"{item.get('journal_name', '')}\n{item.get('title', '')}\n{text}")
                docs.append(
                    Document(
                        doc_id=item.get("doc_id", ""),
                        journal_id=item.get("journal_id", ""),
                        journal_name=item.get("journal_name", ""),
                        source_url=item.get("source_url", ""),
                        source_type=item.get("source_type", ""),
                        title=item.get("title", ""),
                        text=text,
                        tokens=tokens,
                        counts=Counter(tokens),
                        length=max(1, len(tokens)),
                    )
                )
        INDEX = RadarIndex(docs, journals)
        INDEX_ERROR = None
        return INDEX
    except (OSError, json.JSONDecodeError) as error:
        INDEX_ERROR = f"{type(error).__name__}: {error}"
        raise RuntimeError(INDEX_ERROR) from error


def read_quota() -> dict[str, Any]:
    try:
        return json.loads(QUOTA_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"date": date.today().isoformat(), "used": 0}


def claim_quota() -> int:
    if DAILY_LIMIT <= 0:
        return -1
    today = date.today().isoformat()
    state = read_quota()
    if state.get("date") != today:
        state = {"date": today, "used": 0}
    used = int(state.get("used", 0))
    if used >= DAILY_LIMIT:
        raise HTTPException(status_code=429, detail="今日公开试用额度已用完。")
    state["used"] = used + 1
    try:
        QUOTA_FILE.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    except OSError:
        raise HTTPException(status_code=503, detail="额度状态文件暂时不可写。")
    return max(0, DAILY_LIMIT - int(state["used"]))


def remaining_quota() -> int:
    if DAILY_LIMIT <= 0:
        return -1
    state = read_quota()
    used = int(state.get("used", 0)) if state.get("date") == date.today().isoformat() else 0
    return max(0, DAILY_LIMIT - used)


def ensure_quota_available() -> None:
    if DAILY_LIMIT > 0 and remaining_quota() <= 0:
        raise HTTPException(status_code=429, detail="今日公开试用额度已用完。")


def read_provider_quota_state() -> dict[str, Any]:
    today = date.today().isoformat()
    try:
        state = json.loads(PROVIDER_QUOTA_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"date": today, "exhausted": False}
    if state.get("date") != today:
        return {"date": today, "exhausted": False}
    return state


def provider_quota_exhausted(provider: str) -> tuple[bool, str]:
    state = read_provider_quota_state()
    if state.get("provider") and state.get("provider") != provider:
        return False, ""
    return bool(state.get("exhausted")), str(state.get("reason") or "")


def mark_provider_quota_exhausted(provider: str, reason: str) -> None:
    state = {
        "date": date.today().isoformat(),
        "provider": provider,
        "exhausted": True,
        "reason": reason[:240],
    }
    try:
        PROVIDER_QUOTA_FILE.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def ensure_provider_quota_available(provider: str) -> None:
    exhausted, _ = provider_quota_exhausted(provider)
    if exhausted:
        if provider == "modelscope":
            raise HTTPException(status_code=429, detail="魔搭免费额度可能已用完，今日已停止继续调用。")
        raise HTTPException(status_code=429, detail="AI 模型服务额度可能已用完，今日已停止继续调用。")


def provider_quota_signal(provider: str, status_code: int, body: str) -> bool:
    lowered = body.lower()
    quota_terms = [
        "quota",
        "insufficient_quota",
        "free quota",
        "balance",
        "insufficient balance",
        "limit exceeded",
        "rate limit",
        "额度",
        "余额",
        "限流",
        "免费",
    ]
    if status_code == 402:
        return True
    if status_code == 429 and provider == "modelscope":
        return True
    return any(term in lowered for term in quota_terms)


def require_access_code(code: str) -> None:
    expected = os.getenv("RADAR_ACCESS_CODE", "")
    if not expected:
        raise HTTPException(status_code=503, detail="服务器尚未配置访问口令。")
    if code != expected:
        raise HTTPException(status_code=401, detail="访问口令不正确。")


def require_rate_limit(request: FastAPIRequest) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    bucket = IP_BUCKETS[ip]
    while bucket and now - bucket[0] > 60:
        bucket.popleft()
    if len(bucket) >= RATE_LIMIT_PER_MIN:
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试。")
    bucket.append(now)


def context_for(results: list[tuple[Document, float]]) -> str:
    chunks: list[str] = []
    used = 0
    for index, (doc, score) in enumerate(results, start=1):
        snippet = re.sub(r"\s+", " ", doc.text)[:1400]
        source = (
            f"[{index}] 期刊：{doc.journal_name}\n"
            f"标题：{doc.title}\n"
            f"类型：{doc.source_type}\n"
            f"内容：{snippet}\n"
            f"来源：{doc.source_url}\n"
            f"检索分数：{score:.2f}"
        )
        if used + len(source) > MAX_CONTEXT_CHARS:
            break
        chunks.append(source)
        used += len(source)
    return "\n\n".join(chunks)


def public_sources(results: list[tuple[Document, float]]) -> list[dict[str, Any]]:
    return [
        {
            "journal_name": doc.journal_name,
            "title": doc.title,
            "source_type": doc.source_type,
            "source_url": doc.source_url,
            "score": round(score, 3),
        }
        for doc, score in results
    ]


def chat_endpoint(api_base: str) -> str:
    base = api_base.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return base


def llm_settings() -> dict[str, Any]:
    provider = os.getenv("RADAR_LLM_PROVIDER", DEFAULT_PROVIDER).strip().lower()
    if provider == "deepseek":
        return {
            "provider": "deepseek",
            "model": os.getenv("DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL),
            "api_base": os.getenv("DEEPSEEK_API_BASE", DEFAULT_DEEPSEEK_API_BASE),
            "token": os.getenv("DEEPSEEK_API_KEY", ""),
            "timeout": int(os.getenv("DEEPSEEK_TIMEOUT_SEC", "90")),
            "max_tokens": int(os.getenv("DEEPSEEK_MAX_TOKENS", "1200")),
            "temperature": float(os.getenv("DEEPSEEK_TEMPERATURE", "0.2")),
        }
    return {
        "provider": "modelscope",
        "model": os.getenv("MODELSCOPE_MODEL", DEFAULT_MODELSCOPE_MODEL),
        "api_base": os.getenv("MODELSCOPE_API_BASE", DEFAULT_MODELSCOPE_API_BASE),
        "token": os.getenv("MODELSCOPE_API_KEY", "") or os.getenv("DASHSCOPE_API_KEY", ""),
        "timeout": int(os.getenv("MODELSCOPE_TIMEOUT_SEC", "60")),
        "max_tokens": int(os.getenv("MODELSCOPE_MAX_TOKENS", "900")),
        "temperature": float(os.getenv("MODELSCOPE_TEMPERATURE", "0.2")),
    }


def llm_configured() -> bool:
    return bool(llm_settings()["token"])


def llm_missing_message() -> str:
    provider = llm_settings()["provider"]
    if provider == "modelscope":
        return "服务器尚未配置 ModelScope API token。"
    return "服务器尚未配置 DeepSeek API key。"


def call_llm(question: str, results: list[tuple[Document, float]]) -> str:
    settings = llm_settings()
    if not settings["token"]:
        raise HTTPException(status_code=503, detail=llm_missing_message())

    system_prompt = (
        "你是 AIED Journal Radar 的选刊助手。你的边界是帮助用户理解教育学 JCR 期刊、"
        "研究主题网络、投稿匹配和风险，不代写论文。只能根据给定资料回答；"
        "资料不足时必须说“当前雷达资料不足”。每个推荐期刊都要给出引用编号。"
        "回答要简洁、可操作，优先给 3-5 本最匹配期刊。"
    )
    payload = {
        "model": settings["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"用户问题：{question}\n\n"
                    "请输出：1. 首选期刊3-5本；2. 备选期刊；3. 不推荐或需谨慎的原因；"
                    "4. 下一步需要用户确认的信息。\n\n"
                    f"可引用资料：\n{context_for(results)}"
                ),
            },
        ],
        "max_tokens": settings["max_tokens"],
        "temperature": settings["temperature"],
        "stream": False,
    }
    if settings["provider"] == "deepseek":
        payload["thinking"] = {"type": os.getenv("DEEPSEEK_THINKING", "disabled")}

    request = Request(
        chat_endpoint(settings["api_base"]),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings['token']}",
            "Content-Type": "application/json",
            "User-Agent": "aied-journal-api/0.1",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=settings["timeout"]) as response:
            data = json.loads(response.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"].strip()
    except HTTPError as error:
        provider_name = "ModelScope" if settings["provider"] == "modelscope" else "DeepSeek"
        try:
            body = error.read().decode("utf-8", errors="replace")[:1200]
        except OSError:
            body = ""
        if provider_quota_signal(settings["provider"], error.code, body):
            mark_provider_quota_exhausted(settings["provider"], f"HTTP {error.code}")
            if settings["provider"] == "modelscope":
                raise HTTPException(status_code=429, detail="魔搭免费额度可能已用完，今日已停止继续调用。")
            raise HTTPException(status_code=429, detail="AI 模型服务额度可能已用完，今日已停止继续调用。")
        raise HTTPException(status_code=502, detail=f"{provider_name} API 暂时不可用：HTTP {error.code}。")
    except (OSError, URLError, KeyError, IndexError, TypeError, json.JSONDecodeError):
        provider_name = "ModelScope" if settings["provider"] == "modelscope" else "DeepSeek"
        raise HTTPException(status_code=502, detail=f"{provider_name} API 返回暂时无法解析。")


@app.get("/api/health")
def health() -> dict[str, Any]:
    try:
        index = load_documents()
        document_count = len(index.documents)
    except RuntimeError:
        document_count = 0
    network = load_json(DATA_DIR / "research_network.json", {"nodes": [], "links": []})
    settings = llm_settings()
    model_quota_exhausted, model_quota_reason = provider_quota_exhausted(settings["provider"])
    return {
        "ok": document_count > 0,
        "documents": document_count,
        "network_nodes": len(network.get("nodes", [])),
        "network_links": len(network.get("links", [])),
        "llm_provider": settings["provider"],
        "llm_model": settings["model"],
        "llm_configured": bool(settings["token"]),
        "modelscope_configured": bool(os.getenv("MODELSCOPE_API_KEY", "") or os.getenv("DASHSCOPE_API_KEY", "")),
        "deepseek_configured": bool(os.getenv("DEEPSEEK_API_KEY")),
        "provider_quota_exhausted": model_quota_exhausted,
        "provider_quota_reason": model_quota_reason if model_quota_exhausted else "",
        "access_code_configured": bool(os.getenv("RADAR_ACCESS_CODE")),
        "daily_limit": DAILY_LIMIT,
        "remaining_quota": remaining_quota(),
        "index_error": INDEX_ERROR,
    }


@app.get("/api/sources")
def sources() -> dict[str, Any]:
    report = load_json(DATA_DIR / "crawl_report.json", {})
    journals = load_json(DATA_DIR / "journals.json", [])
    if not journals:
        journals = load_json(DATA_DIR / "journals_q1.json", [])
    return {
        "report": report,
        "journal_count": len(journals),
        "top_journals": journals[:12],
    }


@app.post("/api/chat")
def chat(payload: ChatRequest, request: FastAPIRequest) -> dict[str, Any]:
    require_rate_limit(request)
    require_access_code(payload.access_code)
    index = load_documents()
    results = index.search(payload.question.strip(), payload.top_k)
    if not results or results[0][1] < 0.1:
        return {
            "answer": "当前雷达资料不足。请补充研究主题、方法、学段、研究对象或目标期刊类型。",
            "sources": public_sources(results),
            "remaining_quota": remaining_quota(),
        }
    if not llm_configured():
        raise HTTPException(status_code=503, detail=llm_missing_message())
    ensure_quota_available()
    settings = llm_settings()
    ensure_provider_quota_available(settings["provider"])
    answer = call_llm(payload.question.strip(), results)
    remaining = claim_quota()
    return {
        "answer": answer,
        "sources": public_sources(results),
        "remaining_quota": remaining,
        "provider": settings["provider"],
        "model": settings["model"],
    }
