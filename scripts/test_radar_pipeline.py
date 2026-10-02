"""Offline regressions for catalog expansion, retention, and partitioned publishing."""
from __future__ import annotations

import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from radar_pipeline import (article_key, merge_articles, merge_journal_catalog, normalize_journal,
                            read_partitioned, rotation_indexes, safe_shard_path)

spec = importlib.util.spec_from_file_location("radar_generator", Path(__file__).with_name("generate-research-radar.py"))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

BASE = {
    "id": "journal-001-original", "rank": 1, "name": "Original Education Journal",
    "jif_2025": 3.2, "jci_2025": 1.4, "quartile": "Q1", "publications": {"2025": 87},
    "issn": "1234-567X", "eissn": "", "main_tag": "Educational technology",
    "publisher": "Original publisher", "publisher_family": "Original publisher", "source_urls": [],
}
EXTRA = {
    "id": "journal-issn-23456789", "name": "New Education Journal", "issn": "2345-6789",
    "publisher": "New publisher", "main_tag": "Teacher education", "source_urls": [],
    "catalog_sources": [{"id": "doaj", "label": "DOAJ", "url": "https://doaj.org/", "record_id": "example", "retrieved_at": "2026-09-01T00:00:00+00:00"}],
}
ARTICLE = {
    "journal_id": BASE["id"], "journal_name": BASE["name"], "title": "Teacher learning and feedback",
    "doi": "10.1234/Original", "url": "https://doi.org/10.1234/Original", "abstract": "Teacher education evidence.",
    "keywords": "teacher education", "year": 2025, "month": 4, "volume": "12", "issue": "2",
    "status": "ok", "source": "crossref", "captured_at": "2026-08-01T00:00:00+00:00",
}


class PipelineUnitTests(unittest.TestCase):
    def test_index_rag_preserves_source_snapshot_and_separate_index_claims(self):
        shared_url = "https://example.org/index-list.xlsx"
        journal = {**BASE, "indexes": ["SSCI", "ESCI"], "index_evidence": [
            {"index": index, "source": "Published index list", "snapshot_date": "2026-06", "retrieved_at": "2026-10-02", "url": shared_url, "row": position}
            for position, index in enumerate(["SSCI", "ESCI"], 1)
        ]}
        documents = generator.base_documents(journal, "today")
        proofs = [row for row in documents if row["source_type"] == "journal_index"]
        self.assertEqual(len({row["doc_id"] for row in proofs}), 2)
        for row in proofs:
            self.assertIn("Published index list", row["title"])
            self.assertIn("2026-06", row["title"])
            self.assertIn(f"Verified index: {row['index']}", row["text_snippet"])
            self.assertIn("Index snapshot date: 2026-06", row["text_snippet"])
            self.assertEqual(row["captured_at"], "2026-10-02")

    def test_multilingual_network_ids_are_stable_distinct_and_safe(self):
        names = ["Maria Curie-Skłodowska University", "华东师范大学", "华中师范大学"]
        journals = [{**BASE, "id": f"journal-{number}", "publisher_family": name} for number, name in enumerate(names)]
        network = generator.build_network(journals, {}, {})
        publishers = [node for node in network["nodes"] if node["type"] == "publisher"]
        self.assertEqual({node["label"] for node in publishers}, set(names))
        self.assertEqual(len({node["id"] for node in publishers}), 3)
        for node in publishers:
            self.assertRegex(node["id"], r"^publisher-[0-9a-f]{16}$")
        self.assertEqual(network, generator.build_network(journals, {}, {}))

    def test_merge_preserves_original_id_metrics_and_unions_provenance(self):
        overlap = {**EXTRA, "id": "journal-issn-1234567X", "issn": BASE["issn"], "jif_2025": 999, "quartile": "Q4", "languages": ["English"]}
        original = copy.deepcopy(BASE)
        merged = merge_journal_catalog([BASE], [overlap, EXTRA])
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["id"], BASE["id"])
        for field in ("jif_2025", "jci_2025", "quartile", "publications"):
            self.assertEqual(merged[0][field], BASE[field])
        self.assertEqual(merged[0]["name"], BASE["name"])
        self.assertEqual(merged[0]["catalog_sources"], EXTRA["catalog_sources"])
        self.assertEqual(merged[0]["languages"], ["English"])
        self.assertEqual(BASE, original)

    def test_catalog_inclusion_never_creates_jcr_metrics(self):
        new = normalize_journal({**EXTRA, "jif_2025": 6, "jci_2025": 8, "quartile": "Q1"})
        self.assertFalse(new["has_jcr_record"])
        for field in ("jif_2025", "jci_2025", "quartile", "metrics_year"):
            self.assertIsNone(new[field])

    def test_verified_historical_issn_is_not_reintroduced_as_current_by_workbook(self):
        incoming = {**EXTRA, "id": BASE["id"], "issn": "2982-1215", "eissn": "2982-1223", "historical_issns": [BASE["issn"]]}
        merged = merge_journal_catalog([BASE], [incoming])[0]
        self.assertEqual(merged["id"], BASE["id"])
        self.assertEqual(merged["jif_2025"], BASE["jif_2025"])
        self.assertEqual(merged["issn"], "2982-1215")
        self.assertNotIn(BASE["issn"], merged["issns"])
        self.assertEqual(merged["historical_issns"], [BASE["issn"]])

    def test_ambiguous_issn_bridge_is_rejected(self):
        second = {**BASE, "id": "journal-002-second", "issn": "9876-5432"}
        incoming = {**EXTRA, "issns": [BASE["issn"], second["issn"]]}
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            merge_journal_catalog([BASE, second], [incoming])

    def test_rotation_wraps_and_eventually_visits_every_journal(self):
        self.assertEqual(rotation_indexes(5, 3, 4), [4, 0, 1])
        self.assertEqual(rotation_indexes(0, 3, 0), [])
        self.assertEqual(rotation_indexes(5, 0, 0), [0, 1, 2, 3, 4])
        cursor, seen = 0, set()
        for _ in range(13):
            batch = rotation_indexes(3376, 500, cursor)
            seen.update(batch)
            cursor = (batch[-1] + 1) % 3376
        self.assertEqual(len(seen), 3376)

    def test_failed_empty_and_skipped_incoming_preserve_old_timestamp(self):
        for incoming in ([], [{**ARTICLE, "status": "failed", "captured_at": "later"}], [{"status": "ok", "title": ""}]):
            result = merge_articles([ARTICLE], incoming)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]["captured_at"], ARTICLE["captured_at"])
            self.assertEqual(result[0]["abstract"], ARTICLE["abstract"])

    def test_doi_deduplication_is_case_and_url_prefix_insensitive(self):
        incoming = {**ARTICLE, "doi": "https://doi.org/10.1234/ORIGINAL", "abstract": "", "captured_at": "2026-09-01T00:00:00+00:00"}
        result = merge_articles([ARTICLE], [incoming])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["doi"], "10.1234/original")
        self.assertEqual(result[0]["abstract"], ARTICLE["abstract"])
        self.assertEqual(result[0]["captured_at"], incoming["captured_at"])
        self.assertEqual(article_key({**ARTICLE, "doi": ""}), article_key(ARTICLE))

    def test_older_cached_response_cannot_overwrite_newer_capture(self):
        older = {**ARTICLE, "title": "Older title", "captured_at": "2026-07-01T00:00:00Z"}
        result = merge_articles([ARTICLE], [older])
        self.assertEqual(result[0]["title"], ARTICLE["title"])
        self.assertEqual(result[0]["captured_at"], ARTICLE["captured_at"])

    def test_safe_paths_reject_traversal_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            with self.assertRaises(ValueError):
                safe_shard_path(root, "../outside.jsonl", "journal_articles", BASE["id"], ".jsonl")
            (root / "journal_articles").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                safe_shard_path(root, f"journal_articles/{BASE['id']}.jsonl", "journal_articles", BASE["id"], ".jsonl")

    def test_cache_retry_and_cache_only_reuse(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _): return b'{"message":{"items":[]}}'
        error = HTTPError("https://api.crossref.org/test", 429, "Rate limit", {"Retry-After": "1"}, io.BytesIO())
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(generator, "urlopen", side_effect=[error, Response()]) as opened, patch.object(generator.time, "sleep") as sleep:
                first, first_error = generator.request_json("https://api.crossref.org/test", 1, Path(directory))
                self.assertEqual(opened.call_count, 2)
                sleep.assert_called_once_with(1.0)
                self.assertIsNone(first_error)
            with patch.object(generator, "urlopen", side_effect=AssertionError("No duplicate network request")):
                second, second_error = generator.request_json("https://api.crossref.org/test", 1, Path(directory), True)
            self.assertEqual(first, second)
            self.assertEqual(first_error, second_error)
            self.assertIn("_radar_cache_captured_at", second)

    def test_budget_deferral_never_starts_network_and_does_not_advance_cursor(self):
        with patch.object(generator.time, "monotonic", return_value=100), patch.object(generator, "fetch_crossref_articles", side_effect=AssertionError("No network")):
            result = generator.refresh_journal(BASE, None, "now", True, True, 1)
        self.assertEqual(result["api_status"], "budget_deferred")
        self.assertEqual(result["official_status"], "budget_deferred")
        self.assertEqual(generator.advance_cursor([0], [BASE], {BASE["id"]: result}, "api_status", 0), 0)

    def test_publish_refuses_to_delete_unrecognized_files(self):
        with tempfile.TemporaryDirectory() as directory:
            destination, staging = Path(directory) / "output", Path(directory) / "staging"
            destination.mkdir()
            staging.mkdir()
            (destination / "unrelated-note.txt").write_text("Preserve me")
            with self.assertRaisesRegex(ValueError, "unrecognized"):
                generator.publish_staging(staging, destination)
            self.assertEqual((destination / "unrelated-note.txt").read_text(), "Preserve me")
            self.assertTrue(staging.exists())

    def test_nonlatin_publishers_and_topics_do_not_collide(self):
        left = normalize_journal({**EXTRA, "publisher_family": "北京出版社", "main_tag": "高等教育"})
        right = normalize_journal({**EXTRA, "id": "journal-another", "publisher_family": "上海出版社", "main_tag": "职业教育"})
        network = generator.build_network([left, right], {}, {})
        self.assertEqual(len([n for n in network["nodes"] if n["type"] == "publisher"]), 2)
        self.assertEqual(len([n for n in network["nodes"] if n["type"] == "topic"]), 2)


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.output = self.root / "radar"
        self.output.mkdir()
        self.snapshot = self.root / "jcr.json"
        self.snapshot.write_text(json.dumps([BASE]))
        self.catalog = self.root / "catalog.json"
        self.catalog.write_text(json.dumps([EXTRA]))
        self.index_evidence = self.root / "index-evidence.json"
        self.index_evidence.write_text(json.dumps({"schema_version": 1, "journals": {
            row["id"]: {"languages": ["English"], "indexes": ["Scopus"],
                        "evidence": [{"url": "https://www.elsevier.com/products/scopus/content"}]}
            for row in [BASE, EXTRA]
        }}))
        (self.output / "journals.json").write_text(json.dumps([BASE]))
        (self.output / "journal_articles.jsonl").write_text(json.dumps(ARTICLE) + "\n")
        (self.output / "rag_documents.jsonl").write_text(json.dumps({"doc_id": "legacy-doc", "journal_id": BASE["id"], "journal_name": BASE["name"], "title": ARTICLE["title"], "text_snippet": "Old metadata", "source_type": "article_metadata", "captured_at": ARTICLE["captured_at"]}) + "\n")
        self.arguments = ["generator", "--excel", str(self.root / "absent.xlsx"), "--source-snapshot", str(self.snapshot), "--catalog", str(self.catalog), "--index-evidence", str(self.index_evidence), "--output", str(self.output), "--max-pages-per-journal", "0", "--max-editor-pages", "0", "--article-journal-limit", "0", "--workers", "2"]

    def tearDown(self):
        self.temporary.cleanup()

    def generate(self, *arguments):
        with patch.object(sys, "argv", self.arguments + list(arguments)):
            self.assertEqual(generator.main(), 0)

    def read(self, filename):
        return json.loads((self.output / filename).read_text())

    def test_offline_migration_then_partitioned_rebuild_preserves_evidence(self):
        with patch.object(generator, "urlopen", side_effect=AssertionError("Offline generation must not request network")):
            self.generate("--skip-crawl")
            first = read_partitioned(self.output, "journal_articles")
            self.generate("--skip-crawl")
        self.assertEqual(first, read_partitioned(self.output, "journal_articles"))
        self.assertEqual(first[BASE["id"]][0]["captured_at"], ARTICLE["captured_at"])
        self.assertEqual(self.read("data-manifest.json")["journal_count"], 2)
        self.assertTrue(self.read("crawl_report.json")["baseline_preservation"]["metrics_preserved"])
        for old in ("journal_preferences.json", "journal_articles.jsonl", "rag_documents.jsonl"):
            self.assertFalse((self.output / old).exists())
        rag = read_partitioned(self.output, "rag_documents")
        self.assertTrue(any(doc["source_type"] == "journal_catalog" for doc in rag[EXTRA["id"]]))
        self.assertFalse(any(doc["source_type"] == "jcr_workbook" for doc in rag[EXTRA["id"]]))
        self.assertEqual(set(self.read("journal_preferences_index.json")["journals"]), {BASE["id"], EXTRA["id"]})

    def test_failed_and_empty_api_keep_previous_evidence(self):
        for response in (({}, "HTTP 429"), ({"message": {"items": []}}, None)):
            with patch.object(generator, "request_json", return_value=copy.deepcopy(response)):
                self.generate()
            articles = read_partitioned(self.output, "journal_articles")
            self.assertEqual(len(articles[BASE["id"]]), 1)
            self.assertEqual(articles[BASE["id"]][0]["captured_at"], ARTICLE["captured_at"])
            self.assertEqual(self.read("crawl_report.json")["refresh_policy"]["article_failed"], 2)

    def test_scope_excludes_chinese_baseline_but_preserves_complete_source_snapshot(self):
        self.snapshot.write_text(json.dumps([{**BASE, "languages": ["Chinese"]}]))
        self.generate("--skip-crawl")
        self.generate("--skip-crawl")
        self.assertEqual([row["id"] for row in self.read("journals.json")], [EXTRA["id"]])
        self.assertEqual(self.read("source_workbook_snapshot.json")[0]["id"], BASE["id"])
        self.assertEqual(self.read("data-manifest.json")["jcr_journal_count"], 0)
        self.assertEqual(self.read("journal-scope-audit.json")["excluded"][0]["reason"], "chinese_language")
        self.assertFalse(self.read("crawl_report.json")["baseline_preservation"]["all_ids_preserved"])
        self.assertTrue(self.read("crawl_report.json")["baseline_preservation"]["source_snapshot_preserved"])

    def test_missing_index_evidence_fails_before_replacing_existing_output(self):
        before = (self.output / "journals.json").read_bytes()
        self.index_evidence.unlink()
        with self.assertRaises(SystemExit):
            self.generate("--skip-crawl")
        self.assertEqual((self.output / "journals.json").read_bytes(), before)

    def test_skip_article_api_keeps_previous_evidence(self):
        with patch.object(generator, "request_json", side_effect=AssertionError("API skipped")):
            self.generate("--skip-article-api")
        self.assertEqual(len(read_partitioned(self.output, "journal_articles")[BASE["id"]]), 1)

    def test_cached_response_date_is_preserved_in_articles_and_rag(self):
        fetched = "2026-09-02T12:00:00+00:00"
        def response(url, *_):
            suffix = "original" if BASE["issn"] in url else "new"
            return {"_radar_cache_captured_at": fetched, "message": {"items": [{"DOI": f"10.1234/{suffix}", "title": ["New teacher learning study"], "published": {"date-parts": [[2026, 9]]}}]}}, None
        with patch.object(generator, "request_json", side_effect=response):
            self.generate()
        articles = read_partitioned(self.output, "journal_articles")
        for id in (BASE["id"], EXTRA["id"]):
            self.assertEqual(articles[id][0]["captured_at"], fetched)
            metadata = [doc for doc in read_partitioned(self.output, "rag_documents")[id] if doc["source_type"] == "article_metadata"]
            self.assertEqual(metadata[0]["captured_at"], fetched)
        self.assertEqual(self.read("journals.json")[0]["article_refresh"]["last_success_at"], fetched)

    def test_validator_rejects_corrupt_counts_paths_and_baseline_metrics(self):
        self.generate("--skip-crawl")
        validator = str(Path(generator.__file__).with_name("validate-data.mjs"))
        index_path = self.output / "journal_articles_index.json"
        original = index_path.read_text()
        for changed in ({"path": "../../private.jsonl", "count": 1}, {"path": f"journal_articles/{BASE['id']}.jsonl", "count": 999}):
            index = json.loads(original)
            index["journals"][BASE["id"]] = changed
            index_path.write_text(json.dumps(index))
            result = subprocess.run(["node", validator, "--data-dir", str(self.output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
        index_path.write_text(original)
        journals = self.read("journals.json")
        journals[0]["jif_2025"] = 99
        (self.output / "journals.json").write_text(json.dumps(journals))
        result = subprocess.run(["node", validator, "--data-dir", str(self.output)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("baseline", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()
