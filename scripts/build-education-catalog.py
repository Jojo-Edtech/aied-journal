#!/usr/bin/env python3
"""Build a provenance-bearing education directory without inventing JCR metrics.

Inputs are source extracts from the official DOAJ CSV (Education subjects or
explicit education-related title terms), EBSCO Education Source subject list
and NCPSSD Chinese education directory. Raw source fields remain in
data/catalog/sources so the merge can be reproduced without network.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URLS = {
    "doaj": "https://doaj.org/csv",
    "ebsco_education": "https://about.ebsco.com/m/ee/Marketing/titleLists/eue-subject.htm",
    "ncpssd": "https://www.ncpssd.org/journal/list?t=1&langType=1&clazz=C%3DG4%2CG5%2CG6%2CG7",
}
SOURCE_LABELS = {
    "doaj": "DOAJ · Education subjects and title matches",
    "ebsco_education": "EBSCO Education Source · Education",
    "ncpssd": "国家哲学社会科学文献中心 · 教育学",
}
METRICS = ("jif_2025", "jci_2025", "quartile", "first_decision_days", "review_time_days", "submission_to_accept_days")
DOAJ_EDUCATION_TITLE_TERMS = re.compile(r"\b(education|educational|teaching|pedagogy|didactics)\b", re.I)


def text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def title_key(value):
    value = unicodedata.normalize("NFKD", text(value)).casefold().replace("&", " and ")
    return "".join(c for c in value if c.isalnum() and not unicodedata.combining(c))


def valid_issn(value):
    digits = re.sub(r"[^0-9X]", "", text(value).upper())
    if not re.fullmatch(r"\d{7}[0-9X]", digits):
        return ""
    check = sum(int(x) * weight for x, weight in zip(digits[:7], range(8, 1, -1)))
    if (check + (10 if digits[7] == "X" else int(digits[7]))) % 11:
        return ""
    return digits[:4] + "-" + digits[4:]


def record_issns(record):
    vals = [record.get("issn"), record.get("eissn"), *(record.get("issns") or [])]
    return sorted({v for x in vals if (v := valid_issn(x))})


def identity_issns(record):
    """Historical identifiers join identities only through reviewed source evidence."""
    identifiers = set(record_issns(record))
    for proof in record.get("identifier_evidence", []):
        if proof.get("source") == "verified_identity_review" and valid_identity_evidence(proof):
            related = {valid_issn(value) for value in proof["issns"]}
            if identifiers & related:
                identifiers.update(related)
    return sorted(identifiers)


def remove_historical_current_identifiers(record):
    historical = {valid_issn(value) for value in record.get("historical_issns", [])} - {""}
    if historical:
        record["historical_issns"] = sorted(historical)
        record["issns"] = sorted(set(record_issns(record)) - historical)
        for field in ("issn", "eissn"):
            if valid_issn(record.get(field)) in historical:
                record[field] = ""


def urls(values):
    return list(dict.fromkeys(x for v in values if (x := text(v)) and urlparse(x).scheme in {"http", "https"} and urlparse(x).netloc))


def family(value):
    low = value.casefold()
    for pattern, label in [
        (r"springer|bmc|palgrave", "Springer Nature"),
        (r"taylor|routledge|informa", "Taylor & Francis"),
        (r"elsevier|academic press", "Elsevier"),
        (r"wiley|blackwell", "Wiley"),
        (r"\bsage\b", "SAGE"),
        (r"emerald", "Emerald"),
        (r"cambridge", "Cambridge University Press"),
        (r"oxford", "Oxford University Press"),
        (r"mdpi", "MDPI"),
        (r"frontiers", "Frontiers"),
    ]:
        if re.search(pattern, low):
            return label
    return value or "未提供出版社"


def classify(name, subjects, keywords):
    """Search/navigation tags; source subjects are retained separately as evidence."""
    hay = " ".join([name, *subjects, *keywords]).casefold()
    # A clear education-and-technology title outweighs a broad source branch
    # such as Mathematics / Computer science without changing that source data.
    education_title = re.search(r"\b(?:education|educational|teaching|learning|instruction|instructional|pedagogy)\b|教育|教学|学习", name, re.I)
    technology_title = re.search(r"\b(?:artificial intelligence|computer[- ](?:assisted|supported|aided|based|mediated)|computers?|learning analytics|educational technolog(?:y|ies)|technology[- ]enhanced)\b|人工智能|计算机辅助|学习分析|教育技术", name, re.I) or re.search(r"\bAI\b", name)
    edtech_title = bool(education_title and technology_title)
    rules = [
        (r"medical education|nurs.*educat|health.*educat|医学教育|护理教育", "医学教育"),
        (r"special education|inclusive education|特殊教育|全纳教育", "特殊教育"),
        (r"early childhood|preschool|幼儿|学前|早期教育", "儿童与早期教育"),
        (r"teacher education|teacher development|teacher training|teaching profession|教师教育|教师发展|师资", "教师教育与教师发展"),
        (r"education.*technolog|technolog.*education|online learning|digital learning|e-learning|distance education|教育技术|电化教育|远程教育|开放教育", "教育技术"),
        (r"higher education|college teaching|university teaching|高等教育|高教|大学教育", "高等教育"),
        (r"vocational|continuing education|adult education|lifelong|职业教育|成人教育|继续教育", "职业与继续教育"),
        (r"language teaching|language learning|linguistic.*educat|tesol|tefl|外语|语言教学|汉语教学", "语言教育与语言习得"),
        (r"educational psychology|school psychology|教育心理|学习心理", "教育心理"),
        (r"educational leadership|educational administration|education management|教育管理|教育领导", "教育管理与领导力"),
        (r"education policy|educational policy|sociology.*education|教育政策|教育社会", "教育政策与社会问题"),
        (r"mathematics|science education|physics education|chemistry education|biology education|geography education|arts education|music education|matem|数学|物理|化学|生物|音乐|美术|体育", "学科教育"),
    ]
    hits = [label for pattern, label in rules if re.search(pattern, hay) or (label == "教育技术" and edtech_title)]
    return (hits[0] if hits else "综合教育期刊", hits[1] if len(hits) > 1 else "")


def make_record(source, record_id, name, issn, eissn, publisher, languages, country, subjects, keywords, source_urls, evidence_url, retrieved_at, **extras):
    main, secondary = classify(name, subjects, keywords)
    record = {
        "name": text(name), "aliases": [], "issn": valid_issn(issn), "eissn": valid_issn(eissn),
        "publisher": text(publisher), "publisher_family": family(text(publisher)),
        "main_tag": main, "secondary_tag": secondary, "tag_path": " / ".join(filter(None, [main, secondary])),
        "languages": sorted(set(filter(None, map(text, languages)))), "country": text(country),
        "directory_subjects": list(dict.fromkeys(filter(None, map(text, subjects)))),
        "catalog_keywords": list(dict.fromkeys(filter(None, map(text, keywords)))),
        "classification_method": "directory_subjects_and_title_keywords",
        "category": "Education", "word_limit": "", "abbreviation": "", "jcr_abbreviation": "",
        "source_urls": urls(source_urls), "catalog_only": True, "metrics_status": "not_verified",
        "publications": {str(y): None for y in range(2022, 2026)}, "metrics_year": None,
        "catalog_sources": [{"id": source, "label": SOURCE_LABELS[source], "url": SOURCE_URLS[source],
            "record_id": str(record_id), "retrieved_at": retrieved_at, "evidence_url": evidence_url}],
        **{field: None for field in METRICS}, **extras,
    }
    record["issns"] = record_issns(record)
    return record


def doaj_records(rows, stamp):
    records, excluded = [], []
    for row in rows:
        name = text(row.get("Journal title"))
        evidence = text(row.get("URL in DOAJ"))
        if row.get("Continued By"):
            excluded.append({"source": "doaj", "name": name, "evidence_url": evidence, "reason": "continued_by", "successor": row["Continued By"]})
            continue
        if re.search(r"advances in social science,? education and humanities research|\bconference proceedings\b|\bproceedings series\b", name, re.I):
            excluded.append({"source": "doaj", "name": name, "evidence_url": evidence, "reason": "conference_proceedings_series"})
            continue
        subjects = [x.strip() for x in text(row.get("Subjects")).split("|") if x.strip()]
        education_branch = any(x == "Education" or x.startswith("Education:") for x in subjects)
        title_terms = sorted({term.casefold() for term in DOAJ_EDUCATION_TITLE_TERMS.findall(name)})
        if not education_branch and not title_terms:
            excluded.append({"source": "doaj", "name": name, "evidence_url": evidence, "reason": "outside_education_subject_and_title_rule"})
            continue
        selection_basis = "education_subject_branch" if education_branch else "title_keyword_outside_education_branch"
        selection_evidence = {"source": "doaj", "url": evidence, "journal_title": name, "subjects": subjects,
            "matched_title_terms": title_terms, "education_subject_branch": education_branch,
            "rule": "Subjects has an Education branch OR Journal title contains whole-word education|educational|teaching|pedagogy|didactics (case-insensitive). Alternative titles and keywords are not used for selection.",
            "scope_interpretation": "DOAJ Education subject classification" if education_branch else "Title-derived interdisciplinary education scope; not classified in the DOAJ Education subject branch."}
        rec = make_record("doaj", evidence.rstrip("/").split("/")[-1], name,
            row.get("Journal ISSN (print version)"), row.get("Journal EISSN (online version)"), row.get("Publisher"),
            text(row.get("Languages in which the journal accepts manuscripts")).split(","), row.get("Country of publisher"),
            subjects, text(row.get("Keywords")).split(","),
            [row.get("Journal URL"), row.get("URL for journal's aims & scope"), row.get("URL for journal's instructions for authors"), row.get("URL for the Editorial Board page")],
            evidence, stamp, open_access=True, homepage_url=text(row.get("Journal URL")),
            directory_updated_at=text(row.get("Last updated Date")), catalog_status="listed_in_directory",
            selection_basis=selection_basis, selection_evidence=selection_evidence,
            education_scope="education_subject_classification" if education_branch else "interdisciplinary_title_derived")
        rec["catalog_sources"][0].update(selection_basis=selection_basis, selection_evidence=deepcopy(selection_evidence))
        alt = text(row.get("Alternative title"))
        if alt and title_key(alt) != title_key(name):
            rec["aliases"] = [alt]
        records.append(rec)
    return records, excluded


def ebsco_records(rows, stamp):
    records, excluded = [], []
    for row in rows:
        if len(row) < 15 or row[0] != "Education" or row[3] != "Academic Journal" or text(row[8]):
            excluded.append({"source": "ebsco_education", "name": row[5] if len(row) > 5 else "", "reason": "outside_current_education_academic_journal_filter"})
            continue
        records.append(make_record("ebsco_education", row[14], row[5], row[4], "", row[6], [], row[13],
            [row[0], row[1], row[2]], [], [], SOURCE_URLS["ebsco_education"], stamp,
            open_access=None, homepage_url="", catalog_status="indexing_end_not_listed", peer_reviewed=row[12] == "Y"))
    return records, excluded


def ncpssd_records(rows, stamp):
    records, excluded = [], []
    for row in rows:
        directory_name = text(row.get("name") or row.get("title"))
        change_evidence = row.get("name_change_evidence") or {}
        confirmed_rename = change_evidence.get("status") == "confirmed_rename"
        detail_id = row.get("canonical_source_id") or row.get("detail_source_id")
        verified_current = bool(text(row.get("current_name")) and valid_issn(row.get("current_issn")) and detail_id and (row.get("detail_fetch") or {}).get("http_status") == 200)
        use_current = confirmed_rename or verified_current
        observation = row.get("detail_observation") or {}
        name = text(row.get("current_name")) if use_current else directory_name
        name = name or directory_name
        evidence = text(row.get("url") or row.get("detail_url") or row.get("source_url"))
        if not name or not evidence.startswith("https://www.ncpssd.org/"):
            excluded.append({"source": "ncpssd", "name": name, "reason": "missing_official_detail_reference"})
            continue
        accepted_issn = row.get("current_issn") if use_current else row.get("issn")
        explicit_bilingual = "中英文" in name
        explicit_english = "英文" in name and not explicit_bilingual
        languages = ["Chinese", "English"] if explicit_bilingual else ["English"] if explicit_english else ["Chinese"]
        rec = make_record("ncpssd", row.get("source_id") or row.get("id") or evidence, name,
            accepted_issn, row.get("eissn"), (observation.get("publisher") if use_current else None) or row.get("publisher") or row.get("organizer") or row.get("sponsor"),
            languages, "China", ["教育学 (G4/G5/G6/G7)"], [], [row.get("homepage_url")], evidence, stamp,
            open_access=None, homepage_url=text(row.get("homepage_url")), catalog_status="listed_in_education_directory",
            education_scope="education_related", latest_indexed_year=row.get("latest_indexed_year"),
            cn_number=text(row.get("cn_number")), detail_verification_status=row.get("detail_verification_status") or change_evidence.get("status") or "directory_only",
            language_evidence={"source": "explicit_edition_title" if explicit_bilingual or explicit_english else "catalogue_language", "value": languages, "url": evidence if explicit_bilingual or explicit_english else SOURCE_URLS["ncpssd"], "note": "Language explicitly stated in the edition title." if explicit_bilingual or explicit_english else "Listed in the source's Chinese journal catalog; not a publisher declaration of accepted manuscript languages."})
        rec["aliases"] = list(dict.fromkeys(text(value) for value in [*(row.get("aliases") or []), directory_name if confirmed_rename else ""] if text(value) and title_key(value) != title_key(name)))
        if use_current:
            rec["aliases"] = list(dict.fromkeys([*rec["aliases"], *(observation.get("aliases") or [])]))
        rec["unverified_directory_names"] = [directory_name] if verified_current and not confirmed_rename and title_key(directory_name) != title_key(name) else []
        rec["edition_variants"] = [{"title": name, "canonical_source_id": detail_id, "issn": valid_issn(accepted_issn), "source_url": evidence}] if detail_id else []
        for field in ("identifier_evidence", "detail_observation", "name_change_evidence", "detail_evidence", "detail_fetch", "publisher_field_meaning", "sponsor", "latest_indexed_issue"):
            if row.get(field) not in (None, "", [], {}):
                rec[field] = deepcopy(row[field])
        rec["directory_name"] = directory_name
        if valid_issn(accepted_issn) and (row.get("detail_title_verified") or use_current):
            rec.setdefault("identifier_evidence", []).append({
                "source": "ncpssd", "url": evidence, "retrieved_at": (row.get("detail_fetch", {}).get("retrieved_at") or stamp) if isinstance(row.get("detail_fetch"), dict) else stamp,
                "issns": [valid_issn(accepted_issn)], "record_id": row.get("detail_source_id") or row.get("canonical_source_id") or row.get("record_id"),
                "locator": change_evidence.get("issn_locator") or "国际标准刊号",
                "name_match_status": "verified_current_detail_identity" if verified_current and not confirmed_rename else change_evidence.get("status") or "same_title",
            })
        records.append(rec)
    return records, excluded


def merge_values(target, candidate):
    for field in ("aliases", "issns", "historical_issns", "languages", "directory_subjects", "catalog_keywords", "source_urls", "unverified_directory_names"):
        target[field] = list(dict.fromkeys([*(target.get(field) or []), *(candidate.get(field) or [])]))
    if title_key(candidate["name"]) != title_key(target["name"]):
        target["aliases"] = list(dict.fromkeys([*target["aliases"], candidate["name"]]))
    disallowed_aliases = {title_key(value) for value in target.get("unverified_directory_names", [])}
    target["aliases"] = [value for value in target["aliases"] if title_key(value) not in disallowed_aliases]
    variants = [*(target.get("edition_variants") or []), *(candidate.get("edition_variants") or [])]
    if variants:
        target["edition_variants"] = list({json.dumps(value, sort_keys=True, ensure_ascii=False): deepcopy(value) for value in variants}.values())
    evidence = [*(target.get("identifier_evidence") or []), *(candidate.get("identifier_evidence") or [])]
    if evidence:
        target["identifier_evidence"] = list({json.dumps(proof, sort_keys=True, ensure_ascii=False): deepcopy(proof) for proof in evidence}.values())
    known = {(s["id"], s["record_id"]) for s in target.get("catalog_sources", [])}
    target.setdefault("catalog_sources", []).extend(s for s in candidate["catalog_sources"] if (s["id"], s["record_id"]) not in known)
    for field in ("issn", "eissn", "publisher", "country", "homepage_url", "cn_number", "latest_indexed_year"):
        if not target.get(field) and candidate.get(field):
            target[field] = candidate[field]
    remove_historical_current_identifiers(target)
    for field in ("detail_observation", "name_change_evidence", "detail_evidence", "detail_fetch", "publisher_field_meaning", "sponsor", "latest_indexed_issue", "language_evidence"):
        if not target.get(field) and candidate.get(field):
            target[field] = deepcopy(candidate[field])
    if candidate.get("open_access") is True:
        target["open_access"] = True
    if target.get("main_tag") == "综合教育期刊" and candidate.get("main_tag") != "综合教育期刊":
        for field in ("main_tag", "secondary_tag", "tag_path"):
            target[field] = candidate[field]
    target["publisher_family"] = family(target.get("publisher", ""))


def merge_records(candidates, baseline, registry=None):
    """Keep source-record identities stable, then consolidate verified ISSN overlaps."""
    baseline_by_id = {j["id"]: j for j in baseline}
    registry = [*baseline, *(registry or [])]
    issn_to_existing = defaultdict(set)
    title_to_existing = defaultdict(set)
    source_to_existing = defaultdict(set)
    existing = {j["id"]: j for j in registry}
    for journal in registry:
        for issn in identity_issns(journal):
            issn_to_existing[issn].add(journal["id"])
        title_to_existing[title_key(journal["name"])].add(journal["id"])
        for source in journal.get("catalog_sources", []):
            identity = (text(source.get("id")), text(source.get("record_id")))
            if all(identity):
                source_to_existing[identity].add(journal["id"])

    merged, by_issn, by_title, by_source = {}, defaultdict(set), defaultdict(set), defaultdict(set)
    redirects = {}

    def canonical(journal_id):
        while journal_id in redirects:
            journal_id = redirects[journal_id]
        return journal_id

    def resolve_hits(hits):
        return {canonical(journal_id) for journal_id in hits}

    audit = {"merges": [], "ambiguous": [], "invalid_issn_records": []}
    for candidate in sorted(candidates, key=lambda j: (j["catalog_sources"][0]["id"], j["catalog_sources"][0]["record_id"])):
        candidate = deepcopy(candidate)
        key = title_key(candidate["name"])
        issns = identity_issns(candidate)
        source_keys = {(text(source.get("id")), text(source.get("record_id"))) for source in candidate.get("catalog_sources", [])}
        source_keys = {identity for identity in source_keys if all(identity)}
        source_hits = resolve_hits(set().union(*(source_to_existing[key] | by_source[key] for key in source_keys))) if source_keys else set()
        existing_hits = resolve_hits(set().union(*(issn_to_existing[x] for x in issns))) if issns else set()
        current_hits = resolve_hits(set().union(*(by_issn[x] for x in issns))) if issns else set()
        hits = source_hits | existing_hits | current_hits
        reason = "source_record_identity" if source_hits else "issn_intersection"
        if not hits:
            title_hits = resolve_hits(title_to_existing[key] | by_title[key])
            if len(title_hits) == 1:
                match_id = next(iter(title_hits))
                match = merged.get(match_id) or existing[match_id]
                prior_issns = set(record_issns(match))
                publisher_match = title_key(family(match.get("publisher", ""))) == title_key(candidate.get("publisher_family", ""))
                # Exact non-generic title + matching publisher permits separate print/eISSN records.
                if not issns or not prior_issns or (len(key) >= 15 and publisher_match):
                    hits = {match_id}
                    reason = "exact_title_no_issn_conflict" if not issns or not prior_issns else "exact_title_and_publisher"
                elif title_hits:
                    audit["ambiguous"].append({"name": candidate["name"], "candidate_issns": issns, "existing_ids": sorted(title_hits), "reason": "same_title_different_issns"})
        # Multiple old baseline records must never be silently collapsed.
        baseline_hits = hits & baseline_by_id.keys()
        if len(baseline_hits) > 1:
            audit["ambiguous"].append({"name": candidate["name"], "existing_ids": sorted(hits), "reason": "multiple_baseline_issn_matches"})
            continue
        if hits:
            match_id = next(iter(baseline_hits)) if baseline_hits else sorted(source_hits or hits)[0]
            audit["merges"].append({"name": candidate["name"], "target_id": match_id, "basis": reason, "source": candidate["catalog_sources"][0]["id"]})
        else:
            source = candidate["catalog_sources"][0]
            identity = (issns[0].replace("-", "") if issns else hashlib.sha256((source["id"] + ":" + source["record_id"]).encode()).hexdigest()[:16])
            match_id = f"journal-issn-{identity}" if issns else f"journal-catalog-{identity}"
        candidate["id"] = match_id
        previous = existing.get(match_id)
        if previous and match_id in source_hits:
            # Keep provenance gathered in prior runs even if this extract is sparse.
            if previous.get("identifier_evidence"):
                proof_rows = [*(candidate.get("identifier_evidence") or []), *deepcopy(previous["identifier_evidence"])]
                candidate["identifier_evidence"] = list({json.dumps(proof, sort_keys=True, ensure_ascii=False): proof for proof in proof_rows}.values())
                # A sparse directory refresh must not restore a retired identifier.
                apply_additional_identity_evidence([candidate], [proof for proof in previous["identifier_evidence"] if proof.get("source") == "verified_identity_review"])
            if title_key(previous.get("name")) != key and title_key(previous.get("name")) not in {title_key(value) for value in candidate.get("unverified_directory_names", [])}:
                candidate["aliases"] = list(dict.fromkeys([*(candidate.get("aliases") or []), previous["name"]]))
        if match_id in merged:
            merge_values(merged[match_id], candidate)
        else:
            merged[match_id] = candidate
        # A later bridging ISSN may identify two already imported directory records.
        for other in sorted(hits - {match_id}):
            if other not in baseline_by_id:
                if other in merged:
                    merge_values(merged[match_id], merged.pop(other))
                redirects[other] = match_id
                for mapping in (by_issn, by_title, by_source):
                    for values in mapping.values():
                        if other in values:
                            values.remove(other)
                            values.add(match_id)
        for issn in identity_issns(merged[match_id]):
            by_issn[issn].add(match_id)
        by_title[key].add(match_id)
        for source in merged[match_id].get("catalog_sources", []):
            identity = (text(source.get("id")), text(source.get("record_id")))
            if all(identity):
                by_source[identity].add(match_id)
    result = sorted(merged.values(), key=lambda j: (title_key(j["name"]), j["id"]))
    duplicates = {issn: sorted(resolve_hits(ids)) for issn, ids in by_issn.items() if len(resolve_hits(ids)) > 1}
    if duplicates:
        raise ValueError(f"Unresolved duplicate ISSN identities: {duplicates}")
    return result, audit


def apply_identifier_crosswalk(records, crosswalk):
    """Only accept identifier relations explicitly returned by Crossref."""
    lookup = {}
    for proof in crosswalk:
        query_issn = valid_issn(proof.get("query_issn"))
        evidence = urlparse(text(proof.get("evidence_url")))
        if proof.get("status") == "ok" and query_issn and evidence.scheme == "https" and evidence.hostname == "api.crossref.org" and evidence.path.rstrip("/") == f"/journals/{query_issn}":
            lookup[query_issn] = proof
    applied = []
    for record in records:
        for issn in record_issns(record):
            proof = lookup.get(issn)
            verified = [x for value in (proof or {}).get("issns", []) if (x := valid_issn(value))]
            if not proof or issn not in verified:
                continue
            # The queried identity and a compatible title must both be present.
            name = title_key(record["name"])
            verified_name = title_key(proof.get("title", ""))
            if not name or not verified_name or not (name == verified_name or (min(len(name), len(verified_name)) >= 12 and (name in verified_name or verified_name in name))):
                continue
            added = sorted(set(verified) - set(record_issns(record)))
            if added:
                record["issns"] = sorted(set(record_issns(record)) | set(verified))
                record.setdefault("identifier_evidence", []).append({"source": "crossref", "query_issn": issn, "title": proof.get("title"), "url": proof["evidence_url"], "retrieved_at": proof.get("retrieved_at"), "issns": verified})
                applied.append({"name": record["name"], "added_issns": added, "evidence_url": proof["evidence_url"]})
    return applied


def valid_identity_evidence(proof):
    """Validate the shape and source locators of manually verified identity claims.

    This does not infer identity from names or fetch sources during a build. New
    claims must first be checked against primary sources and saved in the extract.
    """
    if not isinstance(proof, dict) or proof.get("status") != "confirmed" or proof.get("safe_to_merge") is not True:
        return False
    raw = proof.get("issns")
    if not isinstance(raw, list) or len(raw) < 2 or not all(valid_issn(value) for value in raw):
        return False
    identifiers = {valid_issn(value) for value in raw}
    if len(identifiers) != len(raw) or not text(proof.get("name")) or not text(proof.get("retrieved_at")):
        return False
    primary = urlparse(text(proof.get("url")))
    if primary.scheme != "https" or not primary.hostname:
        return False
    evidence = proof.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        return False
    for item in evidence:
        if not isinstance(item, dict) or not all(text(item.get(field)) for field in ("source_type", "url", "locator", "finding")):
            return False
        link = urlparse(item["url"])
        if link.scheme != "https" or not link.hostname:
            return False
    media = {valid_issn(proof.get("print_issn")), valid_issn(proof.get("online_issn"))}
    if "" in media or len(media) != 2 or not media <= identifiers:
        return False
    current_raw, historical_raw = proof.get("current_issns", raw), proof.get("historical_issns", [])
    if not isinstance(current_raw, list) or not isinstance(historical_raw, list) or not current_raw or not all(valid_issn(value) for value in [*current_raw, *historical_raw]):
        return False
    current, historical = set(map(valid_issn, current_raw)), set(map(valid_issn, historical_raw))
    if current & historical or current | historical != identifiers:
        return False
    if proof.get("relation") == "same_journal_different_media":
        issn_l = valid_issn(proof.get("issn_l"))
        cluster_url = f"https://portal.issn.org/resource/ISSN-L/{issn_l}"
        return media == identifiers and issn_l in identifiers and proof["url"] == cluster_url and any(
            item["source_type"] == "issn_international_centre" and item["url"] == cluster_url for item in evidence)
    if proof.get("relation") == "title_continuation_with_identifier_change":
        types = {item["source_type"] for item in evidence}
        return bool(historical and current == media and text(proof.get("historical_title"))
            and proof.get("safe_to_treat_all_issns_as_current_media") is False
            and {"official_submission_site", "publisher_issue_pdf"} <= types
            and any(item["source_type"] == "official_submission_site" and item["url"] == proof["url"] for item in evidence))
    return False


def apply_additional_identity_evidence(records, evidence):
    """Apply reviewed media/title relations while keeping retired ISSNs separate."""
    verified = [proof for proof in evidence if valid_identity_evidence(proof)]
    applied = []
    for record in records:
        for proof in verified:
            related = {valid_issn(value) for value in proof["issns"]}
            known = set(record_issns(record))
            titles = {title_key(proof["name"]), title_key(proof.get("historical_title"))} - {""}
            # A matching name alone or target_id_hint can never authorize a merge.
            if title_key(record.get("name")) not in titles or not known or not known <= related:
                continue
            before = deepcopy(record)
            current = {valid_issn(value) for value in proof.get("current_issns", proof["issns"])}
            historical = {valid_issn(value) for value in proof.get("historical_issns", [])}
            record["issns"] = sorted(current)
            record["historical_issns"] = sorted({*record.get("historical_issns", []), *historical})
            record["issn"] = proof["print_issn"] if proof["print_issn"] in current else ""
            record["eissn"] = proof["online_issn"] if proof["online_issn"] in current else ""
            if proof.get("historical_title"):
                record["name"] = proof["name"]
                record["aliases"] = list(dict.fromkeys([*record.get("aliases", []), proof["historical_title"]]))
            stored = {**deepcopy(proof), "source": "verified_identity_review"}
            record.setdefault("identifier_evidence", [])
            if stored not in record["identifier_evidence"]:
                record["identifier_evidence"].append(stored)
            remove_historical_current_identifiers(record)
            if record != before:
                applied.append({"name": record["name"], "relation": proof["relation"],
                    "previous_issns": sorted(known), "current_issns": record_issns(record),
                    "historical_issns": record["historical_issns"], "evidence_url": proof["url"]})
    return applied


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=ROOT / "data/catalog/sources")
    parser.add_argument("--output", type=Path, default=ROOT / "data/catalog")
    parser.add_argument("--baseline", type=Path, default=ROOT / "data/radar/source_workbook_snapshot.json")
    parser.add_argument("--retrieved-at", default=datetime.now(timezone.utc).isoformat())
    args = parser.parse_args()
    source_files = {"doaj": "doaj-education.json", "ebsco_education": "ebsco-education.json", "ncpssd": "ncpssd-education.json"}
    handlers = {"doaj": doaj_records, "ebsco_education": ebsco_records, "ncpssd": ncpssd_records}
    candidates, excluded, sources = [], [], []
    for key, filename in source_files.items():
        path = args.sources / filename
        if not path.exists():
            continue
        blob = path.read_bytes()
        rows = json.loads(blob)
        records, omissions = handlers[key](rows, args.retrieved_at)
        candidates.extend(records)
        excluded.extend(omissions)
        source_summary = {"id": key, "label": SOURCE_LABELS[key], "url": SOURCE_URLS[key], "retrieved_at": args.retrieved_at,
            "extract_path": f"sources/{filename}", "sha256": hashlib.sha256(blob).hexdigest(), "input_records": len(rows),
            "accepted_candidates": len(records), "excluded_records": len(omissions)}
        if key == "doaj":
            source_summary["selection_basis_counts"] = dict(Counter(record["selection_basis"] for record in records))
            source_summary["selection_rule"] = "Education subject branch OR whole-word education|educational|teaching|pedagogy|didactics in Journal title (case-insensitive); exclude continued titles and identified proceedings series."
        sources.append(source_summary)
    if not candidates:
        raise SystemExit("No official directory extracts found; refusing to replace the catalog.")
    baseline = json.loads(args.baseline.read_text())
    output = args.output / "education-journals.json"
    registry = json.loads(output.read_text()) if output.exists() else []
    crosswalk_path = args.sources / "crossref-identity-crosswalk.json"
    crosswalk = json.loads(crosswalk_path.read_text()) if crosswalk_path.exists() else []
    crosswalk_applied = apply_identifier_crosswalk(candidates, crosswalk)
    identity_path = args.sources / "additional-identity-evidence.json"
    identity_blob = identity_path.read_bytes() if identity_path.exists() else b"[]"
    identity_evidence = json.loads(identity_blob)
    identity_applied = apply_additional_identity_evidence(candidates, identity_evidence)
    catalog, audit = merge_records(candidates, baseline, registry)
    baseline_ids = {x["id"] for x in baseline}
    overlap = sum(j["id"] in baseline_ids for j in catalog)
    counts = Counter(s["id"] for j in catalog for s in {s["id"]: s for s in j["catalog_sources"]}.values())
    manifest = {"schema_version": 1, "retrieved_at": args.retrieved_at, "sources": sources,
        "additional_identity_evidence": {"extract_path": "sources/additional-identity-evidence.json" if identity_path.exists() else None,
            "sha256": hashlib.sha256(identity_blob).hexdigest(), "input_records": len(identity_evidence),
            "verified_records": sum(valid_identity_evidence(proof) for proof in identity_evidence), "applied_candidates": len(identity_applied)},
        "baseline_journal_count": len(baseline), "directory_candidate_count": len(candidates),
        "directory_unique_count": len(catalog), "overlap_with_baseline": overlap,
        "new_journal_count": len(catalog) - overlap, "expected_merged_count": len(baseline) + len(catalog) - overlap,
        "source_membership_counts": dict(counts), "chinese_language_count": sum("Chinese" in j["languages"] for j in catalog),
        "scope": "Union of the historical JCR workbook, education-category directory records, and DOAJ journals selected by explicit education-related title terms outside its Education subject branch; not an exhaustive registry of every journal worldwide.",
        "limitations": ["Directory membership is not proof of JCR indexing, journal quality, or continued publication.",
            "DOAJ title-derived additions retain their original non-Education subject classification. The title rule indicates education relevance, not independently verified publisher scope or current submission activity.",
            "EBSCO candidates have Education subject, Academic Journal type and no indexing end date; this is not a guarantee of publisher activity.",
            "NCPSSD education classification includes education-related university journals, not only education-specialist titles.",
            "Unknown metrics, review times, languages and countries are left missing. No external metric is substituted for JIF/JCI."]}
    write_json(output, catalog)
    write_json(args.output / "source-manifest.json", manifest)
    write_json(args.output / "merge-audit.json", {**audit, "excluded_records": excluded, "identifier_crosswalk_applied": crosswalk_applied,
        "additional_identity_evidence_applied": identity_applied})
    print(json.dumps({k: manifest[k] for k in ["directory_candidate_count", "directory_unique_count", "overlap_with_baseline", "new_journal_count", "expected_merged_count", "chinese_language_count"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
