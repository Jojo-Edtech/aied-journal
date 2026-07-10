import test from "node:test";
import assert from "node:assert/strict";

import { expandQueryTerms, rankJournals, journalSeekingIntent, fallbackJournals, displaySources } from "./index.mjs";

const journals = [
  {
    id: "eait",
    name: "Education and Information Technologies",
    abbreviation: "EAIT",
    quartile: "Q1",
    jci_2025: 1.8,
    main_tag: "教育技术",
    publications: { "2022": 676, "2023": 829, "2024": 822, "2025": 604 },
    topic_hits: { "Generative AI": 24, "Educational technology": 3 },
  },
  {
    id: "ijethe",
    name: "International Journal of Educational Technology in Higher Education",
    abbreviation: "IJETHE",
    quartile: "Q1",
    jci_2025: 3.9,
    main_tag: "教育技术",
    topic_hits: { "Higher education": 20 },
  },
  {
    id: "tte",
    name: "Teaching and Teacher Education",
    abbreviation: "TTE",
    quartile: "Q1",
    jci_2025: 2.4,
    main_tag: "教师教育与教师发展",
    topic_hits: { "Teacher education": 30 },
  },
];

function data() {
  return { journals, sourcesByJournal: new Map() };
}

test("mixed English and Chinese query extracts the journal abbreviation", () => {
  assert.ok(expandQueryTerms("EAIT每年发文量多少").includes("eait"));
  const ranked = rankJournals("EAIT每年发文量多少", data());
  assert.equal(ranked[0].journal.id, "eait");
  assert.equal(ranked[0].directMatch, true);
});

test("topic query searches the full journal set", () => {
  const ranked = rankJournals("教师教育有什么期刊", data());
  assert.equal(ranked[0].journal.id, "tte");
});

test("unrelated queries do not fall back to default high-JCI journals", () => {
  assert.deepEqual(rankJournals("今天天气怎么样", data()), []);
});

test("edtech shorthand matches educational technology journals", () => {
  const ranked = rankJournals("edtech顶刊有哪些", data());
  assert.ok(ranked.length >= 2);
  assert.ok(ranked.every((item) => item.journal.main_tag === "教育技术"));
});

test("journal-seeking intent is detected for fallback, chit-chat is not", () => {
  assert.equal(journalSeekingIntent("有哪些值得投稿的期刊"), true);
  assert.equal(journalSeekingIntent("edtech顶刊有哪些"), true);
  assert.equal(journalSeekingIntent("今天天气怎么样"), false);
});

test("fallback ranks by JIF and keeps journal shape", () => {
  const withJif = {
    journals: journals.map((journal, index) => ({ ...journal, jif_2025: index + 1 })),
    sourcesByJournal: new Map(),
  };
  const fallback = fallbackJournals(withJif);
  assert.equal(fallback[0].journal.id, "tte");
  assert.equal(fallback[0].directMatch, false);
});

test("displaySources drops raw API endpoints and falls back to the homepage", () => {
  const sources = [
    { source_type: "article_metadata_api", url: "https://api.crossref.org/journals/1234-5678/works?filter=x" },
  ];
  const journal = { source_urls: ["https://api.crossref.org/journals/1234-5678/works", "https://www.springer.com/journal/123"] };
  const shown = displaySources(sources, journal);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].source_type, "journal_homepage");
  assert.equal(shown[0].source_url, "https://www.springer.com/journal/123");

  const readable = displaySources(
    [
      { source_type: "author_guidelines", url: "https://www.springer.com/journal/123/submission-guidelines" },
      { source_type: "article_metadata_api", url: "https://api.crossref.org/journals/1234-5678/works" },
    ],
    journal
  );
  assert.equal(readable.length, 1);
  assert.equal(readable[0].source_type, "author_guidelines");
});
