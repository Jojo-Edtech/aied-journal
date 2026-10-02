import json
from pathlib import Path
import tempfile
import unittest
from collections import Counter
from unittest.mock import patch

from research_radar_api import app as radar
from research_radar_api.catalog_retrieval import identity_match, iter_rag_records, matches_constraints, query_constraints


def journal(identifier, name, **extra):
    return {"id": identifier, "name": name, "languages": [], "catalog_sources": [], "quartile": None, **extra}


def document(j, text, number=0):
    tokens = radar.tokenize(j["name"] + " " + " ".join(j.get("aliases", [])) + " " + " ".join(j["languages"]) + " " + text)
    return radar.Document(f'{j["id"]}-{number}', j["id"], j["name"], "https://doaj.org/toc/example", "catalog_directory", j["name"], text, tokens, Counter(tokens), max(1, len(tokens)))


class CatalogRetrievalTests(unittest.TestCase):
    def test_chinese_name_alias_and_issn_match(self):
        item = journal("cn", "教育研究", aliases=["教育研究旧刊名"], issn="1000-1234")
        for query in ["请介绍教育研究", "教育研究旧刊名现在叫什么", "10001234有哪些文章"]:
            self.assertTrue(identity_match(item, query))
        self.assertFalse(identity_match(item, "研究生的教育怎么样"))

    def test_explicit_constraints_remain_intersected(self):
        cn = journal("cn", "教育研究", languages=["Chinese"], catalog_sources=[{"id": "ncpssd"}])
        self.assertTrue(matches_constraints(cn, query_constraints("中文 未核验 NCPSSD 期刊")))
        for query in ["英文期刊", "中文DOAJ期刊", "中文Q1期刊"]:
            self.assertFalse(matches_constraints(cn, query_constraints(query)))

    def test_tail_journal_retrieved_and_sources_preserved(self):
        journals = [journal(str(n), f"General Education Journal {n}") for n in range(3300)]
        target = journal("tail", "教育研究", aliases=["中华教育研究"], languages=["Chinese"], catalog_sources=[{"id": "ncpssd"}])
        journals.append(target)
        index = radar.RadarIndex([document(j, "education research") for j in journals], {j["id"]: j for j in journals})
        found = index.search("中华教育研究的投稿主题", 8)
        self.assertEqual(found[0][0].journal_id, "tail")
        self.assertEqual(found[0][0].source_type, "catalog_directory")
        self.assertTrue(found[0][0].source_url.startswith("https://doaj.org/"))

    def test_filters_never_fall_back_to_disallowed_journals(self):
        cn = journal("cn", "教育技术", languages=["Chinese"], quartile=None)
        en = journal("en", "Education Technology", languages=["English"], quartile="Q1")
        index = radar.RadarIndex([document(cn, "technology"), document(en, "technology")], {"cn": cn, "en": en})
        self.assertEqual(index.search("中文Q1 technology", 8), [])
        self.assertEqual([d.journal_id for d, _ in index.search("中文未核验 technology", 8)], ["cn"])

    def indexed_fixture(self):
        base = {"languages": ["English"], "quartile": "Q1", "has_jcr_record": True}
        rows = [
            journal("social", "Social Education Review", **base, indexes=["SSCI"]),
            journal("emerging", "Emerging Education Review", **base, indexes=["ESCI"]),
            journal("abstracts", "Education Abstracts Review", **base, indexes=["Scopus"]),
            journal("overlap", "Education Practice Review", **base, indexes=["SSCI", "Scopus"]),
            journal("other-language", "Education Across Languages", **{**base, "languages": ["Chinese"]}, indexes=["SSCI", "Scopus"]),
            journal("other-quartile", "Education Research Review", **{**base, "quartile": "Q2"}, indexes=["ESCI"]),
            journal("metrics-only", "Metric Only Education Review", **base, jif_2025=99, catalog_sources=[{"id": "doaj"}]),
        ]
        return rows, radar.RadarIndex([document(row, "digital learning") for row in rows], {row["id"]: row for row in rows})

    def test_explicit_index_filters_reach_retrieval_results(self):
        rows, index = self.indexed_fixture()
        expected = {
            "SSCI": {"social", "overlap", "other-language"},
            "ESCI": {"emerging", "other-quartile"},
            "Scopus": {"abstracts", "overlap", "other-language"},
        }
        for membership, ids in expected.items():
            with self.subTest(index=membership):
                query = f"{membership} digital learning journals"
                constraints = query_constraints(query)
                self.assertEqual(constraints["indexes"], [membership])
                self.assertEqual({row["id"] for row in rows if matches_constraints(row, constraints)}, ids)
                self.assertEqual({doc.journal_id for doc, _ in index.search(query, 20)}, ids)

    def test_multiple_indexes_are_or_and_other_constraints_still_intersect(self):
        rows, index = self.indexed_fixture()
        for query, expected in [
            ("英文期刊 Q1 SSCI 或 ESCI digital learning", {"social", "emerging", "overlap"}),
            ("English journals Q1 SSCI or ESCI digital learning", {"social", "emerging", "overlap"}),
            ("English journals Q1 SSCI or Scopus digital learning", {"social", "abstracts", "overlap"}),
        ]:
            with self.subTest(query=query):
                constraints = query_constraints(query)
                self.assertEqual({row["id"] for row in rows if matches_constraints(row, constraints)}, expected)
                self.assertEqual({doc.journal_id for doc, _ in index.search(query, 20)}, expected)
        self.assertEqual(index.search("英文期刊 Q4 SSCI 或 Scopus digital learning", 20), [])

    def test_jcr_and_doaj_do_not_imply_index_membership(self):
        rows, index = self.indexed_fixture()
        item = next(row for row in rows if row["id"] == "metrics-only")
        self.assertTrue(identity_match(item, "Metric Only Education Review"))
        for membership in ["SSCI", "ESCI", "Scopus"]:
            with self.subTest(index=membership):
                query = f"Metric Only Education Review {membership}"
                self.assertFalse(matches_constraints(item, query_constraints(query)))
                self.assertNotIn("metrics-only", {doc.journal_id for doc, _ in index.search(query, 20)})

    def test_no_unrelated_source_boost_and_diverse_candidates(self):
        a, b = journal("a", "Learning Sciences"), journal("b", "Education Research")
        docs = [document(a, "digital learning", n) for n in range(12)] + [document(b, "digital learning")]
        index = radar.RadarIndex(docs, {"a": a, "b": b})
        self.assertEqual(index.search("volcanologyxyz", 8), [])
        self.assertEqual(len(index.search("digital learning", 8)), 2)

    def write_fixture(self, root, version="v1", title="Education Research"):
        (root / "rag_documents").mkdir(exist_ok=True)
        (root / "journals.json").write_text(json.dumps([journal("a", title)]))
        (root / "data-manifest.json").write_text(json.dumps({"data_version": version}))
        (root / "rag_documents_index.json").write_text(json.dumps({"data_version": version, "journals": {"a": {"path": "rag_documents/a.jsonl", "count": 1}}}))
        (root / "rag_documents/a.jsonl").write_text(json.dumps({"doc_id": "a-catalog", "journal_id": "a", "journal_name": title, "title": title, "source_type": "catalog_directory", "source_url": "https://doaj.org/", "text_snippet": "Education research"}) + "\n")

    def test_index_reloads_when_manifest_version_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_fixture(root)
            with patch.object(radar, "DATA_DIR", root), patch.object(radar, "INDEX", None), patch.object(radar, "INDEX_FINGERPRINT", None):
                first = radar.load_documents()
                self.assertIs(first, radar.load_documents())
                self.write_fixture(root, "v2", "Changed Education Journal")
                second = radar.load_documents()
                self.assertIsNot(first, second)
                self.assertEqual(second.data_version, "v2")
                self.assertEqual(second.journals["a"]["name"], "Changed Education Journal")

    def test_shard_manifest_rejects_path_identity_count_or_version_errors(self):
        cases = [
            {"path": "../outside.jsonl", "count": 1},
            {"path": "rag_documents/a.jsonl", "count": 2},
            {"path": "rag_documents/a.jsonl", "count": -1},
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for info in cases:
                self.write_fixture(root)
                index = json.loads((root / "rag_documents_index.json").read_text())
                index["journals"]["a"] = info
                (root / "rag_documents_index.json").write_text(json.dumps(index))
                with self.assertRaises(ValueError):
                    list(iter_rag_records(root, {"a"}))
            self.write_fixture(root)
            with self.assertRaises(ValueError):
                list(iter_rag_records(root, {"other"}))
            (root / "data-manifest.json").write_text('{"data_version":"different"}')
            with self.assertRaises(ValueError):
                list(iter_rag_records(root, {"a"}))


if __name__ == "__main__":
    unittest.main()
