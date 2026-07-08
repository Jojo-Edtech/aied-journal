#!/usr/bin/env python3
"""Generate AIED research radar data from the education JCR workbook.

The generated files are public, static data for GitHub Pages. Secrets and model
configuration stay outside this script and belong in the server environment.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

import pandas as pd


DEFAULT_EXCEL = Path("/Users/zhouxinxin/Desktop/Education_JCR_latest_refresh_2026-06-26.xlsx")
DEFAULT_OUTPUT = Path("data/radar")
USER_AGENT = "aied-journal/0.1 (+https://jojo-edtech.github.io/aied-journal/)"
EXPECTED_JOURNAL_COUNT = 268
Q1_EXPECTED_COUNT = 135
CROSSREF_API = "https://api.crossref.org"

TOPIC_TERMS = [
    ("AI literacy", ["ai literacy", "人工智能素养", "ai素养", "genai literacy", "generative ai literacy"]),
    ("Generative AI", ["generative ai", "genai", "chatgpt", "large language model", "llm", "生成式"]),
    ("Educational technology", ["educational technology", "technology enhanced", "digital learning", "online learning", "learning technology"]),
    ("Higher education", ["higher education", "university", "college", "undergraduate", "postgraduate"]),
    ("Language learning", ["language learning", "second language", "foreign language", "tesol", "applied linguistics", "writing"]),
    ("STEM education", ["stem", "science education", "mathematics education", "engineering education", "computational thinking"]),
    ("Teacher education", ["teacher education", "teacher professional", "teacher development", "teacher learning"]),
    ("Assessment", ["assessment", "evaluation", "feedback", "rubric", "testing"]),
    ("Learning analytics", ["learning analytics", "data mining", "analytics", "dashboard"]),
    ("Equity and policy", ["equity", "policy", "inclusion", "justice", "access", "governance"]),
    ("Motivation and wellbeing", ["motivation", "wellbeing", "well-being", "engagement", "self-determination"]),
    ("Curriculum and pedagogy", ["curriculum", "pedagogy", "instruction", "teaching practice", "lesson"]),
]

METHOD_TERMS = [
    ("RAG", ["retrieval augmented", "rag", "knowledge base"]),
    ("Chatbot", ["chatbot", "conversational agent", "dialogue system"]),
    ("Learning analytics", ["learning analytics", "dashboard", "trace data"]),
    ("Computer-supported collaboration", ["cscl", "collaborative learning", "group work"]),
    ("Mixed methods", ["mixed methods", "qualitative", "interview", "case study"]),
    ("Experiment", ["randomized", "experiment", "quasi-experimental", "intervention"]),
    ("Review", ["systematic review", "meta-analysis", "scoping review", "literature review"]),
]

SPECIFIC_TERMS = [
    ("AI literacy", ["ai literacy", "artificial intelligence literacy"]),
    ("Teacher feedback", ["teacher feedback", "feedback practices", "written feedback", "automated feedback"]),
    ("Learning analytics", ["learning analytics", "dashboard", "trace data", "educational data mining"]),
    ("Large language models", ["large language model", "llm", "chatgpt", "deepseek", "genai"]),
    ("Teacher professional development", ["teacher professional development", "teacher learning", "teacher development"]),
    ("Student engagement", ["student engagement", "metacognitive engagement", "motivation"]),
    ("Computational thinking", ["computational thinking", "programming education", "coding"]),
    ("Online learning", ["online learning", "remote learning", "blended learning"]),
    ("Language writing", ["writing", "second language writing", "academic writing"]),
    ("Educational equity", ["equity", "inclusion", "justice", "accessibility"]),
    ("STEM inquiry", ["inquiry-based learning", "science learning", "mathematics education"]),
    ("AI ethics", ["ethical ai", "ethics", "academic integrity", "responsible ai"]),
]

COUNTRY_TERMS = [
    "United States",
    "USA",
    "United Kingdom",
    "UK",
    "China",
    "Hong Kong",
    "Taiwan",
    "Singapore",
    "Australia",
    "Canada",
    "Spain",
    "Netherlands",
    "Ireland",
    "Germany",
    "Finland",
    "Sweden",
    "Norway",
    "Denmark",
    "Portugal",
    "Belgium",
    "Switzerland",
    "Austria",
    "Italy",
    "France",
    "Greece",
    "Poland",
    "Czech Republic",
    "Romania",
    "Japan",
    "South Korea",
    "Korea",
    "Malaysia",
    "Thailand",
    "India",
    "Indonesia",
    "Türkiye",
    "Turkey",
    "New Zealand",
    "South Africa",
    "Egypt",
    "Israel",
    "Saudi Arabia",
    "United Arab Emirates",
    "Brazil",
    "Chile",
    "Mexico",
    "Argentina",
]


def clean(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    text = html.unescape(str(value))
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return "" if text.lower() == "nan" else text


def number(value: object) -> float | None:
    text = clean(value).replace("%", "")
    if not text or text in {"—", "-", "未入选SSCI"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def integer(value: object) -> int | None:
    parsed = number(value)
    if parsed is None:
        return None
    return int(round(parsed))


def slugify(value: str, fallback: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized or fallback


def parse_urls(value: object) -> list[str]:
    urls: list[str] = []
    for part in re.split(r"\s*\|\s*|\s+", clean(value)):
        if part.startswith(("http://", "https://")) and part not in urls:
            urls.append(part)
    return urls


def should_skip_crawl_url(url: str) -> bool:
    lowered = url.lower()
    blocked = [
        "/user/login",
        "/institution/login",
        "signin",
        "login?",
        "targeturl=",
        "authenticate",
        "shibboleth",
        "saml",
        "cookie",
    ]
    return any(token in lowered for token in blocked)


def publisher_family(publisher: str, urls: Iterable[str]) -> str:
    text = " ".join([publisher, *urls]).lower()
    if "springer" in text or "nature.com" in text:
        return "Springer Nature"
    if "taylor" in text or "routledge" in text or "tandfonline" in text:
        return "Taylor & Francis"
    if "elsevier" in text or "sciencedirect" in text:
        return "Elsevier"
    if "wiley" in text:
        return "Wiley"
    if "sage" in text:
        return "SAGE"
    if "cambridge" in text:
        return "Cambridge"
    if "emerald" in text:
        return "Emerald"
    if "ieee" in text:
        return "IEEE"
    return publisher or "Other"


def source_type_for_url(url: str) -> str:
    lowered = url.lower()
    if "editor" in lowered or "editorial" in lowered:
        return "editorial_board"
    if "author" in lowered or "submission" in lowered or "guide" in lowered or "instructions" in lowered:
        return "author_guidelines"
    if "metric" in lowered or "insights" in lowered or "about-this-journal" in lowered:
        return "journal_metrics"
    if is_article_url(url):
        return "article"
    return "journal_page"


def request_text(url: str, timeout: int) -> tuple[str, str | None]:
    if should_skip_crawl_url(url):
        return "", "skipped login/auth URL"

    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("content-type", "")
            raw = response.read(1_500_000)
            charset_match = re.search(r"charset=([\w-]+)", content_type, re.I)
            charset = charset_match.group(1) if charset_match else "utf-8"
            return raw.decode(charset, errors="replace"), None
    except HTTPError as error:
        return "", f"HTTP {error.code}"
    except (OSError, URLError, TimeoutError) as error:
        return "", f"{type(error).__name__}: {error}"


def request_json(url: str, timeout: int) -> tuple[dict, str | None]:
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/plain;q=0.8,*/*;q=0.5",
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(2_000_000)
            return json.loads(raw.decode("utf-8", errors="replace")), None
    except HTTPError as error:
        return {}, f"HTTP {error.code}"
    except (OSError, URLError, TimeoutError, json.JSONDecodeError) as error:
        return {}, f"{type(error).__name__}: {error}"


def strip_html(markup: str) -> str:
    markup = re.sub(r"(?is)<(script|style|noscript|svg|footer|nav|aside)\b.*?</\1>", " ", markup)
    markup = re.sub(r"(?is)<!--.*?-->", " ", markup)
    markup = re.sub(r"(?is)<br\s*/?>", "\n", markup)
    text = re.sub(r"(?is)<[^>]+>", " ", markup)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def strip_markup_text(value: object) -> str:
    return strip_html(clean(value))


def meta_content(markup: str, *names: str) -> str:
    for name in names:
        pattern = rf'<meta[^>]+(?:name|property)=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']'
        match = re.search(pattern, markup, re.I)
        if match:
            return html.unescape(match.group(1)).strip()
        pattern = rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:name|property)=["\']{re.escape(name)}["\']'
        match = re.search(pattern, markup, re.I)
        if match:
            return html.unescape(match.group(1)).strip()
    return ""


def page_title(markup: str) -> str:
    title = meta_content(markup, "og:title", "citation_title", "dc.title")
    if title:
        return title
    match = re.search(r"(?is)<title[^>]*>(.*?)</title>", markup)
    return strip_html(match.group(1)) if match else ""


def is_article_url(url: str) -> bool:
    lowered = url.lower()
    article_patterns = [
        "/article/",
        "/doi/",
        "/science/article/",
        "/abs/",
        "/full/",
    ]
    blocked = ["author", "submission", "guide", "login", "signin", "metrics", "about-this-journal"]
    return any(pattern in lowered for pattern in article_patterns) and not any(token in lowered for token in blocked)


def extract_links(markup: str, base_url: str) -> list[str]:
    links: list[str] = []
    for match in re.finditer(r'(?is)<a\b[^>]+href=["\']([^"\']+)["\']', markup):
        href = html.unescape(match.group(1).strip())
        if not href or href.startswith(("#", "mailto:", "javascript:")):
            continue
        url = urljoin(base_url, href).split("#", 1)[0]
        if url.startswith(("http://", "https://")) and is_article_url(url) and url not in links:
            links.append(url)
    return links


def extract_editorial_links(markup: str, base_url: str) -> list[str]:
    links: list[str] = []
    for match in re.finditer(r'(?is)<a\b[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', markup):
        href = html.unescape(match.group(1).strip())
        label = strip_html(match.group(2)).lower()
        if not href or href.startswith(("#", "mailto:", "javascript:")):
            continue
        url = urljoin(base_url, href).split("#", 1)[0]
        lowered = url.lower()
        signals = [
            "editorial",
            "editorial-board",
            "editors",
            "editor-in-chief",
            "about-this-journal",
            "journal-editors",
        ]
        if url.startswith(("http://", "https://")) and not should_skip_crawl_url(url):
            if any(signal in lowered for signal in signals) or any(signal.replace("-", " ") in label for signal in signals):
                if url not in links:
                    links.append(url)
    return links


def candidate_editorial_urls(source_urls: Iterable[str]) -> list[str]:
    candidates: list[str] = []
    for url in source_urls:
        parsed = urlparse(url)
        lowered = url.lower()
        additions: list[str] = []
        if "link.springer.com/journal/" in lowered:
            match = re.search(r"/journal/([^/?#]+)", parsed.path)
            if match:
                base = f"{parsed.scheme}://{parsed.netloc}/journal/{match.group(1)}"
                additions.extend([f"{base}/editors", f"{base}/editorial-board"])
        elif "sciencedirect.com/journal/" in lowered:
            path = re.sub(r"/(about|publish)/.*$", "", parsed.path)
            base = f"{parsed.scheme}://{parsed.netloc}{path}"
            additions.extend([f"{base}/about/editorial-board", f"{base}/about/editorial-board"])
        elif "tandfonline.com" in lowered:
            match = re.search(r"[?&]journalCode=([^&#]+)", url)
            if match:
                additions.append(f"{parsed.scheme}://{parsed.netloc}/action/journalInformation?show=editorialBoard&journalCode={match.group(1)}")
            code_match = re.search(r"/journals/([^/?#]+)", parsed.path)
            if code_match:
                additions.append(f"{parsed.scheme}://{parsed.netloc}/action/journalInformation?show=editorialBoard&journalCode={code_match.group(1)}")
        elif "sagepub.com" in lowered or "journals.sagepub.com" in lowered:
            additions.append(urljoin(url, "editorial-board"))
        elif "cambridge.org" in lowered:
            additions.append(urljoin(url, "information/editorial-board"))

        for addition in additions:
            addition = addition.split("#", 1)[0]
            if addition.startswith(("http://", "https://")) and addition not in candidates and not should_skip_crawl_url(addition):
                candidates.append(addition)
    return candidates


def candidate_names(segment: str, limit: int = 12) -> list[str]:
    names: list[str] = []
    blocked = {
        "Editor",
        "Editors",
        "Chief",
        "Associate",
        "Editorial",
        "Board",
        "Journal",
        "University",
        "College",
        "Department",
        "School",
        "Springer",
        "Elsevier",
        "Wiley",
        "SAGE",
        "Taylor",
        "Francis",
        "Cambridge",
        "Oxford",
    }
    blocked_fragments = [
        "university",
        "universidad",
        "college",
        "department",
        "school",
        "faculty",
        "editor",
        "journal",
        "springer",
        "elsevier",
        "wiley",
        "sage",
        "taylor",
        "francis",
        "cambridge",
        "hong kong",
        "china",
        "spain",
        "usa",
        "united states",
        "former",
    ]
    pattern = r"\b(?:[A-Z][A-Za-z'.-]+(?:\s+|,\s*)){1,4}[A-Z][A-Za-z'.-]+\b"
    for match in re.finditer(pattern, segment):
        name = re.sub(r"\s+", " ", match.group(0).replace(",", " ")).strip()
        parts = name.split()
        if not (2 <= len(parts) <= 5):
            continue
        if len(name) > 44 or re.search(r"[a-z][A-Z]", name):
            continue
        lowered = name.lower()
        if any(fragment in lowered for fragment in blocked_fragments):
            continue
        if any(part in blocked for part in parts):
            continue
        if name not in names:
            names.append(name)
        if len(names) >= limit:
            break
    return names


def extract_editors(text: str, source_url: str) -> dict:
    editors_in_chief: list[str] = []
    associate_editors: list[str] = []
    profiles: list[dict] = []
    normalized = re.sub(r"\s+", " ", text)
    role_patterns = [
        ("Editor-in-Chief", "editors_in_chief", r"(?:Editors?-in-Chief|Editors? in Chief|Chief Editors?|Co-Editors?-in-Chief)(.{0,850})"),
        ("Associate / Section Editor", "associate_editors", r"(?:Associate Editors?|Deputy Editors?|Section Editors?)(.{0,1000})"),
    ]
    for role, field, pattern in role_patterns:
        for match in re.finditer(pattern, normalized, flags=re.I):
            names = candidate_names(match.group(1), limit=16)
            target = editors_in_chief if field == "editors_in_chief" else associate_editors
            for name in names:
                if name not in target:
                    target.append(name)
                profile = editor_profile_from_context(name, role, source_url, normalized)
                if profile["name"] and profile not in profiles:
                    profiles.append(profile)

    status = "ok" if editors_in_chief or associate_editors else "not_found"
    return {
        "status": status,
        "source_url": source_url if status == "ok" else "",
        "editors_in_chief": editors_in_chief[:8],
        "associate_editors": associate_editors[:20],
        "profiles": profiles[:28],
        "note": "自动从公开编辑页面抽取，投稿前请回官网核验。" if status == "ok" else "",
    }


def clean_heading_name(value: str) -> str:
    name = re.sub(r"\([^)]*\)", " ", value)
    name = re.sub(r"\s*,\s*(MMath|SME|MCS|MSE|MSET|MS\.Ed|MS\.IS|MSKM|MA\.CognSc|MBA|MA|MS|MSc|EdD)\b.*$", " ", name)
    name = re.sub(r"\s+\b(MMath|SME|MCS|MSE|MSET|MS\.Ed|MS\.IS|MSKM|MA\.CognSc|MBA|MSc|EdD)\b$", " ", name)
    name = re.sub(r"\b(Professor|Prof\.?|Dr\.?|PhD|Ph\.D\.)\b", " ", name, flags=re.I)
    name = re.sub(r"\s+", " ", name).strip(" -–—,;")
    role_words = [
        "editor",
        "board",
        "chair",
        "coordinator",
        "navigation",
        "about this journal",
        "articles",
        "publish with us",
        "aims and scope",
        "fees and funding",
    ]
    lowered = name.lower()
    if not name or any(word in lowered for word in role_words):
        return ""
    if len(name) > 70:
        return ""
    return name


def normalize_editor_role(label: str) -> str:
    lowered = label.lower()
    if "former" in lowered:
        return ""
    if re.search(r"editors?-in-chief|editors? in chief|chief editors?|co-editors?-in-chief", lowered):
        return "Editor-in-Chief"
    if re.search(r"associate editors?", lowered):
        return "Associate Editor"
    if re.search(r"section editors?|area editors?", lowered):
        return "Section Editor"
    if re.search(r"deputy editors?", lowered):
        return "Associate Editor"
    if "editorial board" in lowered or "advisory board" in lowered:
        return "Editorial Board"
    return ""


def normalize_country(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", value).strip(" ,;.-")
    aliases = {"USA": "United States", "UK": "United Kingdom", "Korea": "South Korea", "Turkey": "Türkiye"}
    for country in COUNTRY_TERMS:
        if cleaned.lower() == country.lower():
            return aliases.get(country, country)
    return ""


def editor_profile_from_affiliation(name: str, role: str, source_url: str, affiliation_text: str = "") -> dict:
    parts = [part.strip() for part in re.split(r"\s*,\s*", strip_html(affiliation_text)) if part.strip()]
    country_or_region = normalize_country(parts[-1]) if parts else ""
    affiliation = ""
    if parts:
        first = parts[0]
        if re.fullmatch(r"(Coordinating Editor|Editor|Associate Editor|Section Editor)", first, flags=re.I) and len(parts) > 1:
            first = parts[1]
        first = re.sub(r"^(Coordinating Editor|Editor|Associate Editor|Section Editor)\s*,\s*", "", first, flags=re.I)
        affiliation = first.strip()
    has_source_detail = bool(affiliation or country_or_region)
    return {
        "name": clean_heading_name(name) or name,
        "role": role,
        "affiliation": affiliation,
        "country_or_region": country_or_region,
        "source_url": source_url,
        "confidence": 0.88 if has_source_detail else 0.55,
        "verification_status": "public_source" if has_source_detail else "待官网核验",
    }


def extract_editor_cards_from_markup(markup: str, source_url: str) -> dict:
    profiles: list[dict] = []
    editors_in_chief: list[str] = []
    associate_editors: list[str] = []
    sections = re.findall(r"(?is)<section\b[^>]*>(.*?)</section>", markup or "")

    for section in sections:
        heading_match = re.search(r"(?is)<h[1-6][^>]*>(.*?)</h[1-6]>", section)
        if not heading_match:
            continue
        role = normalize_editor_role(strip_html(heading_match.group(1)))
        if not role:
            continue
        card_pattern = (
            r"(?is)<h[1-6][^>]*data-test=[\"']editorListing[\"'][^>]*>"
            r"(.*?)</h[1-6]>\s*"
            r"(?:<[^>]+>\s*){0,4}<div[^>]*class=[\"'][^\"']*(?:u-text-default|affiliation|institution)[^\"']*[\"'][^>]*>(.*?)</div>"
        )
        for match in re.finditer(card_pattern, section):
            raw_name = strip_html(match.group(1))
            name = clean_heading_name(raw_name)
            if not name or normalize_editor_role(name):
                continue
            profile = editor_profile_from_affiliation(name, role, source_url, match.group(2))
            if not profile["name"]:
                continue
            if profile not in profiles:
                profiles.append(profile)
            if role == "Editor-in-Chief" and profile["name"] not in editors_in_chief:
                editors_in_chief.append(profile["name"])
            if role in {"Associate Editor", "Section Editor"} and profile["name"] not in associate_editors:
                associate_editors.append(profile["name"])

    if not profiles:
        return {"status": "not_found", "source_url": "", "editors_in_chief": [], "associate_editors": [], "profiles": [], "note": ""}
    return {
        "status": "ok",
        "source_url": source_url,
        "editors_in_chief": editors_in_chief[:8],
        "associate_editors": associate_editors[:20],
        "profiles": profiles[:36],
        "note": "自动从公开编辑页面结构化条目抽取，投稿前请回官网核验。",
    }


def extract_editors_from_markup(markup: str, text: str, source_url: str) -> dict:
    card_result = extract_editor_cards_from_markup(markup, source_url)
    if card_result.get("status") == "ok":
        return card_result

    headings: list[tuple[int, str]] = []
    for match in re.finditer(r"(?is)<h([1-6])[^>]*>(.*?)</h\1>", markup or ""):
        label = strip_html(match.group(2))
        if label:
            headings.append((int(match.group(1)), label))

    if not headings:
        return extract_editors(text, source_url)

    editors_in_chief: list[str] = []
    associate_editors: list[str] = []
    profiles: list[dict] = []
    mode = ""
    stop_words = [
        "former",
        "managing editor",
        "consortia",
        "advisory board",
        "editorial board",
        "journal navigation",
        "about this journal",
        "articles",
    ]

    for _, heading in headings:
        lowered = heading.lower()
        if re.search(r"editors?-in-chief|editors? in chief|chief editors?", lowered):
            mode = "chief"
            continue
        if re.search(r"associate editors?|section editors?|deputy editors?", lowered):
            mode = "associate"
            continue
        if any(word in lowered for word in stop_words):
            mode = ""
            continue
        if not mode:
            continue

        name = clean_heading_name(heading)
        if not name:
            continue
        target = editors_in_chief if mode == "chief" else associate_editors
        if name not in target:
            target.append(name)
        role = "Editor-in-Chief" if mode == "chief" else "Associate / Section Editor"
        profile = editor_profile_from_context(name, role, source_url, text)
        if profile["name"] and profile not in profiles:
            profiles.append(profile)

    status = "ok" if editors_in_chief or associate_editors else "not_found"
    if status == "not_found":
        return {"status": "not_found", "source_url": "", "editors_in_chief": [], "associate_editors": [], "profiles": [], "note": ""}
    return {
        "status": "ok",
        "source_url": source_url,
        "editors_in_chief": editors_in_chief[:8],
        "associate_editors": associate_editors[:20],
        "profiles": profiles[:28],
        "note": "自动从公开编辑页面标题结构抽取，投稿前请回官网核验。",
    }


def merge_editor_info(current: dict | None, incoming: dict) -> dict:
    if not current or current.get("status") != "ok":
        return incoming
    merged = dict(current)
    for key, limit in [("editors_in_chief", 8), ("associate_editors", 20)]:
        values = list(merged.get(key, []))
        for value in incoming.get(key, []):
            if value not in values:
                values.append(value)
        merged[key] = values[:limit]
    profiles = list(merged.get("profiles", []))
    seen = {(profile.get("name"), profile.get("role")) for profile in profiles}
    for profile in incoming.get("profiles", []):
        key = (profile.get("name"), profile.get("role"))
        if key not in seen:
            profiles.append(profile)
            seen.add(key)
    merged["profiles"] = profiles[:36]
    if not merged.get("source_url") and incoming.get("source_url"):
        merged["source_url"] = incoming["source_url"]
    return merged


def guess_country_or_region(context: str) -> str:
    for country in COUNTRY_TERMS:
        if re.search(rf"\b{re.escape(country)}\b", context, flags=re.I):
            return {"USA": "United States", "UK": "United Kingdom", "Korea": "South Korea", "Turkey": "Türkiye"}.get(country, country)
    return ""


def guess_affiliation(context: str) -> str:
    institution_pattern = (
        r"([A-Z][A-Za-z&.'’() -]{2,}"
        r"(?:University|College|Institute|School|Academy|Université|Universidad|Polytechnic|Education University|Normal University)"
        r"[A-Za-z&.'’() -]{0,80})"
    )
    matches = []
    for match in re.finditer(institution_pattern, context):
        value = re.sub(r"\s+", " ", match.group(1)).strip(" ,;.-")
        if len(value) <= 120 and not re.search(r"^(Editor|Associate|Section|Chief)\b", value, flags=re.I):
            matches.append(value)
    return matches[0] if matches else ""


def editor_profile_from_context(name: str, role: str, source_url: str, text: str = "") -> dict:
    context = ""
    normalized = re.sub(r"\s+", " ", text or "")
    if normalized and name:
        index = normalized.lower().find(name.lower())
        if index >= 0:
            context = normalized[index : index + 240]
    affiliation = guess_affiliation(context)
    if affiliation and name.lower() in affiliation.lower():
        affiliation = ""
    if affiliation and len(affiliation.split()) > 10:
        affiliation = ""
    country_or_region = ""
    if affiliation:
        tail = context[context.lower().find(affiliation.lower()) + len(affiliation) : context.lower().find(affiliation.lower()) + len(affiliation) + 96]
        country_or_region = guess_country_or_region(tail)
    has_unit = bool(affiliation)
    has_region = bool(country_or_region)
    return {
        "name": name,
        "role": role,
        "affiliation": affiliation,
        "country_or_region": country_or_region,
        "source_url": source_url,
        "confidence": 0.82 if has_unit or has_region else 0.55,
        "verification_status": "public_source" if has_unit or has_region else "待官网核验",
    }


def topic_hits(text: str) -> Counter:
    lowered = text.lower()
    hits: Counter = Counter()
    for label, variants in TOPIC_TERMS:
        for variant in variants:
            if variant in lowered:
                hits[label] += 1
    return hits


def method_hits(text: str) -> Counter:
    lowered = text.lower()
    hits: Counter = Counter()
    for label, variants in METHOD_TERMS:
        for variant in variants:
            if variant in lowered:
                hits[label] += 1
    return hits


def journal_issns(journal: dict) -> list[str]:
    values: list[str] = []
    for key in ("issn", "eissn"):
        value = clean(journal.get(key))
        if value and value not in values:
            values.append(value)
    return values


def published_parts(item: dict) -> tuple[int | None, int | None]:
    for key in ("published", "published-online", "published-print", "issued"):
        date_parts = ((item.get(key) or {}).get("date-parts") or [])
        if date_parts and date_parts[0]:
            parts = date_parts[0]
            year = integer(parts[0]) if len(parts) >= 1 else None
            month = integer(parts[1]) if len(parts) >= 2 else None
            return year, month
    return None, None


def compact_subjects(value: object) -> str:
    if isinstance(value, list):
        return "; ".join(clean(item) for item in value if clean(item))
    return clean(value)


def crossref_url_for(issn: str, rows: int, from_pub_date: str = "2021-01-01") -> str:
    params = {
        "filter": f"type:journal-article,from-pub-date:{from_pub_date}",
        "select": "DOI,title,abstract,subject,published,published-print,published-online,issued,container-title,volume,issue,URL",
        "sort": "published",
        "order": "desc",
        "rows": str(max(1, min(rows, 100))),
    }
    return f"{CROSSREF_API}/journals/{quote(issn, safe='')}/works?{urlencode(params)}"


def fetch_crossref_articles(
    journal: dict, args: argparse.Namespace, captured_at: str
) -> tuple[list[dict], list[dict], list[dict], Counter, Counter]:
    sources: list[dict] = []
    articles: list[dict] = []
    docs: list[dict] = []
    topics: Counter = Counter()
    methods: Counter = Counter()
    issns = journal_issns(journal)
    if not issns:
        sources.append(
            {
                "journal_id": journal["id"],
                "journal_name": journal["name"],
                "url": "",
                "source_type": "article_metadata_api",
                "title": "Crossref journal works",
                "status": "failed",
                "error": "missing ISSN/eISSN",
                "text_chars": 0,
                "elapsed_ms": 0,
                "captured_at": captured_at,
            }
        )
        return sources, articles, docs, topics, methods

    last_error = ""
    for issn in issns:
        url = crossref_url_for(issn, args.max_articles_per_journal, args.crossref_from_pub_date)
        started = time.time()
        payload, error = request_json(url, args.timeout)
        elapsed_ms = int((time.time() - started) * 1000)
        items = ((payload.get("message") or {}).get("items") or []) if payload else []
        sources.append(
            {
                "journal_id": journal["id"],
                "journal_name": journal["name"],
                "url": url,
                "source_type": "article_metadata_api",
                "title": f"Crossref works for {issn}",
                "status": "ok" if items else "failed",
                "error": error or ("" if items else "no works returned"),
                "text_chars": len(json.dumps(payload, ensure_ascii=False)) if payload else 0,
                "elapsed_ms": elapsed_ms,
                "captured_at": captured_at,
            }
        )
        if error:
            last_error = error
        if not items:
            continue

        for item in items[: args.max_articles_per_journal]:
            title = " ".join(clean(part) for part in (item.get("title") or []) if clean(part))
            abstract = strip_markup_text(item.get("abstract", ""))
            keywords = compact_subjects(item.get("subject"))
            year, month = published_parts(item)
            doi = clean(item.get("DOI"))
            source_url = clean(item.get("URL")) or (f"https://doi.org/{doi}" if doi else "")
            text_blob = " ".join([title, abstract, keywords])
            article = {
                "journal_id": journal["id"],
                "journal_name": journal["name"],
                "url": source_url,
                "doi": doi,
                "title": title,
                "abstract": abstract[:1200],
                "keywords": keywords,
                "year": year,
                "month": month,
                "volume": clean(item.get("volume")),
                "issue": clean(item.get("issue")),
                "status": "ok",
                "error": "",
                "source": "crossref",
                "text_chars": len(text_blob),
                "elapsed_ms": elapsed_ms,
                "captured_at": captured_at,
            }
            articles.append(article)
            topics.update(topic_hits(text_blob))
            methods.update(method_hits(text_blob))
            if text_blob:
                docs.append(
                    {
                        "doc_id": make_doc_id(journal["id"], source_url or doi or title),
                        "journal_id": journal["id"],
                        "journal_name": journal["name"],
                        "source_url": source_url,
                        "source_type": "article_metadata",
                        "title": title or journal["name"],
                        "captured_at": captured_at,
                        "text_snippet": text_blob[: args.snippet_chars],
                    }
                )
        break

    if not articles and last_error:
        journal["article_api_error"] = last_error
    return sources, articles, docs, topics, methods


def build_article_preferences(articles: list[dict]) -> dict:
    topic_counts: Counter = Counter()
    method_counts: Counter = Counter()
    yearly: dict[str, Counter] = defaultdict(Counter)
    latest_key = None
    latest_articles: list[dict] = []

    sorted_articles = sorted(
        articles,
        key=lambda item: (
            integer(item.get("year")) or 0,
            integer(item.get("month")) or 0,
            clean(item.get("volume")),
            clean(item.get("issue")),
        ),
        reverse=True,
    )
    for article in sorted_articles:
        blob = " ".join([clean(article.get("title")), clean(article.get("abstract")), clean(article.get("keywords"))])
        topics = topic_hits(blob)
        methods = method_hits(blob)
        topic_counts.update(topics)
        method_counts.update(methods)
        year = clean(article.get("year"))
        if year:
            yearly[year].update(topics)
        key = (clean(article.get("year")), clean(article.get("volume")), clean(article.get("issue")))
        if latest_key is None and any(key):
            latest_key = key
        if latest_key and key == latest_key:
            latest_articles.append(article)

    latest_topics: Counter = Counter()
    for article in latest_articles:
        latest_topics.update(topic_hits(" ".join([clean(article.get("title")), clean(article.get("abstract")), clean(article.get("keywords"))])))

    yearly_topics = [
        {"year": year, "topics": dict(counter.most_common(5))}
        for year, counter in sorted(yearly.items(), reverse=True)
        if counter
    ][:5]
    return {
        "article_sample_count": len(articles),
        "topic_counts": dict(topic_counts.most_common(12)),
        "method_counts": dict(method_counts.most_common(8)),
        "yearly_topics": yearly_topics,
        "latest_issue": {
            "year": latest_key[0] if latest_key else "",
            "volume": latest_key[1] if latest_key else "",
            "issue": latest_key[2] if latest_key else "",
            "article_count": len(latest_articles),
            "top_topics": dict(latest_topics.most_common(6)),
            "sample_titles": [article.get("title", "") for article in latest_articles[:6] if article.get("title")],
        },
    }


def article_text(article: dict) -> str:
    return " ".join([clean(article.get("title")), clean(article.get("abstract")), clean(article.get("keywords"))])


def phrase_hits(text: str, terms: list[tuple[str, list[str]]]) -> Counter:
    lowered = text.lower()
    hits: Counter = Counter()
    for label, variants in terms:
        for variant in variants:
            if variant in lowered:
                hits[label] += 1
    return hits


def title_phrases(title: str) -> list[str]:
    title = re.sub(r"[:?].*$", "", clean(title))
    candidates: list[str] = []
    patterns = [
        r"\b(?:generative AI|GenAI|AI|LLM|large language model)[- A-Za-z]{4,46}",
        r"\b[A-Za-z]+(?:-[A-Za-z]+)? (?:feedback|literacy|analytics|assessment|adoption|engagement|wellbeing|motivation|pedagogy|collaboration)\b",
        r"\b(?:teacher|student|faculty|learner|postgraduate)[- A-Za-z]{4,42}",
    ]
    lowered_candidates: set[str] = set()
    for pattern in patterns:
        for match in re.finditer(pattern, title, flags=re.I):
            phrase = re.sub(r"\s+", " ", match.group(0)).strip(" ,;.-")
            if 8 <= len(phrase) <= 62 and phrase.lower() not in lowered_candidates:
                candidates.append(phrase)
                lowered_candidates.add(phrase.lower())
    if not candidates and title:
        words = [word for word in re.split(r"\s+", title) if len(word) > 3]
        if len(words) >= 3:
            candidates.append(" ".join(words[:5])[:62])
    return candidates[:3]


def preference_items(counter: Counter, level: str, category: str, evidence_lookup: dict[str, list[dict]], limit: int) -> list[dict]:
    items: list[dict] = []
    for label, value in counter.most_common(limit):
        items.append(
            {
                "label": label,
                "value": value,
                "level": level,
                "category": category,
                "evidence": evidence_lookup.get(label, [])[:5],
            }
        )
    return items


def build_preference_slice(articles: list[dict]) -> dict:
    general: Counter = Counter()
    specific: Counter = Counter()
    methods: Counter = Counter()
    very_specific: Counter = Counter()
    evidence: dict[str, list[dict]] = defaultdict(list)

    for article in articles:
        blob = article_text(article)
        article_evidence = {
            "title": clean(article.get("title")),
            "url": clean(article.get("url")),
            "doi": clean(article.get("doi")),
            "year": integer(article.get("year")),
            "volume": clean(article.get("volume")),
            "issue": clean(article.get("issue")),
        }
        for label, count in topic_hits(blob).items():
            general[label] += count
            evidence[label].append(article_evidence)
        for label, count in phrase_hits(blob, SPECIFIC_TERMS).items():
            specific[label] += count
            evidence[label].append(article_evidence)
        for label, count in method_hits(blob).items():
            methods[label] += count
            evidence[label].append(article_evidence)
        for phrase in title_phrases(clean(article.get("title"))):
            very_specific[phrase] += 1
            evidence[phrase].append(article_evidence)

    return {
        "sample_count": len(articles),
        "general": preference_items(general, "general", "topic", evidence, 12),
        "specific": preference_items(specific + methods, "specific", "method_or_theme", evidence, 12),
        "very_specific": preference_items(very_specific, "very_specific", "micro_topic", evidence, 12),
    }


def article_sort_key(article: dict) -> tuple:
    return (
        integer(article.get("year")) or 0,
        integer(article.get("month")) or 0,
        clean(article.get("volume")),
        clean(article.get("issue")),
        clean(article.get("title")),
    )


def article_month_index(article: dict) -> int | None:
    year = integer(article.get("year"))
    if not year:
        return None
    month = integer(article.get("month")) or 12
    return year * 12 + max(1, min(month, 12))


def slice_with_meta(key: str, articles: list[dict], description: str = "", **extra: object) -> dict:
    result = build_preference_slice(articles)
    result["slice_key"] = key
    result["description"] = description or f"{len(articles)} articles"
    result.update(extra)
    return result


def year_span_description(articles: list[dict]) -> str:
    years = sorted({year for article in articles if (year := integer(article.get("year")))})
    if not years:
        return f"{len(articles)} articles"
    span = str(years[-1]) if years[0] == years[-1] else f"{years[0]}-{years[-1]}"
    return f"{span} · {len(articles)} articles"


def issue_group(article: dict, prefer_month: bool = False) -> tuple[tuple, str]:
    year = clean(article.get("year"))
    volume = clean(article.get("volume"))
    issue = clean(article.get("issue"))
    month = integer(article.get("month"))
    if prefer_month and year and month:
        return ("month", year, f"{month:02d}"), f"{year}-{month:02d}"
    if year and volume and issue:
        return ("issue", year, volume, issue), f"{year} Vol. {volume} Issue {issue}"
    if year and volume:
        return ("volume", year, volume), f"{year} Vol. {volume}"
    if year and month:
        return ("month", year, f"{month:02d}"), f"{year}-{month:02d}"
    if year:
        return ("year", year), year
    return tuple(), "undated"


def issue_groups(sorted_articles: list[dict], prefer_month: bool = False) -> list[tuple[tuple, dict]]:
    groups: dict[tuple, dict] = {}
    for article in sorted_articles:
        key, label = issue_group(article, prefer_month)
        if not any(key):
            continue
        group = groups.setdefault(
            key,
            {
                "label": label,
                "articles": [],
                "sort_key": article_sort_key(article),
                "months": set(),
            },
        )
        group["articles"].append(article)
        group["sort_key"] = max(group["sort_key"], article_sort_key(article))
        month_index = article_month_index(article)
        if month_index is not None:
            group["months"].add(month_index)
    return sorted(groups.items(), key=lambda item: item[1]["sort_key"], reverse=True)


def should_approximate_issues_by_month(sorted_articles: list[dict]) -> bool:
    groups = issue_groups(sorted_articles)
    if not groups:
        return False
    latest_key, latest_group = groups[0]
    if latest_key and latest_key[0] not in {"issue", "volume"}:
        return False
    return len(latest_group.get("months", set())) > 1 and len(latest_group.get("articles", [])) >= 6


def issue_slice(sorted_articles: list[dict], count: int, prefer_month: bool = False) -> tuple[list[dict], tuple | None, str, dict]:
    ordered = issue_groups(sorted_articles, prefer_month)
    selected = ordered[:count]
    selected_articles = [article for _, group in selected for article in group["articles"]]
    labels = [group["label"] for _, group in selected]
    if not selected_articles:
        return [], None, "0 articles", {}
    label_text = ", ".join(labels[:3])
    extra = {}
    if prefer_month:
        extra = {
            "fallback_mode": "month_approximation",
            "fallback_reason": "volume/issue metadata spans multiple publication months",
        }
    return selected_articles, selected[0][0], f"{label_text} · {len(selected_articles)} articles", extra


def rolling_slice(sorted_articles: list[dict], years: int) -> list[dict]:
    dated = [(article, article_month_index(article)) for article in sorted_articles]
    dated = [(article, index) for article, index in dated if index is not None]
    if not dated:
        return []
    anchor = max(index for _, index in dated)
    cutoff = anchor - years * 12 + 1
    return [article for article, index in dated if index >= cutoff]


def article_identity(article: dict) -> str:
    return clean(article.get("doi")) or clean(article.get("url")) or clean(article.get("title"))


def article_set_signature(articles: list[dict]) -> tuple[str, ...]:
    return tuple(article_identity(article) for article in articles if article_identity(article))


def rolling_windows_are_collapsed(rolling_articles: dict[int, list[dict]], sorted_articles: list[dict]) -> bool:
    if len(sorted_articles) < 6:
        return False
    signatures = [article_set_signature(rolling_articles[years]) for years in [1, 2, 3, 5]]
    return len(set(signatures)) <= 1 and bool(signatures[0])


def depth_fallback_limits(total: int) -> dict[int, int]:
    return {
        1: max(3, min(total, math.ceil(total * 0.30))),
        2: max(5, min(total, math.ceil(total * 0.55))),
        3: max(7, min(total, math.ceil(total * 0.80))),
        5: total,
    }


def depth_fallback_description(articles: list[dict], total: int) -> str:
    years = sorted({year for article in articles if (year := integer(article.get("year")))})
    span = str(years[-1]) if years and years[0] == years[-1] else (f"{years[0]}-{years[-1]}" if years else "captured samples")
    return f"{span} · latest {len(articles)}/{total} samples (limited time spread)"


def build_preference_record(journal: dict, articles: list[dict]) -> dict:
    sorted_articles = sorted(
        articles,
        key=article_sort_key,
        reverse=True,
    )
    approximate_issues_by_month = should_approximate_issues_by_month(sorted_articles)
    latest_articles, latest_key, latest_description, latest_extra = issue_slice(sorted_articles, 1, approximate_issues_by_month)
    recent_articles, _, recent_description, recent_extra = issue_slice(sorted_articles, 3, approximate_issues_by_month)
    rolling_articles = {years: rolling_slice(sorted_articles, years) for years in [1, 2, 3, 5]}
    rolling_descriptions = {years: year_span_description(rolling_articles[years]) for years in [1, 2, 3, 5]}
    rolling_extra = {years: {} for years in [1, 2, 3, 5]}
    if rolling_windows_are_collapsed(rolling_articles, sorted_articles):
        limits = depth_fallback_limits(len(sorted_articles))
        for years in [1, 2, 3, 5]:
            rolling_articles[years] = sorted_articles[: limits[years]]
            rolling_descriptions[years] = depth_fallback_description(rolling_articles[years], len(sorted_articles))
            rolling_extra[years] = {
                "fallback_mode": "recent_sample_depth",
                "fallback_reason": "captured article dates are too concentrated for distinct year windows",
            }
    slices = {
        "recent_3_issues": slice_with_meta("recent_3_issues", recent_articles, recent_description, **recent_extra),
        "latest_issue": slice_with_meta("latest_issue", latest_articles, latest_description, **latest_extra),
        "rolling_1y": slice_with_meta("rolling_1y", rolling_articles[1], rolling_descriptions[1], **rolling_extra[1]),
        "rolling_2y": slice_with_meta("rolling_2y", rolling_articles[2], rolling_descriptions[2], **rolling_extra[2]),
        "rolling_3y": slice_with_meta("rolling_3y", rolling_articles[3], rolling_descriptions[3], **rolling_extra[3]),
        "rolling_5y": slice_with_meta("rolling_5y", rolling_articles[5], rolling_descriptions[5], **rolling_extra[5]),
        "all": slice_with_meta("all", sorted_articles, f"All captured samples · {len(sorted_articles)} articles"),
    }
    for year in ["2026", "2025", "2024", "2023"]:
        year_articles = [article for article in sorted_articles if clean(article.get("year")) == year]
        slices[year] = slice_with_meta(year, year_articles, year_span_description(year_articles))
    return {
        "journal_id": journal["id"],
        "journal_name": journal["name"],
        "latest_issue": {
            "year": latest_articles[0].get("year") if latest_articles else "",
            "volume": latest_articles[0].get("volume") if latest_articles else "",
            "issue": latest_articles[0].get("issue") if latest_articles else "",
            "group_key": list(latest_key) if latest_key else [],
            "description": latest_description if latest_articles else "",
            "fallback_mode": latest_extra.get("fallback_mode", ""),
            "fallback_reason": latest_extra.get("fallback_reason", ""),
        },
        "available_time_slices": [key for key, value in slices.items() if value["sample_count"] > 0 or key == "all"],
        "slices": slices,
    }


def build_editor_profile_record(journal: dict) -> dict:
    editors = journal.get("editors") or {}
    profiles = list(editors.get("profiles") or [])
    source_url = clean(editors.get("source_url"))
    for role, key in [("Editor-in-Chief", "editors_in_chief"), ("Associate / Section Editor", "associate_editors")]:
        for name in editors.get(key, []):
            if not any(profile.get("name") == name and profile.get("role") == role for profile in profiles):
                profiles.append(editor_profile_from_context(name, role, source_url, ""))
    return {
        "journal_id": journal["id"],
        "journal_name": journal["name"],
        "source_url": source_url,
        "status": editors.get("status", "not_found"),
        "profiles": profiles,
        "note": editors.get("note", ""),
    }


def make_doc_id(*parts: str) -> str:
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:12]
    return f"doc-{digest}"


def read_workbook(excel_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    main = pd.read_excel(excel_path, sheet_name="总表")
    log = pd.read_excel(excel_path, sheet_name="本轮更新日志")
    return main, log


def build_journals(main: pd.DataFrame, log: pd.DataFrame) -> list[dict]:
    rows = main[main["Journal name"].astype(str).str.strip().ne("")].copy()
    log_lookup = log.drop_duplicates("Journal name").set_index("Journal name").to_dict("index")
    journals: list[dict] = []

    for index, (_, row) in enumerate(rows.iterrows(), start=1):
        name = clean(row.get("Journal name"))
        log_row = log_lookup.get(name, {})
        urls = parse_urls(log_row.get("官网抓取页面", ""))
        publisher = clean(row.get("Publisher")) or clean(row.get("出版社"))
        main_tag = clean(row.get("主标签")) or "未标注"
        secondary_tag = clean(row.get("副标签"))
        if secondary_tag in {"—", "-"}:
            secondary_tag = ""
        journal_id = f"journal-{index:03d}-{slugify(name, str(index))[:48]}"
        publications = {
            "2022": integer(row.get("2022发文量")),
            "2023": integer(row.get("2023发文量")),
            "2024": integer(row.get("2024年发文量")),
            "2025": integer(row.get("2025年发文量")),
        }

        journals.append(
            {
                "id": journal_id,
                "rank": index,
                "name": name,
                "abbreviation": clean(row.get("Arrb")) or clean(row.get("JCR Abbreviation")),
                "jcr_abbreviation": clean(row.get("JCR Abbreviation")),
                "jif_2025": number(row.get("2025 JIF")),
                "jci_2025": number(row.get("2025 JCI")),
                "quartile": clean(row.get("JIF Quartile")),
                "main_tag": main_tag,
                "secondary_tag": secondary_tag,
                "tag_path": " / ".join([tag for tag in [main_tag, secondary_tag] if tag]),
                "publications": publications,
                "word_limit": clean(row.get("words limited")),
                "first_decision_days": integer(row.get("First decision")),
                "review_time_days": integer(row.get("Review time")),
                "submission_to_accept_days": integer(row.get("Submission to acc")),
                "acceptance_rate": clean(row.get("Acc rate (录用率)")),
                "submission_system": clean(row.get("投稿系统")),
                "publisher": publisher,
                "publisher_family": publisher_family(publisher, urls),
                "issn": clean(row.get("ISSN")),
                "eissn": clean(row.get("eISSN")),
                "category": clean(row.get("Category")),
                "source_urls": urls,
                "crawl_notes": clean(log_row.get("抓取错误/备注", "")),
                "editors": {
                    "status": "not_started",
                    "source_url": "",
                    "editors_in_chief": [],
                    "associate_editors": [],
                    "profiles": [],
                    "note": "",
                },
                "article_preferences": {
                    "article_sample_count": 0,
                    "topic_counts": {},
                    "method_counts": {},
                    "yearly_topics": [],
                    "latest_issue": {
                        "year": "",
                        "volume": "",
                        "issue": "",
                        "article_count": 0,
                        "top_topics": {},
                        "sample_titles": [],
                    },
                },
            }
        )

    return journals


def crawl_journal(
    journal: dict, args: argparse.Namespace, captured_at: str
) -> tuple[list[dict], list[dict], list[dict], Counter, Counter, dict]:
    sources: list[dict] = []
    articles: list[dict] = []
    docs: list[dict] = []
    topics: Counter = Counter()
    methods: Counter = Counter()
    article_links: list[str] = []
    editorial_links: list[str] = candidate_editorial_urls(journal.get("source_urls", []))
    editor_info = dict(journal.get("editors") or {})
    source_urls = journal.get("source_urls", [])[: args.max_pages_per_journal]

    base_text = " ".join(
        clean(value)
        for value in [
            journal["name"],
            journal["main_tag"],
            journal["secondary_tag"],
            journal["publisher"],
            journal["word_limit"],
        ]
    )
    topics.update(topic_hits(base_text))
    methods.update(method_hits(base_text))

    for url in source_urls:
        started = time.time()
        markup, error = request_text(url, args.timeout)
        elapsed_ms = int((time.time() - started) * 1000)
        text = strip_html(markup) if markup else ""
        title = page_title(markup) if markup else ""
        description = meta_content(markup, "description", "og:description", "dc.description") if markup else ""
        readable = len(text) >= args.min_text_chars
        source = {
            "journal_id": journal["id"],
            "journal_name": journal["name"],
            "url": url,
            "source_type": source_type_for_url(url),
            "title": title,
            "status": "ok" if readable else ("failed" if error else "content_too_short"),
            "error": error or "",
            "text_chars": len(text),
            "elapsed_ms": elapsed_ms,
            "captured_at": captured_at,
        }
        sources.append(source)

        if readable:
            snippet = text[: args.snippet_chars]
            docs.append(
                {
                    "doc_id": make_doc_id(journal["id"], url),
                    "journal_id": journal["id"],
                    "journal_name": journal["name"],
                    "source_url": url,
                    "source_type": source["source_type"],
                    "title": title or journal["name"],
                    "captured_at": captured_at,
                    "text_snippet": snippet,
                }
            )
            topics.update(topic_hits(f"{title} {description} {snippet}"))
            methods.update(method_hits(f"{title} {description} {snippet}"))
            for link in extract_links(markup, url):
                if link not in article_links:
                    article_links.append(link)
            for link in extract_editorial_links(markup, url):
                if link not in editorial_links and link not in source_urls:
                    editorial_links.append(link)
            if re.search(r"editor(?:s|ial|[- ]in[- ]chief| board)", f"{url} {title}", flags=re.I):
                editor_info = merge_editor_info(editor_info, extract_editors_from_markup(markup, text, url))

        if is_article_url(url) and url not in article_links:
            article_links.insert(0, url)

    for url in editorial_links[: args.max_editor_pages]:
        started = time.time()
        markup, error = request_text(url, args.timeout)
        elapsed_ms = int((time.time() - started) * 1000)
        text = strip_html(markup) if markup else ""
        title = page_title(markup) if markup else ""
        readable = len(text) >= args.min_text_chars
        sources.append(
            {
                "journal_id": journal["id"],
                "journal_name": journal["name"],
                "url": url,
                "source_type": "editorial_board",
                "title": title,
                "status": "ok" if readable else ("failed" if error else "content_too_short"),
                "error": error or "",
                "text_chars": len(text),
                "elapsed_ms": elapsed_ms,
                "captured_at": captured_at,
            }
        )
        if readable:
            editor_info = merge_editor_info(editor_info, extract_editors_from_markup(markup, text, url))
            docs.append(
                {
                    "doc_id": make_doc_id(journal["id"], url),
                    "journal_id": journal["id"],
                    "journal_name": journal["name"],
                    "source_url": url,
                    "source_type": "editorial_board",
                    "title": title or journal["name"],
                    "captured_at": captured_at,
                    "text_snippet": text[: args.snippet_chars],
                }
            )

    for url in article_links[: args.max_articles_per_journal]:
        started = time.time()
        markup, error = request_text(url, args.timeout)
        elapsed_ms = int((time.time() - started) * 1000)
        text = strip_html(markup) if markup else ""
        title = page_title(markup) if markup else ""
        abstract = meta_content(markup, "description", "og:description", "citation_abstract") if markup else ""
        keywords = meta_content(markup, "citation_keywords", "keywords", "dc.subject") if markup else ""
        status = "ok" if len(text) >= args.min_text_chars else ("failed" if error else "content_too_short")
        article = {
            "journal_id": journal["id"],
            "journal_name": journal["name"],
            "url": url,
            "title": title,
            "abstract": abstract[:1000],
            "keywords": keywords,
            "status": status,
            "error": error or "",
            "text_chars": len(text),
            "elapsed_ms": elapsed_ms,
            "captured_at": captured_at,
        }
        articles.append(article)
        if status == "ok":
            snippet = " ".join([abstract, text])[: args.snippet_chars]
            docs.append(
                {
                    "doc_id": make_doc_id(journal["id"], url),
                    "journal_id": journal["id"],
                    "journal_name": journal["name"],
                    "source_url": url,
                    "source_type": "article",
                    "title": title or journal["name"],
                    "captured_at": captured_at,
                    "text_snippet": snippet,
                }
            )
            topics.update(topic_hits(f"{title} {abstract} {keywords} {snippet}"))
            methods.update(method_hits(f"{title} {abstract} {keywords} {snippet}"))

    if editor_info.get("status") == "not_started":
        editor_info["status"] = "not_found"
    return sources, articles, docs, topics, methods, editor_info


def build_network(journals: list[dict], journal_topics: dict[str, Counter], journal_methods: dict[str, Counter]) -> dict:
    nodes: dict[str, dict] = {}
    links: list[dict] = []

    def add_node(node_id: str, label: str, kind: str, **extra: object) -> None:
        if node_id not in nodes:
            nodes[node_id] = {"id": node_id, "label": label, "type": kind, **extra}

    for journal in journals:
        jid = journal["id"]
        add_node(
            jid,
            journal["name"],
            "journal",
            jif=journal.get("jif_2025"),
            jci=journal.get("jci_2025"),
            quartile=journal.get("quartile"),
            main_tag=journal.get("main_tag"),
            publisher_family=journal.get("publisher_family"),
        )
        publisher_id = f"publisher-{slugify(journal['publisher_family'], 'publisher')}"
        add_node(publisher_id, journal["publisher_family"], "publisher")
        links.append({"source": jid, "target": publisher_id, "weight": 1.0, "relation": "publisher"})

        for tag in [journal.get("main_tag"), journal.get("secondary_tag")]:
            if tag:
                topic_id = f"topic-{slugify(tag, 'topic')}"
                add_node(topic_id, tag, "topic")
                links.append({"source": jid, "target": topic_id, "weight": 2.0, "relation": "jcr_tag"})

        for topic, count in journal_topics.get(jid, Counter()).most_common(6):
            topic_id = f"topic-{slugify(topic, 'topic')}"
            add_node(topic_id, topic, "topic")
            links.append({"source": jid, "target": topic_id, "weight": min(6.0, 1.0 + count), "relation": "text_topic"})

        for method, count in journal_methods.get(jid, Counter()).most_common(4):
            method_id = f"method-{slugify(method, 'method')}"
            add_node(method_id, method, "method_or_theme")
            links.append({"source": jid, "target": method_id, "weight": min(5.0, 1.0 + count), "relation": "method_or_theme"})

    return {"nodes": list(nodes.values()), "links": links}


def summarize(
    journals: list[dict],
    sources: list[dict],
    articles: list[dict],
    docs: list[dict],
    captured_at: str,
    editor_profiles: list[dict] | None = None,
    journal_preferences: list[dict] | None = None,
) -> dict:
    journal_count = len(journals)
    q1_count = sum(1 for journal in journals if clean(journal.get("quartile")).upper() == "Q1")
    with_sources = sum(1 for journal in journals if journal.get("source_urls"))
    success_sources = sum(1 for source in sources if source["status"] == "ok")
    failed_sources = sum(1 for source in sources if source["status"] == "failed")
    short_sources = sum(1 for source in sources if source["status"] == "content_too_short")
    editors_found = sum(
        1
        for journal in journals
        if (journal.get("editors") or {}).get("editors_in_chief") or (journal.get("editors") or {}).get("associate_editors")
    )
    profile_rows = [profile for record in (editor_profiles or []) for profile in record.get("profiles", [])]
    preference_rows = journal_preferences or []
    preference_range_keys = ["recent_3_issues", "latest_issue", "rolling_1y", "rolling_2y", "rolling_3y", "rolling_5y", "all"]
    preference_range_counts = {
        key: sum(1 for record in preference_rows if (record.get("slices") or {}).get(key, {}).get("sample_count", 0) > 0)
        for key in preference_range_keys
    }

    def missing_rate(field: str) -> dict:
        missing = sum(1 for journal in journals if journal.get(field) in ("", None))
        return {"missing": missing, "total": journal_count, "rate": round(missing / max(1, journal_count), 4)}

    return {
        "generated_at": captured_at,
        "expected_journal_count": EXPECTED_JOURNAL_COUNT,
        "journal_count": journal_count,
        "journal_count_matches_expected": journal_count == EXPECTED_JOURNAL_COUNT,
        "expected_q1_count": Q1_EXPECTED_COUNT,
        "q1_count": q1_count,
        "q1_count_matches_expected": q1_count == Q1_EXPECTED_COUNT,
        "journals_with_source_urls": with_sources,
        "source_pages": {
            "total": len(sources),
            "ok": success_sources,
            "failed": failed_sources,
            "content_too_short": short_sources,
        },
        "articles": {
            "total": len(articles),
            "ok": sum(1 for article in articles if article["status"] == "ok"),
            "failed": sum(1 for article in articles if article["status"] == "failed"),
            "content_too_short": sum(1 for article in articles if article["status"] == "content_too_short"),
        },
        "editors": {
            "journals_with_editor_names": editors_found,
            "journals_without_editor_names": journal_count - editors_found,
        },
        "speed_coverage": {
            "first_decision_days": journal_count - missing_rate("first_decision_days")["missing"],
            "review_time_days": journal_count - missing_rate("review_time_days")["missing"],
            "submission_to_accept_days": journal_count - missing_rate("submission_to_accept_days")["missing"],
            "total": journal_count,
        },
        "editor_profile_coverage": {
            "profiles": len(profile_rows),
            "with_affiliation": sum(1 for profile in profile_rows if clean(profile.get("affiliation"))),
            "with_country_or_region": sum(1 for profile in profile_rows if clean(profile.get("country_or_region"))),
            "pending_verification": sum(1 for profile in profile_rows if profile.get("verification_status") == "待官网核验"),
        },
        "preference_coverage": {
            "journals_with_any_articles": sum(1 for record in preference_rows if (record.get("slices") or {}).get("all", {}).get("sample_count", 0) > 0),
            "journals_with_latest_issue": sum(1 for record in preference_rows if (record.get("slices") or {}).get("latest_issue", {}).get("sample_count", 0) > 0),
            "range_slices": preference_range_counts,
            "total": journal_count,
        },
        "rag_documents": len(docs),
        "missing_fields": {
            "jif_2025": missing_rate("jif_2025"),
            "jci_2025": missing_rate("jci_2025"),
            "main_tag": missing_rate("main_tag"),
            "publisher": missing_rate("publisher"),
            "issn": missing_rate("issn"),
            "eissn": missing_rate("eissn"),
            "source_urls": missing_rate("source_urls"),
            "first_decision_days": missing_rate("first_decision_days"),
            "review_time_days": missing_rate("review_time_days"),
        },
        "quartiles": Counter(clean(journal["quartile"]).upper() for journal in journals).most_common(),
        "top_publishers": Counter(journal["publisher_family"] for journal in journals).most_common(12),
        "top_main_tags": Counter(journal["main_tag"] for journal in journals).most_common(12),
    }


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_jsonl(path: Path, records: Iterable[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate AIED research radar data.")
    parser.add_argument("--excel", type=Path, default=DEFAULT_EXCEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--source-snapshot", type=Path, default=None)
    parser.add_argument("--skip-crawl", action="store_true", help="Only generate workbook-derived data.")
    parser.add_argument("--skip-article-api", action="store_true", help="Skip Crossref latest article metadata.")
    parser.add_argument("--max-pages-per-journal", type=int, default=4)
    parser.add_argument("--max-editor-pages", type=int, default=1)
    parser.add_argument("--max-articles-per-journal", type=int, default=50)
    parser.add_argument("--crossref-from-pub-date", default="2021-01-01", help="Earliest Crossref publication date to request.")
    parser.add_argument("--crawl-journal-limit", type=int, default=0, help="Crawl only the first N journals; 0 means all.")
    parser.add_argument("--timeout", type=int, default=10)
    parser.add_argument("--min-text-chars", type=int, default=220)
    parser.add_argument("--snippet-chars", type=int, default=1400)
    args = parser.parse_args()
    snapshot_path = args.source_snapshot or (args.output / "source_workbook_snapshot.json")

    args.output.mkdir(parents=True, exist_ok=True)
    captured_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    if args.excel.exists():
        main_sheet, update_log = read_workbook(args.excel)
        journals = build_journals(main_sheet, update_log)
        write_json(snapshot_path, journals)
    elif snapshot_path.exists():
        journals = json.loads(snapshot_path.read_text(encoding="utf-8"))
        print(f"Excel workbook not found; using source snapshot: {snapshot_path}", file=sys.stderr)
    else:
        print(f"Excel workbook not found and no snapshot exists: {args.excel}", file=sys.stderr)
        return 1

    sources: list[dict] = []
    articles: list[dict] = []
    docs: list[dict] = []
    journal_topics: dict[str, Counter] = defaultdict(Counter)
    journal_methods: dict[str, Counter] = defaultdict(Counter)
    articles_by_journal: dict[str, list[dict]] = defaultdict(list)

    for index, journal in enumerate(journals, start=1):
        if index == 1 or index % 25 == 0 or index == len(journals):
            print(f"Processing journal {index}/{len(journals)}: {journal['name']}", file=sys.stderr)
        base_doc = {
            "doc_id": make_doc_id(journal["id"], "workbook"),
            "journal_id": journal["id"],
            "journal_name": journal["name"],
            "source_url": journal["source_urls"][0] if journal["source_urls"] else "",
            "source_type": "jcr_workbook",
            "title": journal["name"],
            "captured_at": captured_at,
            "text_snippet": "；".join(
                part
                for part in [
                    f"JIF {journal.get('jif_2025')}",
                    f"JCI {journal.get('jci_2025')}",
                    f"JCR分区 {journal.get('quartile')}",
                    f"主标签 {journal.get('main_tag')}",
                    f"副标签 {journal.get('secondary_tag')}",
                    f"出版社 {journal.get('publisher_family')}",
                    f"投稿系统 {journal.get('submission_system')}",
                    f"First decision {journal.get('first_decision_days')} days",
                    f"Review time {journal.get('review_time_days')} days",
                    clean(journal.get("word_limit")),
                ]
                if part and "None" not in part
            ),
        }
        docs.append(base_doc)
        journal_topics[journal["id"]].update(topic_hits(base_doc["text_snippet"]))
        journal_methods[journal["id"]].update(method_hits(base_doc["text_snippet"]))

        if not args.skip_crawl and not args.skip_article_api:
            api_sources, api_articles, api_docs, topics, methods = fetch_crossref_articles(journal, args, captured_at)
            sources.extend(api_sources)
            articles.extend(api_articles)
            docs.extend(api_docs)
            articles_by_journal[journal["id"]].extend(api_articles)
            journal_topics[journal["id"]].update(topics)
            journal_methods[journal["id"]].update(methods)

        should_crawl = not args.skip_crawl and (args.crawl_journal_limit <= 0 or index <= args.crawl_journal_limit)
        if should_crawl:
            journal_sources, journal_articles, journal_docs, topics, methods, editor_info = crawl_journal(journal, args, captured_at)
            sources.extend(journal_sources)
            articles.extend(journal_articles)
            docs.extend(journal_docs)
            articles_by_journal[journal["id"]].extend(journal_articles)
            journal_topics[journal["id"]].update(topics)
            journal_methods[journal["id"]].update(methods)
            journal["editors"] = editor_info

    for journal in journals:
        journal_articles = articles_by_journal.get(journal["id"], [])
        journal["topic_hits"] = dict(journal_topics[journal["id"]])
        journal["method_hits"] = dict(journal_methods[journal["id"]])
        journal["article_count_crawled"] = len(journal_articles)
        journal["source_pages_crawled"] = sum(
            1
            for source in sources
            if source["journal_id"] == journal["id"] and source.get("source_type") != "article_metadata_api"
        )
        journal["article_preferences"] = build_article_preferences(journal_articles)
        if not journal.get("editors"):
            journal["editors"] = {
                "status": "not_found",
                "source_url": "",
                "editors_in_chief": [],
                "associate_editors": [],
                "profiles": [],
                "note": "",
            }

    q1_journals = [journal for journal in journals if clean(journal.get("quartile")).upper() == "Q1"]
    journal_preferences = [build_preference_record(journal, articles_by_journal.get(journal["id"], [])) for journal in journals]
    editor_profiles = [build_editor_profile_record(journal) for journal in journals]
    write_json(args.output / "journals.json", journals)
    write_json(args.output / "journals_q1.json", q1_journals)
    write_json(args.output / "journal_sources.json", sources)
    write_json(args.output / "research_network.json", build_network(journals, journal_topics, journal_methods))
    write_json(args.output / "journal_preferences.json", journal_preferences)
    write_json(args.output / "editor_profiles.json", editor_profiles)
    write_json(args.output / "crawl_report.json", summarize(journals, sources, articles, docs, captured_at, editor_profiles, journal_preferences))
    write_json(
        args.output / "radar-config.json",
        {
            "api_base_url": "",
            "access_mode": "semi_public_code",
            "llm_provider": "modelscope",
            "model_hint": "Qwen/Qwen3-30B-A3B-Instruct-2507",
            "pages_url": "https://jojo-edtech.github.io/aied-journal/",
        },
    )
    write_jsonl(args.output / "journal_articles.jsonl", articles)
    write_jsonl(args.output / "rag_documents.jsonl", docs)

    report = summarize(journals, sources, articles, docs, captured_at, editor_profiles, journal_preferences)
    print(
        json.dumps(
            {
                "journal_count": report["journal_count"],
                "journal_count_matches_expected": report["journal_count_matches_expected"],
                "q1_count": report["q1_count"],
                "q1_count_matches_expected": report["q1_count_matches_expected"],
                "source_pages": report["source_pages"],
                "articles": report["articles"],
                "editors": report["editors"],
                "rag_documents": report["rag_documents"],
                "output": str(args.output),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["journal_count_matches_expected"] and report["q1_count_matches_expected"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
