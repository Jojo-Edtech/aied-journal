"""Scope boundaries and dated index metadata at the Python API loading boundary."""
from collections import Counter
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from research_radar_api import app as api


SCOPE_ID = "english-ssci-esci-scopus-v1"
MANIFEST = {"data_version": "scope-test", "journal_scope": {"scope_id": SCOPE_ID}}


def journal(**overrides):
    return {
        "id": "journal-test", "name": "Example Education Journal", "languages": ["English"],
        "indexes": ["SSCI", "Scopus"], "scope_id": SCOPE_ID,
        "index_evidence": [{"index": "SSCI", "source": "Dated index list", "url": "https://example.org/index.xlsx", "snapshot_date": "2026-06"}],
        **overrides,
    }


class ScopeTests(unittest.TestCase):
    def test_new_scope_accepts_english_and_rejects_chinese_or_missing_allowed_index(self):
        for languages in (["English"], ["en-GB"], ["eng", "French"]):
            with self.subTest(languages=languages):
                api.validate_journal_scope([journal(languages=languages)], MANIFEST)
        invalid = [
            journal(languages=["English", "Chinese"]), journal(languages=["en", "zh-Hans"]),
            journal(languages=[]), journal(languages=["French"]), journal(languages="English"),
            journal(indexes=[]), journal(indexes=["SCIE"]), journal(indexes=["SSCI", "SSCI"]),
            journal(indexes="SSCI"), journal(scope_id="other-scope"),
        ]
        for record in invalid:
            with self.subTest(record=record), self.assertRaises(ValueError):
                api.validate_journal_scope([record], MANIFEST)

    def test_manifest_scope_is_nested_and_legacy_fixtures_remain_supported(self):
        legacy = [{"id": "legacy", "name": "Legacy Journal", "languages": ["Chinese"]}]
        api.validate_journal_scope(legacy, {})
        api.validate_journal_scope(legacy, {"data_version": "old"})
        with self.assertRaises(ValueError):
            api.validate_journal_scope(legacy, MANIFEST)
        with self.assertRaises(ValueError):
            api.validate_journal_scope([journal()], {"journal_scope": {"scope_id": "unknown"}})
        with self.assertRaises(ValueError):
            api.validate_journal_scope([], MANIFEST)

    def test_loader_and_sources_reject_out_of_scope_new_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data-manifest.json").write_text(json.dumps(MANIFEST))
            (root / "journals.json").write_text(json.dumps([journal(languages=["English", "Chinese"])]))
            with patch.multiple(api, DATA_DIR=root, INDEX=None, INDEX_FINGERPRINT=None, INDEX_ERROR=None):
                with self.assertRaisesRegex(RuntimeError, "publication scope"):
                    api.load_documents()
                with self.assertRaises(HTTPException) as error:
                    api.sources()
                self.assertEqual(error.exception.status_code, 503)

    def test_loaded_documents_keep_their_own_dated_index_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data-manifest.json").write_text(json.dumps(MANIFEST))
            (root / "journals.json").write_text(json.dumps([journal()]))
            (root / "rag_documents.jsonl").write_text(json.dumps({
                "doc_id": "test-doc", "journal_id": "journal-test", "journal_name": "Example Education Journal",
                "source_url": "https://example.org/article", "source_type": "article", "title": "Teaching research",
                "text_snippet": "A teaching study.",
            }) + "\n")
            with patch.multiple(api, DATA_DIR=root, INDEX=None, INDEX_FINGERPRINT=None, INDEX_ERROR=None):
                index = api.load_documents()
                document = index.documents[0]
                self.assertEqual(document.indexes, ("SSCI", "Scopus"))
                self.assertEqual(index.data_version, "scope-test")
                index.journals["journal-test"]["indexes"] = ["ESCI"]
                with patch.object(api, "load_documents", side_effect=AssertionError("Context must not reload data")):
                    context = api.context_for([(document, 2.0)])
                self.assertIn("数据库收录：SSCI, Scopus", context)
                self.assertIn('"snapshot_date": "2026-06"', context)
                self.assertIn('"source_url": "https://example.org/index.xlsx"', context)

    def test_llm_receives_authoritative_snapshot_dates_separate_from_retrieval_and_metric_year(self):
        for dated in (True, False):
            with self.subTest(dated=dated):
                document = api.Document("d", "j", "Journal", "https://example.org", "journal_index", "JCR 2025", "JIF metric year 2025", [], Counter(), 1)
                document.indexes = ("SSCI",)
                document.index_evidence = ({
                    "index": "SSCI", "source": "UEFISCDI published JCR 2025 list (June 2026 release)",
                    "url": "https://example.org/JCR2025.xlsx", "retrieved_at": "2026-10-02",
                    **({"snapshot_date": "2026-06"} if dated else {}),
                },)
                settings = {
                    "provider": "modelscope", "model": "test-model", "token": "mock-token-no-network",
                    "api_base": "https://api-inference.modelscope.cn/v1", "max_tokens": 1100, "temperature": 0.2, "timeout": 10,
                }
                with patch.object(api, "llm_settings", return_value=settings), patch.object(api.LLM_HTTP_OPENER, "open") as send:
                    response = send.return_value.__enter__.return_value
                    response.headers = {}
                    response.read.return_value = b'{"choices":[{"message":{"content":"mocked answer"}}]}'
                    api.call_llm("期刊索引快照日期是什么？", [(document, 1.0)])
                    sent = json.loads(send.call_args.args[0].data)
                content = sent["messages"][1]["content"]
                prefix = "索引快照权威记录（JSON）："
                record = json.loads(next(line.removeprefix(prefix) for line in content.splitlines() if line.startswith(prefix)))
                self.assertEqual(record["snapshot_date"], "2026-06" if dated else None)
                self.assertEqual(record["retrieved_at"], "2026-10-02")
                self.assertIn("JCR 2025", record["source_label"])
                self.assertIn("是指标版次年份，不是其发布日期或快照年份", sent["messages"][0]["content"])
                self.assertIn("snapshot_date为空时须说快照日期未记录", sent["messages"][0]["content"])

    def test_legacy_documents_and_unsafe_index_urls_do_not_break_context(self):
        document = api.Document("d", "j", "Journal", "https://example.org", "article", "Title", "Text", [], Counter(), 1)
        self.assertIn("数据库收录：未记录", api.context_for([(document, 1.0)]))
        document.indexes = ("Scopus",)
        document.index_evidence = (
            {"index": "Scopus", "url": "javascript:alert(1)"},
            {"index": "Scopus", "url": "https://[bad-ip"},
            {"index": "Scopus", "url": "https://user:secret@example.org"},
        )
        context = api.context_for([(document, 1.0)])
        self.assertNotIn("javascript:", context)
        self.assertNotIn("secret", context)


if __name__ == "__main__":
    unittest.main()
