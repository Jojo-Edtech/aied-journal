"""Regressions for fail-closed journal scope and source-bound indexes."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from journal_scope import apply_journal_scope, load_index_evidence


class JournalScopeTests(unittest.TestCase):
    def journal(self, identity="journal-example", **overrides):
        return {"id": identity, "name": "Education Journal", **overrides}

    def evidence(self, journal, **overrides):
        return {"schema_version": 1, "journals": {journal["id"]: {
            "languages": ["English"], "indexes": ["Scopus"],
            "evidence": [{"url": "https://www.elsevier.com/products/scopus/content"}], **overrides,
        }}}

    def test_chinese_is_excluded_even_when_new_source_says_english(self):
        journal = self.journal(languages=["Chinese"])
        rows, audit = apply_journal_scope([journal], self.evidence(journal))
        self.assertEqual(rows, [])
        self.assertEqual(audit["excluded"][0]["reason"], "chinese_language")
        self.assertEqual(audit["excluded"][0]["languages"], ["Chinese", "English"])

    def test_unknown_language_is_not_inferred_from_title_country_or_index(self):
        journal = self.journal(country="United States", languages=[])
        rows, audit = apply_journal_scope([journal], self.evidence(journal, languages=[]))
        self.assertEqual(rows, [])
        self.assertEqual(audit["excluded"][0]["reason"], "english_language_unverified")

    def test_jcr_metrics_and_stale_indexes_do_not_imply_allowed_index(self):
        journal = self.journal(languages=["English"], has_jcr_record=True, jif_2025=12.3, indexes=["SSCI"])
        rows, audit = apply_journal_scope([journal], {"journals": {}})
        self.assertEqual(rows, [])
        self.assertEqual(audit["excluded"][0]["reason"], "allowed_index_unverified")

    def test_index_union_keeps_multiple_memberships_and_original_data_unchanged(self):
        journal = self.journal(languages=["English", "French"], jif_2025=1.2)
        before = copy.deepcopy(journal)
        rows, audit = apply_journal_scope([journal], self.evidence(journal, indexes=["Scopus", "ssci", "SSCI", "SCIE"]))
        self.assertEqual(rows[0]["indexes"], ["SSCI", "Scopus"])
        self.assertEqual(rows[0]["languages"], ["English", "French"])
        self.assertEqual(rows[0]["jif_2025"], 1.2)
        self.assertEqual(audit["index_counts"], {"SSCI": 1, "ESCI": 0, "Scopus": 1})
        self.assertEqual(journal, before)

    def test_english_from_existing_source_can_complement_index_proof(self):
        journal = self.journal(languages=["English"])
        rows, _ = apply_journal_scope([journal], self.evidence(journal, languages=[]))
        self.assertEqual(len(rows), 1)

    def test_mixed_language_aliases_preserve_chinese_exclusion(self):
        journal = self.journal(languages=["zh"])
        rows, audit = apply_journal_scope([journal], self.evidence(journal, languages=["en"]))
        self.assertEqual(rows, [])
        self.assertEqual(audit["excluded"][0]["reason"], "chinese_language")

    def test_identity_ambiguity_overrides_english_and_verified_ssci(self):
        journal = self.journal(languages=["English"], has_jcr_record=True)
        evidence = self.evidence(journal, indexes=["SSCI", "Scopus"])
        evidence["excluded_journal_ids"] = {journal["id"]: "identity_ambiguity"}
        rows, audit = apply_journal_scope([journal], evidence)
        self.assertEqual(rows, [])
        self.assertEqual(audit["excluded"][0]["reason"], "identity_ambiguity")
        self.assertEqual(audit["identity_exclusions"], evidence["excluded_journal_ids"])

    def test_missing_malformed_or_unbacked_evidence_fails_closed(self):
        journal = self.journal()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index-evidence.json"
            with self.assertRaises(FileNotFoundError):
                load_index_evidence(path)
            for value in ({"journals": {}}, self.evidence(journal, evidence=[]), self.evidence(journal, evidence=[{"url": "file:///secret"}])):
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    load_index_evidence(path)
            path.write_text(json.dumps(self.evidence(journal)))
            payload, fingerprint = load_index_evidence(path)
            self.assertEqual(payload["journals"][journal["id"]]["indexes"], ["Scopus"])
            self.assertRegex(fingerprint, r"^[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
