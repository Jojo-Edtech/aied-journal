import test from "node:test";
import assert from "node:assert/strict";

import { expandQueryTerms, rankJournals } from "./index.mjs";

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
