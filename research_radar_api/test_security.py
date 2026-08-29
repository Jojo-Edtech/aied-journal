from __future__ import annotations

import asyncio
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, Request
from starlette.responses import Response

from research_radar_api import app as radar


def request_for(peer: str, headers: dict[str, str] | None = None) -> SimpleNamespace:
    return SimpleNamespace(client=SimpleNamespace(host=peer), headers=headers or {})


class SecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        radar.IP_BUCKETS.clear()

    def test_origins_are_exact_and_http_is_local_only(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ALLOWED_ORIGIN": (
                    "https://jojo-edtech.github.io/,https://evil.example/path,"
                    "http://evil.example,http://127.0.0.1:4183,*"
                )
            },
        ):
            self.assertEqual(
                radar.allowed_origins(),
                ["https://jojo-edtech.github.io", "http://127.0.0.1:4183"],
            )

    def test_forwarded_ip_is_trusted_only_from_loopback_proxy(self) -> None:
        spoofed = request_for("203.0.113.10", {"x-forwarded-for": "198.51.100.20"})
        self.assertEqual(radar.client_ip(spoofed), "203.0.113.10")
        proxied = request_for("127.0.0.1", {"cf-connecting-ip": "198.51.100.21"})
        self.assertEqual(radar.client_ip(proxied), "198.51.100.21")

    def test_rate_limit_is_per_client_and_memory_is_bounded(self) -> None:
        with patch.object(radar, "RATE_LIMIT_PER_MIN", 2), patch.object(radar, "MAX_RATE_LIMIT_CLIENTS", 3):
            client = request_for("127.0.0.1", {"cf-connecting-ip": "198.51.100.30"})
            radar.require_rate_limit(client)
            radar.require_rate_limit(client)
            with self.assertRaises(HTTPException) as blocked:
                radar.require_rate_limit(client)
            self.assertEqual(blocked.exception.status_code, 429)

            for suffix in range(10):
                radar.require_rate_limit(
                    request_for("127.0.0.1", {"cf-connecting-ip": f"198.51.100.{100 + suffix}"})
                )
            self.assertLessEqual(len(radar.IP_BUCKETS), 3)

    def test_access_code_uses_constant_time_comparison_path(self) -> None:
        with patch.object(radar, "REQUIRE_ACCESS_CODE", True), patch.dict(
            os.environ, {"RADAR_ACCESS_CODE": "correct-code"}
        ):
            radar.require_access_code("correct-code")
            with self.assertRaises(HTTPException) as denied:
                radar.require_access_code("incorrect-code")
            self.assertEqual(denied.exception.status_code, 401)

    def test_existing_access_code_remains_required_when_flag_is_omitted(self) -> None:
        environment = dict(os.environ)
        environment.pop("RADAR_REQUIRE_ACCESS_CODE", None)
        environment["RADAR_ACCESS_CODE"] = "configured-code"
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from research_radar_api import app; assert app.REQUIRE_ACCESS_CODE is True",
            ],
            cwd=Path(__file__).resolve().parents[1],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_model_endpoint_is_locked_to_official_https_hosts(self) -> None:
        self.assertEqual(
            radar.validated_chat_endpoint("modelscope", "https://api-inference.modelscope.cn/v1"),
            "https://api-inference.modelscope.cn/v1/chat/completions",
        )
        self.assertEqual(
            radar.validated_chat_endpoint("deepseek", "https://api.deepseek.com/chat/completions"),
            "https://api.deepseek.com/chat/completions",
        )
        for provider, endpoint in [
            ("modelscope", "http://api-inference.modelscope.cn/v1"),
            ("modelscope", "https://127.0.0.1/v1"),
            ("deepseek", "https://evil.example/chat/completions"),
        ]:
            with self.assertRaises(HTTPException):
                radar.validated_chat_endpoint(provider, endpoint)

    def test_quota_write_is_atomic_private_and_enforced_before_overrun(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            quota_file = Path(temporary_dir) / "quota.json"
            with patch.object(radar, "QUOTA_FILE", quota_file), patch.object(radar, "DAILY_LIMIT", 1), patch.object(
                radar, "TOTAL_LIMIT", 1
            ):
                self.assertEqual(radar.claim_quota(), 0)
                state = json.loads(quota_file.read_text(encoding="utf-8"))
                self.assertEqual(state["used"], 1)
                self.assertEqual(stat.S_IMODE(quota_file.stat().st_mode), 0o600)
                with self.assertRaises(HTTPException) as exhausted:
                    radar.claim_quota()
                self.assertEqual(exhausted.exception.status_code, 429)

    def test_public_health_omits_operational_secrets(self) -> None:
        fake_index = SimpleNamespace(documents=[object(), object()])
        with patch.object(radar, "load_documents", return_value=fake_index), patch.object(
            radar, "load_json", return_value=[{"id": "journal"}]
        ), patch.object(radar, "llm_settings", return_value={"provider": "modelscope", "model": "model", "token": "secret"}), patch.object(
            radar, "provider_quota_exhausted", return_value=(False, "")
        ), patch.object(radar, "remaining_quota", return_value=5), patch.object(
            radar, "remaining_total_quota", return_value=50
        ):
            payload = radar.health()
        self.assertTrue(payload["ok"])
        self.assertNotIn("access_code_configured", payload)
        self.assertNotIn("provider_quota_reason", payload)
        self.assertNotIn("index_error", payload)
        self.assertNotIn("deepseek_configured", payload)
        self.assertNotIn("modelscope_configured", payload)

    def test_security_headers_and_api_docs_default(self) -> None:
        scope = {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "path": "/api/health",
            "raw_path": b"/api/health",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("example.test", 443),
        }
        request = Request(scope)

        async def call_next(_request):
            return Response("{}", media_type="application/json")

        response = asyncio.run(radar.secure_api_responses(request, call_next))
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertEqual(response.headers["cache-control"], "no-store, private")
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        self.assertIsNone(radar.app.docs_url)
        self.assertIsNone(radar.app.redoc_url)
        self.assertIsNone(radar.app.openapi_url)

    def test_request_body_limit_rejects_large_content_length(self) -> None:
        called = False

        async def inner_app(scope, receive, send):
            nonlocal called
            called = True

        middleware = radar.RequestBodyLimitMiddleware(inner_app, max_body_bytes=10)
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/api/chat",
            "headers": [(b"content-length", b"11")],
        }
        sent = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        asyncio.run(middleware(scope, receive, send))
        self.assertFalse(called)
        self.assertEqual(sent[0]["status"], 413)

    def test_request_body_limit_counts_streamed_chunks(self) -> None:
        async def inner_app(scope, receive, send):
            await receive()

        middleware = radar.RequestBodyLimitMiddleware(inner_app, max_body_bytes=10)
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/api/chat",
            "headers": [],
        }
        sent = []

        async def receive():
            return {"type": "http.request", "body": b"12345678901", "more_body": False}

        async def send(message):
            sent.append(message)

        asyncio.run(middleware(scope, receive, send))
        self.assertEqual(sent[0]["status"], 413)


if __name__ == "__main__":
    unittest.main()
