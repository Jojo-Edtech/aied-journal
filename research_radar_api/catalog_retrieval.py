"""Pure catalog identity, constraint and safe-shard helpers (no API calls)."""
from __future__ import annotations

import json
from pathlib import Path
import re
import unicodedata


def normalize_identity(value):
    return "".join(c for c in unicodedata.normalize("NFKC", str(value or "")).casefold() if c.isalnum())


def query_constraints(query):
    lower = query.casefold()
    language = "Chinese" if re.search(r"中文|chinese[- ]language|journals? in chinese", lower) else "English" if re.search(r"英文|english[- ]language|journals? in english", lower) else None
    source = "doaj" if "doaj" in lower else "ebsco_education" if "ebsco" in lower else "ncpssd" if re.search(r"国家哲|ncpssd", lower) else None
    unknown = bool(re.search(r"非\s*jcr|未核验|未验证|non[- ]?jcr|unverified", lower))
    quartile = re.search(r"(?<![a-z0-9])q([1-4])(?![a-z0-9])|([一二三四])区", lower)
    q = ("Q" + (quartile.group(1) or str("一二三四".index(quartile.group(2)) + 1))) if quartile and not unknown else None
    return {"language": language, "source": source, "unverified": unknown, "quartile": q}


def matches_constraints(journal, constraints):
    languages = [str(v).casefold() for v in journal.get("languages", [])]
    if constraints["language"] and constraints["language"].casefold() not in languages:
        return False
    source_ids = [s.get("id") for s in journal.get("catalog_sources", []) if isinstance(s, dict)]
    if constraints["source"] and constraints["source"] not in source_ids:
        return False
    if constraints["unverified"] and journal.get("quartile") in {"Q1", "Q2", "Q3", "Q4"}:
        return False
    if constraints["quartile"] and journal.get("quartile") != constraints["quartile"]:
        return False
    return True


def identity_match(journal, query):
    normalized = normalize_identity(query)
    for name in [journal.get("name"), *(journal.get("aliases") or [])]:
        name = normalize_identity(name)
        threshold = 4 if re.search(r"[\u4e00-\u9fff]", name) else 6
        if len(name) >= threshold and name in normalized:
            return True
    for issn in [journal.get("issn"), journal.get("eissn"), *(journal.get("issns") or []), *(journal.get("historical_issns") or [])]:
        identifier = normalize_identity(issn)
        if len(identifier) == 8 and identifier in normalized:
            return True
    abbreviation = normalize_identity(journal.get("abbreviation"))
    latin_tokens = {normalize_identity(x) for x in re.findall(r"[a-z0-9]+(?:[-.&+][a-z0-9]+)*", query.casefold())}
    return len(abbreviation) >= 2 and abbreviation in latin_tokens


def data_fingerprint(root):
    paths = [root / "data-manifest.json", root / "rag_documents_index.json", root / "journals.json", root / "rag_documents.jsonl"]
    return (str(root.resolve()), tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in paths if p.exists()))


def iter_rag_records(root: Path, journal_ids):
    manifest_path = root / "rag_documents_index.json"
    if not manifest_path.exists():
        with (root / "rag_documents.jsonl").open(encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version_path = root / "data-manifest.json"
    if version_path.exists():
        data_manifest = json.loads(version_path.read_text(encoding="utf-8"))
        if manifest.get("data_version") != data_manifest.get("data_version"):
            raise ValueError("RAG shard index is from another data version")
    entries = manifest.get("journals", {})
    if not isinstance(entries, dict) or set(entries) != set(journal_ids):
        raise ValueError("RAG shard journal identities do not match the catalog")
    safe_root = (root / "rag_documents").resolve()
    for journal_id, info in entries.items():
        if not isinstance(info, dict) or not isinstance(info.get("count"), int) or info["count"] < 0:
            raise ValueError("Invalid RAG shard metadata")
        relative = info.get("path", "")
        if not re.fullmatch(r"rag_documents/[A-Za-z0-9_-]+\.jsonl", relative):
            raise ValueError("Unsafe RAG shard path")
        path = (root / relative).resolve()
        if path.parent != safe_root:
            raise ValueError("RAG shard escapes the public data directory")
        count = 0
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                item = json.loads(line)
                if item.get("journal_id") != journal_id:
                    raise ValueError("RAG shard contains another journal")
                count += 1
                yield item
        if count != info.get("count"):
            raise ValueError("RAG shard count mismatch")
