import importlib.util
import json
from copy import deepcopy
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("catalog", Path(__file__).with_name("build-education-catalog.py"))
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


def record(name="Education Studies", issn="1470-1294", source="doaj", source_id="a"):
    return catalog.make_record(source, source_id, name, issn, "", "Example University", ["English"], "United Kingdom",
        ["Education"], [], ["https://example.org/journal"], "https://doaj.org/toc/a", "2026-09-29T00:00:00Z")


def identity_proof(name):
    path = Path(__file__).resolve().parents[1] / "data/catalog/sources/additional-identity-evidence.json"
    return next(row for row in json.loads(path.read_text()) if row["name"] == name)


class CatalogImportTests(unittest.TestCase):
    def test_issn_checksum_and_format(self):
        self.assertEqual(catalog.valid_issn("14701294"), "1470-1294")
        self.assertEqual(catalog.valid_issn("1470-1295"), "")
        self.assertEqual(catalog.valid_issn("123-456"), "")

    def test_existing_identity_retained_and_sources_merged(self):
        base = {**record(), "id": "journal-original", "jif_2025": 7, "quartile": "Q1"}
        first = record("Educational Studies", source="doaj")
        second = record("EDUCATIONAL STUDIES", source="ebsco_education", source_id="b")
        merged, _ = catalog.merge_records([first, second], [base])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["id"], "journal-original")
        self.assertEqual({s["id"] for s in merged[0]["catalog_sources"]}, {"doaj", "ebsco_education"})
        # Directory output cannot claim the workbook's metrics; the generator merges them separately.
        self.assertIsNone(merged[0]["jif_2025"])
        self.assertEqual(base["jif_2025"], 7)

    def test_same_title_conflicting_identifiers_do_not_collapse(self):
        a = record("Educational Research", "0013-1881")
        b = record("Educational Research", "2637-8965", source_id="b")
        b["publisher"] = "Different Publisher"
        b["publisher_family"] = "Different Publisher"
        merged, audit = catalog.merge_records([a, b], [])
        self.assertEqual(len(merged), 2)
        self.assertTrue(audit["ambiguous"])

    def test_stable_across_rebuild_and_new_source(self):
        a = record()
        first, _ = catalog.merge_records([a], [])
        second, _ = catalog.merge_records([a, record(source="ebsco_education", source_id="second")], [], first)
        self.assertEqual([x["id"] for x in first], [x["id"] for x in second])

    def test_source_record_identity_survives_rename_and_new_issn(self):
        before = record("旧教育学报", "", source="ncpssd", source_id="ncpssd:stable-url")
        first, _ = catalog.merge_records([before], [])
        after = record("新教育学报", "1470-1294", source="ncpssd", source_id="ncpssd:stable-url")
        rebuilt, audit = catalog.merge_records([after], [], first)
        self.assertEqual(rebuilt[0]["id"], first[0]["id"])
        self.assertEqual(rebuilt[0]["name"], "新教育学报")
        self.assertEqual(rebuilt[0]["issns"], ["1470-1294"])
        self.assertIn("旧教育学报", rebuilt[0]["aliases"])
        self.assertEqual(audit["merges"][0]["basis"], "source_record_identity")

    def test_enriched_source_identity_wins_over_new_issn_identity_then_deduplicates(self):
        old = record("旧教育学报", "", source="ncpssd", source_id="stable")
        registry, _ = catalog.merge_records([old], [])
        enriched = record("新教育学报", "1470-1294", source="ncpssd", source_id="stable")
        other_source = record("New Education Journal", "1470-1294", source="doaj", source_id="new")
        merged, _ = catalog.merge_records([enriched, other_source], [], registry)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["id"], registry[0]["id"])
        self.assertEqual({source["id"] for source in merged[0]["catalog_sources"]}, {"doaj", "ncpssd"})
        again, _ = catalog.merge_records([other_source, enriched], [], merged)
        self.assertEqual(again[0]["id"], registry[0]["id"])

    def test_source_identity_cannot_override_original_jcr_identity(self):
        baseline = {**record(), "id": "journal-original-jcr"}
        prior = {**record("旧教育学报", "", source="ncpssd", source_id="stable"), "id": "journal-catalog-old"}
        enriched = record("新教育学报", "1470-1294", source="ncpssd", source_id="stable")
        merged, _ = catalog.merge_records([enriched], [baseline], [prior])
        self.assertEqual(merged[0]["id"], baseline["id"])

    def test_identifier_evidence_is_merged_deduplicated_and_kept_across_sparse_refresh(self):
        first = record(source_id="first")
        second = record(source="ebsco_education", source_id="second")
        a = {"source": "crossref", "url": "https://api.crossref.org/journals/1470-1294", "issns": ["1470-1294"]}
        b = {"source": "ncpssd", "url": "https://www.ncpssd.org/journal/details?x=1", "issns": ["1470-1294"]}
        first["identifier_evidence"] = [a]
        second["identifier_evidence"] = [a, b]
        merged, _ = catalog.merge_records([first, second], [])
        self.assertEqual(len(merged[0]["identifier_evidence"]), 2)
        sparse = record(source_id="first")
        refreshed, _ = catalog.merge_records([sparse], [], merged)
        self.assertEqual(refreshed[0]["identifier_evidence"], merged[0]["identifier_evidence"])

    def test_crossref_crosswalk_accepts_verified_same_title_identifiers(self):
        item = record()
        proof = {"query_issn": "1470-1294", "issns": ["1470-1294", "0013-1881"], "title": item["name"], "status": "ok", "evidence_url": "https://api.crossref.org/journals/1470-1294", "retrieved_at": "2026-09-29"}
        applied = catalog.apply_identifier_crosswalk([item], [proof])
        self.assertEqual(applied[0]["added_issns"], ["0013-1881"])
        self.assertEqual(set(item["issns"]), {"1470-1294", "0013-1881"})
        self.assertEqual(item["identifier_evidence"][0]["source"], "crossref")
        self.assertEqual(catalog.apply_identifier_crosswalk([item], [proof]), [])

    def test_crossref_crosswalk_rejects_unverified_or_conflicting_proof(self):
        proof = {"query_issn": "1470-1294", "issns": ["1470-1294", "0013-1881"], "title": "Education Studies", "status": "ok", "evidence_url": "https://api.crossref.org/journals/1470-1294"}
        invalid_variants = [
            {"status": "failed"}, {"title": "Different Journal"}, {"title": "Education"},
            {"issns": ["0013-1881"]}, {"issns": ["1470-1294", "1470-1295"]},
            {"evidence_url": ""}, {"evidence_url": "https://other.example/journals/1470-1294"},
            {"evidence_url": "https://api.crossref.org/journals/0013-1881"},
        ]
        for overrides in invalid_variants:
            with self.subTest(overrides=overrides):
                item = record()
                self.assertEqual(catalog.apply_identifier_crosswalk([item], [{**deepcopy(proof), **overrides}]), [])
                self.assertEqual(item["issns"], ["1470-1294"])
                self.assertNotIn("identifier_evidence", item)

    def test_reviewed_media_identity_unifies_different_publishers_and_preserves_retired_print(self):
        proof = identity_proof("Issues in Educational Research")
        first = record(proof["name"], proof["print_issn"], source_id="print")
        second = record(proof["name"], proof["online_issn"], source="ebsco_education", source_id="online")
        second["publisher"] = second["publisher_family"] = "Different catalogue publisher wording"
        prior, _ = catalog.merge_records([first, second], [])
        self.assertEqual(len(prior), 2)
        self.assertEqual(len(catalog.apply_additional_identity_evidence([first, second], [proof])), 2)
        merged, _ = catalog.merge_records([first, second], [], prior)
        self.assertEqual(len(merged), 1)
        self.assertIn(merged[0]["id"], {row["id"] for row in prior})
        self.assertEqual(catalog.record_issns(merged[0]), [proof["online_issn"]])
        self.assertEqual(merged[0]["historical_issns"], [proof["print_issn"]])
        self.assertEqual(merged[0]["issn"], "")
        self.assertEqual(set(catalog.identity_issns(merged[0])), set(proof["issns"]))
        self.assertEqual(len(merged[0]["identifier_evidence"]), 1)
        self.assertEqual(catalog.apply_additional_identity_evidence(merged, [proof]), [])

    def test_title_continuation_joins_original_jcr_id_without_relabelling_historical_issn(self):
        proof = identity_proof("Australian Journal of English Education")
        baseline = {**record(proof["name"], proof["print_issn"]), "id": proof["target_id_hint"], "jif_2025": 1.2, "quartile": "Q3"}
        baseline_before = deepcopy(baseline)
        old = record(proof["name"], proof["historical_issns"][0], source="ebsco_education", source_id="legacy")
        prior, _ = catalog.merge_records([old], [])
        catalog.apply_additional_identity_evidence([old], [proof])
        merged, _ = catalog.merge_records([old], [baseline], prior)
        self.assertEqual(merged[0]["id"], baseline["id"])
        self.assertEqual(catalog.record_issns(merged[0]), sorted(proof["current_issns"]))
        self.assertEqual(merged[0]["historical_issns"], proof["historical_issns"])
        self.assertIn(proof["historical_title"], merged[0]["aliases"])
        self.assertEqual(baseline, baseline_before)
        self.assertIsNone(merged[0]["jif_2025"])
        sparse = record(proof["name"], proof["historical_issns"][0], source="ebsco_education", source_id="legacy")
        refreshed, _ = catalog.merge_records([sparse], [baseline], merged)
        self.assertEqual(refreshed[0]["id"], baseline["id"])
        self.assertEqual(catalog.record_issns(refreshed[0]), sorted(proof["current_issns"]))
        self.assertEqual(refreshed[0]["historical_issns"], proof["historical_issns"])

    def test_unsupported_identity_proof_cannot_change_identifiers_or_force_hint_id(self):
        proof = identity_proof("TESOL in Context")
        variants = [{"status": "unconfirmed"}, {"safe_to_merge": False}, {"evidence": []},
            {"url": "https://unverified.example/ISSN-L/2209-0916"}, {"issn_l": "1470-1294"},
            {"issns": [proof["print_issn"], "1470-1295"]}, {"relation": "similar_title"},
            {"current_issns": [proof["online_issn"]]}, {"historical_issns": [proof["print_issn"]]}]
        for override in variants:
            with self.subTest(override=override):
                item = record(proof["name"], proof["print_issn"])
                before = deepcopy(item)
                invalid = {**deepcopy(proof), **override, "target_id_hint": "journal-original-jcr"}
                self.assertEqual(catalog.apply_additional_identity_evidence([item], [invalid]), [])
                self.assertEqual(item, before)
        for item in [record("Unrelated Journal", proof["print_issn"]), record(proof["name"]), record(proof["name"], "")]:
            before = deepcopy(item)
            self.assertEqual(catalog.apply_additional_identity_evidence([item], [proof]), [])
            self.assertEqual(item, before)

    def test_continuation_requires_explicit_history_and_both_primary_sources(self):
        proof = identity_proof("Australian Journal of English Education")
        for override in [{"safe_to_treat_all_issns_as_current_media": True}, {"historical_title": ""},
            {"historical_issns": []}, {"evidence": proof["evidence"][:1]},
            {"evidence": [{**proof["evidence"][0], "finding": ""}, proof["evidence"][1]]}]:
            with self.subTest(override=override):
                item = record(proof["name"], proof["historical_issns"][0])
                before = deepcopy(item)
                self.assertEqual(catalog.apply_additional_identity_evidence([item], [{**proof, **override}]), [])
                self.assertEqual(item, before)

    def test_history_without_reviewed_evidence_does_not_authorize_identity_merge(self):
        item = record("Same Name", "1470-1294")
        item["historical_issns"] = ["0013-1881"]
        self.assertEqual(catalog.identity_issns(item), ["1470-1294"])

    def test_reviewed_evidence_source_file_is_valid_and_all_eight_relations_apply(self):
        path = Path(__file__).resolve().parents[1] / "data/catalog/sources/additional-identity-evidence.json"
        evidence = json.loads(path.read_text())
        self.assertEqual(len(evidence), 8)
        for proof in evidence:
            with self.subTest(name=proof["name"]):
                self.assertTrue(catalog.valid_identity_evidence(proof))
                item = record(proof["name"], proof["issns"][0])
                self.assertEqual(len(catalog.apply_additional_identity_evidence([item], [proof])), 1)
                self.assertFalse(set(catalog.record_issns(item)) & set(item["historical_issns"]))
                self.assertEqual(set(catalog.identity_issns(item)), set(proof["issns"]))

    def test_ncpssd_confirmed_rename_uses_current_title_but_preserves_source_key(self):
        row = {"name": "旧教育学报", "source_id": "ncpssd:stable", "url": "https://www.ncpssd.org/journal/details?key=1", "current_name": "新教育学报", "current_issn": "1470-1294", "name_change_evidence": {"status": "confirmed_rename", "issn_locator": "国际标准刊号"}, "aliases": ["New Education Journal"]}
        accepted, _ = catalog.ncpssd_records([row], "2026-09-29")
        self.assertEqual(accepted[0]["name"], "新教育学报")
        self.assertEqual(accepted[0]["issn"], "1470-1294")
        self.assertEqual(accepted[0]["catalog_sources"][0]["record_id"], "ncpssd:stable")
        self.assertIn("旧教育学报", accepted[0]["aliases"])
        self.assertEqual(accepted[0]["identifier_evidence"][0]["name_match_status"], "confirmed_rename")

    def test_ncpssd_unresolved_title_mismatch_does_not_borrow_current_issn(self):
        row = {"name": "旧教育学报", "source_id": "ncpssd:stable", "url": "https://www.ncpssd.org/journal/details?key=1", "current_name": "另一学报", "current_issn": "1470-1294", "name_change_evidence": {"status": "detail_title_mismatch_review"}, "detail_observation": {"name": "另一学报", "issn": "1470-1294"}}
        accepted, _ = catalog.ncpssd_records([row], "2026-09-29")
        self.assertEqual(accepted[0]["name"], "旧教育学报")
        self.assertEqual(accepted[0]["issns"], [])
        self.assertEqual(accepted[0]["detail_observation"], row["detail_observation"])
        self.assertEqual(accepted[0]["language_evidence"]["source"], "catalogue_language")

    def test_directory_metrics_remain_missing(self):
        a = record()
        for field in catalog.METRICS:
            self.assertIsNone(a[field])
        self.assertTrue(all(value is None for value in a["publications"].values()))

    def test_verified_detail_identity_deduplicates_without_claiming_unproven_old_alias(self):
        old = record("旧目录标题", "", source="ncpssd", source_id="stable")
        prior, _ = catalog.merge_records([old], [])
        row = {"name": "旧目录标题", "source_id": "stable", "url": "https://www.ncpssd.org/journal/details?key=1", "current_name": "现刊教育学报", "current_issn": "1470-1294", "canonical_source_id": "ncpssd:123", "detail_fetch": {"http_status": 200}, "name_change_evidence": {"status": "detail_title_mismatch_review"}}
        records, _ = catalog.ncpssd_records([row], "2026-09-29")
        merged, _ = catalog.merge_records(records, [], prior)
        self.assertEqual(merged[0]["id"], prior[0]["id"])
        self.assertEqual(merged[0]["name"], "现刊教育学报")
        self.assertNotIn("旧目录标题", merged[0]["aliases"])
        self.assertEqual(merged[0]["directory_name"], "旧目录标题")

    def test_shared_issn_preserves_distinct_edition_titles_and_source_records(self):
        rows = [{"name": name, "source_id": f"s{n}", "url": f"https://www.ncpssd.org/journal/details?key={n}", "issn": "1470-1294", "canonical_source_id": f"ncpssd:{n}"} for n, name in enumerate(["教育学报高教版", "教育学报普教版"])]
        records, _ = catalog.ncpssd_records(rows, "2026-09-29")
        merged, _ = catalog.merge_records(records, [])
        self.assertEqual(len(merged), 1)
        self.assertEqual({v["title"] for v in merged[0]["edition_variants"]}, {row["name"] for row in rows})
        self.assertEqual(len(merged[0]["catalog_sources"]), 2)

    def test_explicit_edition_language_overrides_chinese_directory_group(self):
        rows = [{"name": title, "source_id": str(n), "url": f"https://www.ncpssd.org/journal/details?key={n}"} for n, title in enumerate(["华东师大教育评论（英文）", "中国教育科学（中英文）", "教育研究"])]
        records, _ = catalog.ncpssd_records(rows, "2026-09-29")
        self.assertEqual([r["languages"] for r in records], [["English"], ["Chinese", "English"], ["Chinese"]])

    def test_doaj_filter_excludes_previous_title_and_known_proceedings(self):
        rows = [
            {"Journal title": "Previous Journal", "Continued By": "New Journal", "Subjects": "Education"},
            {"Journal title": "Advances in Social Science, Education and Humanities Research", "Subjects": "Education"},
            {"Journal title": "CTE Workshop Proceedings", "Subjects": "Education", "URL in DOAJ": "https://doaj.org/toc/cte"},
        ]
        accepted, excluded = catalog.doaj_records(rows, "now")
        self.assertEqual([x["name"] for x in accepted], ["CTE Workshop Proceedings"])
        self.assertEqual(len(excluded), 2)

    def test_doaj_title_supplement_preserves_non_education_subjects_and_selection_provenance(self):
        row = {"Journal title": "Computers and Education: Artificial Intelligence", "Subjects": "Science: Mathematics: Instruments and machines: Electronic computers. Computer science",
            "URL in DOAJ": "https://doaj.org/toc/computers-education-ai", "Journal EISSN (online version)": "2666-920X"}
        accepted, excluded = catalog.doaj_records([row], "2026-09-29")
        self.assertFalse(excluded)
        item = accepted[0]
        self.assertEqual(item["selection_basis"], "title_keyword_outside_education_branch")
        self.assertEqual(item["education_scope"], "interdisciplinary_title_derived")
        self.assertEqual(item["directory_subjects"], [row["Subjects"]])
        self.assertEqual((item["main_tag"], item["secondary_tag"]), ("教育技术", "学科教育"))
        self.assertEqual(item["selection_evidence"]["matched_title_terms"], ["education"])
        self.assertFalse(item["selection_evidence"]["education_subject_branch"])
        self.assertEqual(item["catalog_sources"][0]["id"], "doaj")
        self.assertEqual(item["catalog_sources"][0]["selection_evidence"], item["selection_evidence"])
        self.assertEqual(item["catalog_status"], "listed_in_directory")
        self.assertTrue(all(item[field] is None for field in catalog.METRICS))

    def test_education_technology_titles_precede_broad_science_source_categories(self):
        titles = ["Computers and Education: Artificial Intelligence", "Journal of Applied Artificial Intelligence in Education",
            "Journal of Computer-Assisted Language Learning", "International Journal of Computer-Supported Collaborative Learning",
            "Journal of Learning Analytics", "AI in Education", "人工智能教育研究"]
        for title in titles:
            with self.subTest(title=title):
                self.assertEqual(catalog.classify(title, ["Science: Mathematics"], [])[0], "教育技术")

    def test_education_technology_title_rule_does_not_infer_education_from_general_ai(self):
        cases = [
            ("Machine Learning", ["Science: Mathematics"], "学科教育"),
            ("Artificial Intelligence", ["Science: Computer science"], "综合教育期刊"),
            ("Science Education International", ["Education"], "学科教育"),
            ("Journal of Educational Psychology", ["Education", "Computer science"], "教育心理"),
        ]
        for title, subjects, expected in cases:
            with self.subTest(title=title):
                self.assertEqual(catalog.classify(title, subjects, ["artificial intelligence"])[0], expected)

    def test_education_technology_title_rule_keeps_existing_specialist_priority(self):
        self.assertEqual(catalog.classify("Journal of Digital Learning in Teacher Education", ["Education"], []), ("教师教育与教师发展", "教育技术"))
        self.assertEqual(catalog.classify("Artificial Intelligence in Medical Education", ["Medicine"], []), ("医学教育", "教育技术"))

    def test_doaj_title_rule_uses_only_five_whole_words_case_insensitively(self):
        accepted_titles = ["Medical EDUCATION Journal", "Journal of Educational Studies", "TEACHING Chemistry", "Health Pedagogy", "Physics DIDACTICS"]
        rejected_titles = ["Reeducation Review", "Educationally Speaking", "Teachingtools Review", "Pedagogyplus", "Didacticsplus", "Learning and Instruction", "Unrelated Journal"]
        rows = [{"Journal title": title, "Subjects": "Science: Physics", "Alternative title": "Education Research", "Keywords": "education, teaching", "URL in DOAJ": f"https://doaj.org/toc/{index}"}
            for index, title in enumerate([*accepted_titles, *rejected_titles])]
        accepted, excluded = catalog.doaj_records(rows, "now")
        self.assertEqual([item["name"] for item in accepted], accepted_titles)
        self.assertEqual([item["name"] for item in excluded], rejected_titles)
        self.assertTrue(all(item["reason"] == "outside_education_subject_and_title_rule" for item in excluded))

    def test_doaj_education_subject_branch_has_precedence_and_needs_no_title_term(self):
        rows = [{"Journal title": name, "Subjects": subject, "URL in DOAJ": f"https://doaj.org/toc/{index}"}
            for index, (name, subject) in enumerate([("Education Review", "Education: Theory and practice of education"), ("Research Journal", "Education"), ("Crossdisciplinary Review", "Science: Physics | Education: Special aspects of education")])]
        accepted, excluded = catalog.doaj_records(rows, "now")
        self.assertFalse(excluded)
        self.assertTrue(all(item["selection_basis"] == "education_subject_branch" for item in accepted))
        self.assertTrue(all(item["selection_evidence"]["education_subject_branch"] for item in accepted))

    def test_doaj_title_rule_does_not_override_continuation_or_proceedings_exclusions(self):
        rows = [
            {"Journal title": "Medical Education Journal", "Subjects": "Medicine", "Continued By": "New Journal"},
            {"Journal title": "Education Conference Proceedings", "Subjects": "Science"},
            {"Journal title": "Teaching Proceedings Series", "Subjects": "Science"},
            {"Journal title": "Graduate Medical Education Research Journal", "Subjects": "Medicine", "URL in DOAJ": "https://doaj.org/toc/gmerj"},
        ]
        accepted, excluded = catalog.doaj_records(rows, "now")
        self.assertEqual([item["name"] for item in accepted], ["Graduate Medical Education Research Journal"])
        self.assertEqual([item["reason"] for item in excluded], ["continued_by", "conference_proceedings_series", "conference_proceedings_series"])

    def test_url_allowlist_ignores_non_web_schemes(self):
        self.assertEqual(catalog.urls(["file:///etc/passwd", "javascript:alert(1)", "https://example.org"]), ["https://example.org"])


if __name__ == "__main__":
    unittest.main()
