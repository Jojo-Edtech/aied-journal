"""Small, offline-testable helpers for the multi-source radar data pipeline."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit


METRIC_FIELDS = ("jif_2025", "jci_2025", "quartile")
BASELINE_FIELDS = (*METRIC_FIELDS, "publications")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,179}$")


def normalized_issn(value: object) -> str:
    text = re.sub(r"[^0-9X]", "", str(value or "").upper())
    return f"{text[:4]}-{text[4:]}" if re.fullmatch(r"[0-9]{7}[0-9X]", text) else ""


def unique_values(values: list) -> list:
    result, seen = [], set()
    for value in values:
        key = json.dumps(value, sort_keys=True, ensure_ascii=False)
        if value not in (None, "") and key not in seen:
            result.append(value)
            seen.add(key)
    return result


def normalize_journal(record: dict, *, is_jcr: bool = False) -> dict:
    journal = copy.deepcopy(record)
    if not SAFE_ID.fullmatch(str(journal.get("id", ""))):
        raise ValueError(f"Unsafe or missing journal ID: {journal.get('id')!r}")
    if not str(journal.get("name", "")).strip():
        raise ValueError(f"Missing journal name: {journal['id']}")
    for field in ("abbreviation", "jcr_abbreviation", "secondary_tag", "word_limit", "publisher", "category", "submission_system", "acceptance_rate", "crawl_notes"):
        journal.setdefault(field, "")
    journal["main_tag"] = journal.get("main_tag") or "Education"
    journal["publisher_family"] = journal.get("publisher_family") or journal.get("publisher") or "Other"
    journal["tag_path"] = journal.get("tag_path") or " / ".join(filter(None, (journal["main_tag"], journal["secondary_tag"])))
    journal["issn"] = normalized_issn(journal.get("issn"))
    journal["eissn"] = normalized_issn(journal.get("eissn"))
    journal["issns"] = unique_values([normalized_issn(v) for v in [*journal.get("issns", []), journal["issn"], journal["eissn"]]])
    for field in ("source_urls", "catalog_sources", "languages"):
        journal[field] = unique_values(journal.get(field) or [])
    journal.setdefault("country", "")
    journal.setdefault("publications", {})
    for field in ("first_decision_days", "review_time_days", "submission_to_accept_days"):
        journal.setdefault(field, None)
    if is_jcr:
        journal["quartile"] = str(journal.get("quartile") or "").upper() or None
        for field in ("jif_2025", "jci_2025"):
            journal.setdefault(field, None)
    else:
        # Directory inclusion is never evidence for a JCR metric.
        for field in METRIC_FIELDS:
            journal[field] = None
    journal["has_jcr_record"] = is_jcr
    journal["metrics_year"] = 2025 if is_jcr else None
    journal.setdefault("editors", {"status": "not_started", "source_url": "", "editors_in_chief": [], "associate_editors": [], "profiles": [], "note": ""})
    return journal


def merge_journal_catalog(baseline: list[dict], catalog: list[dict]) -> list[dict]:
    journals = [normalize_journal(record, is_jcr=True) for record in baseline]
    by_id = {journal["id"]: journal for journal in journals}
    if len(by_id) != len(journals):
        raise ValueError("Duplicate JCR baseline IDs")
    by_issn: dict[str, dict] = {}
    for journal in journals:
        for issn in journal["issns"]:
            by_issn.setdefault(issn, journal)
    for record in catalog:
        incoming = normalize_journal(record)
        matches = {by_issn[issn]["id"] for issn in incoming["issns"] if issn in by_issn}
        if incoming["id"] in by_id:
            matches.add(incoming["id"])
        if len(matches) > 1:
            raise ValueError(f"Ambiguous ISSN overlap for {incoming['id']}: {sorted(matches)}")
        current = by_id[next(iter(matches))] if matches else None
        if current is None:
            current = incoming
            current["rank"] = len(journals) + 1
            journals.append(current)
            by_id[current["id"]] = current
        else:
            for field in ("source_urls", "catalog_sources", "languages", "issns"):
                current[field] = unique_values([*(current.get(field) or []), *(incoming.get(field) or [])])
            # Preserve every populated baseline value; retain extra directory attributes.
            for field, value in incoming.items():
                if field in {*BASELINE_FIELDS, "id", "rank", "has_jcr_record", "metrics_year"}:
                    continue
                if isinstance(value, list) and isinstance(current.get(field), list):
                    current[field] = unique_values([*current[field], *value])
                    continue
                if current.get(field) in (None, "", [], {}):
                    current[field] = copy.deepcopy(value)
            # Verified serial continuations may supersede identifiers from the
            # historical workbook without changing its metrics or journal ID.
            historical = set(current.get("historical_issns") or [])
            if historical:
                current["issns"] = [value for value in current["issns"] if value not in historical]
                for field in ("issn", "eissn"):
                    if current.get(field) in historical:
                        current[field] = incoming.get(field) or ""
        for issn in current["issns"]:
            by_issn[issn] = current
    return journals


def rotation_indexes(total: int, limit: int, offset: int) -> list[int]:
    if total <= 0:
        return []
    if limit <= 0 or limit >= total:
        return list(range(total))
    return [(offset + step) % total for step in range(limit)]


def canonical_doi(value: object) -> str:
    text = unquote(str(value or "")).strip().lower()
    text = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", text)
    return text if re.fullmatch(r"10\.[0-9]{4,9}/\S+", text) else ""


def article_key(article: dict) -> str:
    doi = canonical_doi(article.get("doi")) or canonical_doi(article.get("url"))
    if doi:
        return f"doi:{doi}"
    url = str(article.get("url") or "").strip()
    if url:
        parts = urlsplit(url)
        return "url:" + urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), parts.query, ""))
    title = " ".join(str(article.get("title") or "").lower().split())
    return f"title:{title}|{article.get('year') or ''}" if title else ""


def merge_articles(previous: list[dict], incoming: list[dict]) -> list[dict]:
    """Never replace valid evidence with a failed/empty fetch or stamp retained rows anew."""
    merged: dict[str, dict] = {}
    for record in [*previous, *incoming]:
        if record.get("status", "ok") != "ok" or not str(record.get("title") or "").strip():
            continue
        key = article_key(record)
        if not key:
            continue
        item = dict(record)
        doi = canonical_doi(item.get("doi")) or canonical_doi(item.get("url"))
        if doi:
            item["doi"] = doi
        # A cached response older than our existing evidence cannot replace it.
        if key in merged:
            def captured(record):
                try:
                    value = datetime.fromisoformat(str(record.get("captured_at") or "").replace("Z", "+00:00"))
                    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
                except (TypeError, ValueError):
                    return datetime.min.replace(tzinfo=timezone.utc)
            older, newer = (item, merged[key]) if captured(item) < captured(merged[key]) else (merged[key], item)
            # A sparse response may add metadata, but never erases an existing abstract.
            item = {**older, **{k: v for k, v in newer.items() if v not in (None, "", [], {})}}
        merged[key] = item
    return list(merged.values())


def safe_shard_path(root: Path, path: str, dataset: str, journal_id: str, suffix: str) -> Path:
    expected = f"{dataset}/{journal_id}{suffix}"
    if not SAFE_ID.fullmatch(journal_id) or path != expected:
        raise ValueError(f"Unsafe shard path: {path!r}")
    resolved = (root / path).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f"Shard escapes dataset directory: {path!r}")
    return resolved


def read_jsonl_strict(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError(f"Invalid JSONL records: {path}")
    return rows


def read_partitioned(root: Path, dataset: str) -> dict[str, list[dict]]:
    result: dict[str, list[dict]] = defaultdict(list)
    index_path = root / f"{dataset}_index.json"
    if index_path.exists():
        index = json.loads(index_path.read_text(encoding="utf-8"))
        if index.get("schema_version") != 1 or not isinstance(index.get("journals"), dict):
            raise ValueError(f"Invalid {dataset} index")
        for journal_id, entry in index["journals"].items():
            path = safe_shard_path(root, entry.get("path", ""), dataset, journal_id, ".jsonl")
            rows = read_jsonl_strict(path)
            if len(rows) != entry.get("count") or any(row.get("journal_id") != journal_id for row in rows):
                raise ValueError(f"Mismatched {dataset} shard: {journal_id}")
            result[journal_id] = rows
    elif (root / f"{dataset}.jsonl").exists():
        for row in read_jsonl_strict(root / f"{dataset}.jsonl"):
            if row.get("journal_id"):
                result[row["journal_id"]].append(row)
    return result


def write_partition(root: Path, dataset: str, journal_id: str, rows: list[dict], index: dict) -> None:
    relative = f"{dataset}/{journal_id}.jsonl"
    path = safe_shard_path(root, relative, dataset, journal_id, ".jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    index["journals"][journal_id] = {"path": relative, "count": len(rows)}


def stable_doc_id(*parts: str) -> str:
    return "doc-" + hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:12]
