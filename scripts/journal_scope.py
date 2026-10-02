"""Evidence-bound public scope: English journals in SSCI, ESCI or Scopus."""
from __future__ import annotations

import copy
import hashlib
import json
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

ALLOWED_INDEXES = ("SSCI", "ESCI", "Scopus")
SCOPE_ID = "english-ssci-esci-scopus-v1"


def normalize_languages(values: list) -> list[str]:
    aliases = {"en": "English", "eng": "English", "english": "English",
               "zh": "Chinese", "zho": "Chinese", "chi": "Chinese", "chinese": "Chinese",
               "中文": "Chinese", "英语": "English", "英文": "English"}
    return sorted({aliases.get(str(value).strip().casefold(), str(value).strip())
                   for value in values if str(value).strip()})


def load_index_evidence(path: Path) -> tuple[dict, str]:
    """Missing/malformed evidence must stop publication, never reopen the catalog."""
    raw = path.read_bytes()
    payload = json.loads(raw)
    if not isinstance(payload, dict) or payload.get("schema_version") != 1 or not isinstance(payload.get("journals"), dict):
        raise ValueError("Index evidence requires schema_version 1 and a journals mapping")
    blocked = payload.get("excluded_journal_ids", {})
    if not isinstance(blocked, dict) or any(not isinstance(key, str) or value != "identity_ambiguity" for key, value in blocked.items()):
        raise ValueError("Index evidence identity exclusions must map journal IDs to identity_ambiguity")
    for journal_id, entry in payload["journals"].items():
        if not isinstance(journal_id, str) or not isinstance(entry, dict):
            raise ValueError("Invalid journal index evidence entry")
        for field in ("languages", "indexes", "evidence"):
            if not isinstance(entry.get(field), list):
                raise ValueError(f"Index evidence {journal_id} requires a {field} array")
        if any(not isinstance(value, str) for field in ("languages", "indexes") for value in entry[field]):
            raise ValueError(f"Invalid language/index value in {journal_id}")
        if entry["indexes"] and not any(valid_evidence_url(item) for item in entry["evidence"]):
            raise ValueError(f"Index evidence {journal_id} has no public evidence URL")
    return payload, hashlib.sha256(raw).hexdigest()


def valid_evidence_url(item: object) -> bool:
    if not isinstance(item, dict):
        return False
    url = item.get("url") or item.get("source_url") or item.get("evidence_url") or ""
    parsed = urlparse(str(url))
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def apply_journal_scope(journals: list[dict], evidence: dict) -> tuple[list[dict], dict]:
    """Union language evidence; a Chinese declaration always excludes a journal.

    Index membership comes only from the curated evidence map. JCR metrics,
    directory membership, English-looking titles and countries never establish it.
    """
    entries = evidence.get("journals", {})
    identity_exclusions = evidence.get("excluded_journal_ids", {})
    included, excluded = [], []
    canonical = {value.casefold(): value for value in ALLOWED_INDEXES}
    seen = set()
    for original in journals:
        journal = copy.deepcopy(original)
        journal_id = journal["id"]
        if journal_id in seen:
            raise ValueError(f"Duplicate scope input identity: {journal_id}")
        seen.add(journal_id)
        entry = entries.get(journal_id, {})
        languages = normalize_languages([*(journal.get("languages") or []), *entry.get("languages", [])])
        indexes = sorted({canonical[value.strip().casefold()] for value in entry.get("indexes", [])
                          if value.strip().casefold() in canonical}, key=ALLOWED_INDEXES.index)
        proofs = entry.get("evidence", [])
        if not any(valid_evidence_url(item) for item in proofs):
            indexes = []
        reason = ("identity_ambiguity" if journal_id in identity_exclusions else
                  "chinese_language" if "Chinese" in languages else
                  "english_language_unverified" if "English" not in languages else
                  "allowed_index_unverified" if not indexes else None)
        if reason:
            excluded.append({"journal_id": journal_id, "name": journal["name"], "reason": reason,
                             "languages": languages, "indexes": indexes,
                             "has_jcr_record": bool(journal.get("has_jcr_record"))})
            continue
        journal["languages"] = languages
        journal["indexes"] = indexes
        journal["index_evidence"] = copy.deepcopy(proofs)
        if entry.get("language_evidence"):
            journal["index_language_evidence"] = copy.deepcopy(entry["language_evidence"])
        journal["scope_id"] = SCOPE_ID
        included.append(journal)
    counts = Counter(index for journal in included for index in journal["indexes"])
    audit = {
        "schema_version": 1, "scope_id": SCOPE_ID,
        "rule": "English explicitly recorded; no Chinese language declaration; at least one evidenced SSCI, ESCI or Scopus index. Unknowns are excluded.",
        "allowed_indexes": list(ALLOWED_INDEXES), "input_count": len(journals),
        "included_count": len(included), "excluded_count": len(excluded),
        "index_counts": {index: counts[index] for index in ALLOWED_INDEXES},
        "excluded_reason_counts": dict(Counter(item["reason"] for item in excluded)),
        "identity_exclusions": copy.deepcopy(identity_exclusions),
        "included_ids": [journal["id"] for journal in included], "excluded": excluded,
    }
    return included, audit
