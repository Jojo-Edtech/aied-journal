import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { buildLocalData } from "./build-local-data.mjs";

const loaderSource = await readFile(new URL("../data-loader.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const record = (id) => ({ journal_id: id, slices: { all: { sample_count: 1, general: [{ label: "教育 </script>", evidence: [] }] } } });
const index = (ids = ["journal-a", "journal-b"]) => ({ schema_version: 1, journals: Object.fromEntries(ids.map((id) => [id, { path: `journal_preferences/${id}.json`, sample_count: 1 }])) });

function createLoader(protocol, fetch, append = () => assert.fail("Unexpected script request")) {
  const context = vm.createContext({
    location: { protocol }, fetch,
    document: { createElement: () => ({ remove() {} }), head: { append: (script) => append(script, context) } },
  });
  const loader = vm.runInContext(`${loaderSource}\nRadarData;`, context);
  const urls = plain(vm.runInContext("RADAR_URLS", context));
  return { context, loader, urls };
}

function initialData(urls) {
  return Object.fromEntries(Object.values(urls).map((url) => [url, url === urls.preferences ? index() : url === urls.manifest ? { data_version: "fixture-v1" } : []]));
}

test("file mode shares the small initial bundle and only loads the requested preference shard", async () => {
  const scripts = [];
  let data;
  const { context, loader, urls } = createLoader("file:", () => assert.fail("No file fetch"), (script, sandbox) => {
    scripts.push(script.src);
    queueMicrotask(() => {
      if (script.src.endsWith("local-data.js")) sandbox.__radarLocalData = data;
      else sandbox.__registerRadarPreference("journal-a", record("journal-a"));
      script.onload();
    });
  });
  data = initialData(urls);
  await Promise.all(Object.values(urls).map((url) => loader.load(url)));
  assert.deepEqual(scripts, ["data/radar/local-data.js"]);
  assert.equal(context.__radarLocalData, undefined);
  const [a, b] = await Promise.all([loader.loadPreference("journal-a"), loader.loadPreference("journal-a")]);
  assert.equal(a, b);
  assert.deepEqual(a, record("journal-a"));
  assert.deepEqual(scripts, ["data/radar/local-data.js", "data/radar/journal_preferences/journal-a.js"]);
  assert.equal(await loader.loadPreference("not-covered"), null);
});

test("HTTP mode shares fetches, versions shards, and never requests the monolithic preferences", async () => {
  const requests = [];
  const { loader, urls } = createLoader("https:", async (url, options) => {
    requests.push({ url, cache: options.cache });
    const data = url.includes("data-manifest") ? { data_version: "v 2" } : url.includes("_index") ? index() : record("journal-a");
    return { ok: true, json: async () => data };
  });
  await loader.load(urls.manifest);
  const [a, b] = await Promise.all([loader.loadPreference("journal-a"), loader.loadPreference("journal-a")]);
  assert.equal(a, b);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, "data/radar/journal_preferences/journal-a.json?v=v%202");
  assert.equal(requests[2].cache, "force-cache");
  assert.ok(requests.every(({ url }) => !url.includes("journal_preferences.json")));
});

test("HTTP 404 and mismatched journal records are retryable", async () => {
  for (const failure of ["missing", "wrong-journal"]) {
    let calls = 0;
    const { loader } = createLoader("https:", async (url) => {
      if (url.includes("_index")) return { ok: true, json: async () => index() };
      calls += 1;
      if (calls === 1 && failure === "missing") return { ok: false, status: 404 };
      return { ok: true, json: async () => record(calls === 1 ? "wrong" : "journal-a") };
    });
    await assert.rejects(loader.loadPreference("journal-a"), /HTTP 404|does not match/);
    assert.equal((await loader.loadPreference("journal-a")).journal_id, "journal-a");
    assert.equal(calls, 2);
  }
});

test("file shard failures can retry without reloading the initial bundle", async () => {
  let calls = 0;
  let data;
  const { loader, urls } = createLoader("file:", () => assert.fail("No fetch"), (script, sandbox) => queueMicrotask(() => {
    if (script.src.endsWith("local-data.js")) { sandbox.__radarLocalData = data; script.onload(); return; }
    calls += 1;
    if (calls === 1) script.onerror();
    else { sandbox.__registerRadarPreference("journal-a", record("journal-a")); script.onload(); }
  }));
  data = initialData(urls);
  await assert.rejects(loader.loadPreference("journal-a"), /unavailable/);
  assert.equal((await loader.loadPreference("journal-a")).journal_id, "journal-a");
  assert.equal(calls, 2);
});

test("untrusted index paths cannot read other files, URL hosts, encoded traversal or scripts", async () => {
  const paths = ["../.env", "journal_preferences/../config.json", "https://other.example/a.json", "//other.example/a.json", "journal_preferences/%2e%2e.json", "journal_preferences/a.json?q=1", "journal_preferences/a.js", "journal_preferences/a\\b.json"];
  for (const path of paths) {
    const { loader } = createLoader("https:", async (url) => {
      assert.ok(url.includes("_index"), "Unsafe shard must never be fetched");
      return { ok: true, json: async () => ({ journals: { a: { path } } }) };
    });
    await assert.rejects(loader.loadPreference("a"), /Unsafe preference data path/);
    await assert.rejects(loader.load(".env"), /Unknown radar data source/);
  }
});

test("incomplete initial file bundles reject and can be retried", async () => {
  let tries = 0;
  let data;
  const { loader, urls } = createLoader("file:", () => assert.fail("No fetch"), (script, sandbox) => queueMicrotask(() => {
    sandbox.__radarLocalData = tries++ === 0 ? {} : data;
    script.onload();
  }));
  data = initialData(urls);
  await assert.rejects(loader.load(urls.journals), /incomplete/);
  assert.deepEqual(await loader.load(urls.journals), []);
});

test("offline builder excludes full preference evidence from initial bundle and emits safe per-journal scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "radar-loader-"));
  try {
    const { urls } = createLoader("file:");
    await mkdir(join(root, "data/radar/journal_preferences"), { recursive: true });
    await writeFile(join(root, "data-loader.js"), loaderSource);
    const data = initialData(urls);
    for (const [url, value] of Object.entries(data)) await writeFile(join(root, url), JSON.stringify(value));
    for (const id of ["journal-a", "journal-b"]) await writeFile(join(root, `data/radar/journal_preferences/${id}.json`), JSON.stringify(record(id)));
    await buildLocalData({ projectRoot: root, quiet: true });
    const source = await readFile(join(root, "data/radar/local-data.js"), "utf8");
    const bundle = vm.runInNewContext(`${source}\nglobalThis.__radarLocalData;`);
    assert.deepEqual(plain(bundle), data);
    assert.ok(!source.includes("evidence"));
    const shard = await readFile(join(root, "data/radar/journal_preferences/journal-a.js"), "utf8");
    let loaded;
    vm.runInNewContext(shard, { __registerRadarPreference: (id, value) => { loaded = { id, value }; } });
    assert.deepEqual(plain(loaded), { id: "journal-a", value: record("journal-a") });
    assert.ok(!shard.includes("</script>"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generated project preview contains exactly the public summary datasets", async (t) => {
  const { urls } = createLoader("file:");
  try { await access(new URL(`../${urls.preferences}`, import.meta.url)); }
  catch { t.skip("Run build:static after the expanded dataset is generated"); return; }
  const source = await readFile(new URL("../data/radar/local-data.js", import.meta.url), "utf8");
  const bundle = vm.runInNewContext(`${source}\nglobalThis.__radarLocalData;`);
  assert.deepEqual(Object.keys(bundle).sort(), Object.values(urls).sort());
  for (const url of Object.values(urls)) {
    const original = JSON.parse(await readFile(new URL(`../${url}`, import.meta.url), "utf8"));
    assert.equal(JSON.stringify(bundle[url]), JSON.stringify(original), url);
  }
  const manifest = bundle[urls.manifest];
  assert.equal(bundle[urls.journals].length, manifest.journal_count);
  assert.ok(!Object.hasOwn(bundle, "data/radar/journal_preferences.json"));
});
