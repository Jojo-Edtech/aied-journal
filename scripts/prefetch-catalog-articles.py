#!/usr/bin/env python3
"""Warm the generator's public Crossref cache with bounded, resumable requests."""
import argparse
import concurrent.futures
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("radar_generator", ROOT / "scripts/generate-research-radar.py")
radar = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = radar
spec.loader.exec_module(radar)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "output/handoff/crossref-cache")
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--from-date", default="2021-09-29")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=10)
    parser.add_argument("--source", help="Only request journals represented in this catalog source, e.g. ncpssd")
    parser.add_argument("--progress-file", type=Path, default=ROOT / "output/handoff/education-prefetch-progress.json")
    args = parser.parse_args()
    baseline = json.loads((ROOT / "data/radar/source_workbook_snapshot.json").read_text())
    catalog = json.loads((ROOT / "data/catalog/education-journals.json").read_text())
    journals = {j["id"]: j for j in radar.merge_journal_catalog(baseline, catalog)}
    candidates = [j for j in journals.values() if radar.journal_issns(j)]
    if args.source:
        candidates = [j for j in candidates if args.source in {s.get("id") for s in j.get("catalog_sources", [])}]
    stamp = datetime.now(timezone.utc).isoformat()
    progress_path = args.progress_file

    def fetch(journal):
        attempts = []
        for issn in radar.journal_issns(journal):
            url = radar.crossref_url_for(issn, args.rows, args.from_date)
            payload, error = radar.request_json(url, args.timeout, args.cache_dir)
            items = payload.get("message", {}).get("items", []) if payload else []
            attempts.append({"issn": issn, "error": error, "items": len(items)})
            if items:
                return {"id": journal["id"], "status": "available", "attempts": attempts}
            time.sleep(0.15)
        return {"id": journal["id"], "status": "unavailable", "attempts": attempts}

    completed = []
    print(json.dumps({"started_at": stamp, "journals": len(journals), "with_issn": len(candidates), "workers": min(4, max(1, args.workers)), "rows": args.rows}), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, max(1, args.workers))) as pool:
        futures = {pool.submit(fetch, j): j["id"] for j in candidates}
        for future in concurrent.futures.as_completed(futures):
            try:
                completed.append(future.result())
            except Exception as exc:
                completed.append({"id": futures[future], "status": "error", "error_type": type(exc).__name__})
            if len(completed) % 50 == 0 or len(completed) == len(candidates):
                counts = {"completed": len(completed), "total": len(candidates), "available": sum(x["status"] == "available" for x in completed)}
                progress_path.parent.mkdir(parents=True, exist_ok=True)
                progress_path.write_text(json.dumps({"started_at": stamp, "updated_at": datetime.now(timezone.utc).isoformat(), **counts, "results": completed}, ensure_ascii=False))
                print(json.dumps(counts), flush=True)


if __name__ == "__main__":
    main()
