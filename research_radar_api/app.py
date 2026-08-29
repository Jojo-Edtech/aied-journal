from __future__ import annotations

import hmac
import ipaddress
import json
import math
import os
import re
import tempfile
import threading
import time
from collections import Counter, OrderedDict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import FastAPI, HTTPException
from fastapi import Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

APP_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("RADAR_DATA_DIR", str(APP_ROOT / "data" / "radar"))).expanduser()
DEFAULT_PROVIDER = "modelscope"
DEFAULT_MODELSCOPE_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507"
DEFAULT_MODELSCOPE_API_BASE = "https://api-inference.modelscope.cn/v1"
DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash"
DEFAULT_DEEPSEEK_API_BASE = "https://api.deepseek.com/chat/completions"
MAX_QUESTION_CHARS = int(os.getenv("RADAR_MAX_QUESTION_CHARS", "1200"))
MAX_BODY_BYTES = min(max(8 * 1024, int(os.getenv("RADAR_MAX_BODY_BYTES", str(64 * 1024)))), 1024 * 1024)
TOP_K_DEFAULT = int(os.getenv("RADAR_TOP_K", "8"))
MAX_CONTEXT_CHARS = int(os.getenv("RADAR_MAX_CONTEXT_CHARS", "11000"))
DAILY_LIMIT = int(os.getenv("RAG_DAILY_LIMIT", "60"))
TOTAL_LIMIT = int(os.getenv("RAG_TOTAL_LIMIT", "1990"))
RATE_LIMIT_PER_MIN = int(os.getenv("RADAR_RATE_LIMIT_PER_MIN", "12"))
MAX_RATE_LIMIT_CLIENTS = max(100, int(os.getenv("RADAR_MAX_RATE_LIMIT_CLIENTS", "5000")))
MAX_LLM_RESPONSE_BYTES = min(
    max(64 * 1024, int(os.getenv("RADAR_MAX_LLM_RESPONSE_BYTES", str(4 * 1024 * 1024)))),
    8 * 1024 * 1024,
)
QUOTA_FILE = Path(os.getenv("RADAR_QUOTA_FILE", str(Path(tempfile.gettempdir()) / "aied_research_radar_quota.json")))
PROVIDER_QUOTA_FILE = Path(
    os.getenv(
        "RADAR_PROVIDER_QUOTA_FILE",
        str(Path(tempfile.gettempdir()) / "aied_research_radar_provider_quota.json"),
    )
)
_ACCESS_CODE_SETTING = os.getenv("RADAR_REQUIRE_ACCESS_CODE")
REQUIRE_ACCESS_CODE = (
    bool(os.getenv("RADAR_ACCESS_CODE", "").strip())
    if _ACCESS_CODE_SETTING is None
    else _ACCESS_CODE_SETTING.strip().lower() in {"1", "true", "yes", "on"}
)
ENABLE_API_DOCS = os.getenv("RADAR_ENABLE_API_DOCS", "false").strip().lower() in {"1", "true", "yes", "on"}


class RequestBodyTooLargeError(Exception):
    pass


class RequestBodyLimitMiddleware:
    def __init__(self, app, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_length = headers.get(b"content-length", b"")
        try:
            content_length = int(raw_length) if raw_length else 0
        except ValueError:
            content_length = 0
        if content_length > self.max_body_bytes:
            response = JSONResponse({"detail": "请求内容过大。"}, status_code=413)
            await response(scope, receive, send)
            return

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body_bytes:
                    raise RequestBodyTooLargeError
            return message

        try:
            await self.app(scope, limited_receive, send)
        except RequestBodyTooLargeError:
            response = JSONResponse({"detail": "请求内容过大。"}, status_code=413)
            await response(scope, receive, send)


def normalize_origin(value: str) -> str:
    candidate = (value or "").strip().rstrip("/")
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return ""
    if parsed.path not in {"", "/"}:
        return ""
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        return ""
    try:
        port = parsed.port
    except ValueError:
        return ""
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    return f"{parsed.scheme}://{host}{f':{port}' if port else ''}"


def allowed_origins() -> list[str]:
    raw = os.getenv(
        "ALLOWED_ORIGIN",
        "http://localhost:4183,http://127.0.0.1:4183,https://jojo-edtech.github.io",
    )
    return list(dict.fromkeys(origin for item in raw.split(",") if (origin := normalize_origin(item))))


app = FastAPI(
    title="AIED Journal Radar API",
    version="0.1.0",
    docs_url="/docs" if ENABLE_API_DOCS else None,
    redoc_url="/redoc" if ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)
app.add_middleware(RequestBodyLimitMiddleware, max_body_bytes=MAX_BODY_BYTES)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-AIED-Client"],
)


@app.middleware("http")
async def secure_api_responses(request: FastAPIRequest, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Content-Security-Policy"] = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        response.headers["X-Conversation-Mode"] = "stateless"
        response.headers["X-Chat-History-Stored"] = "false"
    return response


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
IP_BUCKETS: OrderedDict[str, deque[float]] = OrderedDict()
IP_BUCKETS_LOCK = threading.Lock()
QUOTA_LOCK = threading.RLock()
PROVIDER_QUOTA_LOCK = threading.Lock()


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


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            json.dump(data, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        path.chmod(0o600)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary_path.unlink(missing_ok=True)


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
                journal = journals.get(item.get("journal_id", ""), {})
                tokens = tokenize(
                    f"{item.get('journal_name', '')}\n{journal.get('abbreviation', '')}\n"
                    f"{journal.get('issn', '')} {journal.get('eissn', '')}\n{item.get('title', '')}\n{text}"
                )
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
        return {"date": datetime.now(timezone.utc).date().isoformat(), "used": 0, "total_used": 0}


def normalize_quota_state(state: dict[str, Any]) -> dict[str, Any]:
    today = datetime.now(timezone.utc).date().isoformat()
    total_used = int(state.get("total_used", 0))
    if state.get("date") != today:
        return {"date": today, "used": 0, "total_used": total_used}
    return {"date": today, "used": int(state.get("used", 0)), "total_used": total_used}


def claim_quota() -> int:
    with QUOTA_LOCK:
        state = normalize_quota_state(read_quota())
        used = int(state.get("used", 0))
        total_used = int(state.get("total_used", 0))
        if DAILY_LIMIT > 0 and used >= DAILY_LIMIT:
            raise HTTPException(status_code=429, detail="今日公开试用额度已用完。")
        if TOTAL_LIMIT > 0 and total_used >= TOTAL_LIMIT:
            raise HTTPException(status_code=429, detail="公开试用总额度已用完。")
        state["used"] = used + 1
        state["total_used"] = total_used + 1
        try:
            atomic_write_json(QUOTA_FILE, state)
        except OSError:
            raise HTTPException(status_code=503, detail="额度状态文件暂时不可写。")
        return remaining_quota(state)


def remaining_quota(state: dict[str, Any] | None = None) -> int:
    if DAILY_LIMIT <= 0:
        return -1
    state = normalize_quota_state(state or read_quota())
    used = int(state.get("used", 0))
    return max(0, DAILY_LIMIT - used)


def remaining_total_quota(state: dict[str, Any] | None = None) -> int:
    if TOTAL_LIMIT <= 0:
        return -1
    state = normalize_quota_state(state or read_quota())
    total_used = int(state.get("total_used", 0))
    return max(0, TOTAL_LIMIT - total_used)


def ensure_quota_available() -> None:
    if DAILY_LIMIT > 0 and remaining_quota() <= 0:
        raise HTTPException(status_code=429, detail="今日公开试用额度已用完。")
    if TOTAL_LIMIT > 0 and remaining_total_quota() <= 0:
        raise HTTPException(status_code=429, detail="公开试用总额度已用完。")


def read_provider_quota_state() -> dict[str, Any]:
    today = datetime.now(timezone.utc).date().isoformat()
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
        "date": datetime.now(timezone.utc).date().isoformat(),
        "provider": provider,
        "exhausted": True,
        "reason": reason[:240],
    }
    with PROVIDER_QUOTA_LOCK:
        try:
            atomic_write_json(PROVIDER_QUOTA_FILE, state)
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
    if not REQUIRE_ACCESS_CODE:
        return
    expected = os.getenv("RADAR_ACCESS_CODE", "").strip()
    submitted = (code or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="服务器尚未配置访问口令。")
    if not submitted:
        raise HTTPException(status_code=401, detail="请先输入访问口令。")
    if not hmac.compare_digest(submitted, expected):
        raise HTTPException(status_code=401, detail="访问口令未通过验证。")


def normalize_client_ip(value: str | None) -> str:
    try:
        address = ipaddress.ip_address((value or "").strip())
    except ValueError:
        return ""
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return str(address)


def client_ip(request: FastAPIRequest) -> str:
    peer = normalize_client_ip(request.client.host if request.client else "")
    try:
        peer_is_loopback = bool(peer and ipaddress.ip_address(peer).is_loopback)
    except ValueError:
        peer_is_loopback = False
    if peer_is_loopback:
        cloudflare = normalize_client_ip(request.headers.get("cf-connecting-ip"))
        if cloudflare:
            return cloudflare
        forwarded = normalize_client_ip(request.headers.get("x-forwarded-for", "").split(",")[0])
        if forwarded:
            return forwarded
    return peer or "unknown"


def require_rate_limit(request: FastAPIRequest) -> None:
    if RATE_LIMIT_PER_MIN <= 0:
        return
    ip = client_ip(request)
    now = time.time()
    cutoff = now - 60
    with IP_BUCKETS_LOCK:
        bucket = IP_BUCKETS.pop(ip, deque())
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_PER_MIN:
            IP_BUCKETS[ip] = bucket
            raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试。")
        bucket.append(now)
        IP_BUCKETS[ip] = bucket
        while len(IP_BUCKETS) > MAX_RATE_LIMIT_CLIENTS:
            IP_BUCKETS.popitem(last=False)


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
    if base in {"https://api.deepseek.com", "https://api-inference.modelscope.cn"}:
        return f"{base}/chat/completions"
    return base


def validated_chat_endpoint(provider: str, api_base: str) -> str:
    endpoint = chat_endpoint(api_base)
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError:
        parsed = None
        port = None
    expected = {
        "modelscope": ("api-inference.modelscope.cn", "/v1/chat/completions"),
        "deepseek": ("api.deepseek.com", "/chat/completions"),
    }.get(provider)
    if (
        not parsed
        or not expected
        or parsed.scheme != "https"
        or parsed.hostname != expected[0]
        or parsed.path != expected[1]
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or port not in {None, 443}
    ):
        raise HTTPException(status_code=503, detail="模型服务地址配置不安全，已停止调用。")
    return endpoint


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


LLM_HTTP_OPENER = build_opener(NoRedirectHandler())


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
        "检索范围是全部期刊总库，不使用网页右侧候选清单或当前筛选。"
        "若用户询问指定期刊的事实，直接回答该期刊；选刊问题才推荐 3-5 本。"
        "回答要简洁、可操作。"
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
        validated_chat_endpoint(settings["provider"], settings["api_base"]),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings['token']}",
            "Content-Type": "application/json",
            "User-Agent": "aied-journal-api/0.1",
        },
        method="POST",
    )
    try:
        with LLM_HTTP_OPENER.open(request, timeout=settings["timeout"]) as response:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > MAX_LLM_RESPONSE_BYTES:
                        raise HTTPException(status_code=502, detail="AI 模型返回内容过大，已停止读取。")
                except ValueError:
                    pass
            raw_response = response.read(MAX_LLM_RESPONSE_BYTES + 1)
            if len(raw_response) > MAX_LLM_RESPONSE_BYTES:
                raise HTTPException(status_code=502, detail="AI 模型返回内容过大，已停止读取。")
            data = json.loads(raw_response.decode("utf-8"))
        choices = data.get("choices") or []
        content = (choices[0].get("message", {}).get("content", "") if choices else "").strip()
        if not content:
            raise HTTPException(status_code=502, detail="ModelScope API 没有返回可用回答。")
        return content
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
    except HTTPException:
        raise
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
    settings = llm_settings()
    model_quota_exhausted, _ = provider_quota_exhausted(settings["provider"])
    return {
        "ok": document_count > 0,
        "documents": document_count,
        "journal_count": len(load_json(DATA_DIR / "journals.json", [])),
        "llm_provider": settings["provider"],
        "llm_model": settings["model"],
        "llm_configured": bool(settings["token"]),
        "provider_quota_exhausted": model_quota_exhausted,
        "access_required": REQUIRE_ACCESS_CODE,
        "remaining_quota": remaining_quota(),
        "remaining_total_quota": remaining_total_quota(),
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
            "remaining_total_quota": remaining_total_quota(),
            "privacy_mode": "stateless_no_chat_history",
            "stores_chat_history": False,
            "retrieval_scope": "full_journal_database",
            "searched_journal_count": len(index.journals),
        }
    if not llm_configured():
        raise HTTPException(status_code=503, detail=llm_missing_message())
    settings = llm_settings()
    ensure_provider_quota_available(settings["provider"])
    remaining = claim_quota()
    answer = call_llm(payload.question.strip(), results)
    return {
        "answer": answer,
        "sources": public_sources(results),
        "remaining_quota": remaining,
        "remaining_total_quota": remaining_total_quota(),
        "provider": settings["provider"],
        "model": settings["model"],
        "retrieval_scope": "full_journal_database",
        "searched_journal_count": len(index.journals),
        "privacy_mode": "stateless_no_chat_history",
        "stores_chat_history": False,
    }
