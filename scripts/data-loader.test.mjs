import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const loaderSource = await readFile(new URL("../data-loader.js", import.meta.url), "utf8");

function createLoader(protocol, fetch, append) {
  const context = vm.createContext({
    location: { protocol },
    fetch,
    document: {
      createElement: () => ({ remove() {} }),
      head: { append: (script) => append(script, context) },
    },
  });
  const loader = vm.runInContext(`${loaderSource}\nRadarData;`, context);
  const urls = Array.from(vm.runInContext("Object.values(RADAR_URLS)", context));
  return { context, loader, urls };
}

test("file URLs load one public bundle for concurrent requests without fetch", async () => {
  let scripts = 0;
  let data;
  const { context, loader, urls } = createLoader("file:", () => assert.fail("Local files must not use fetch"), (script, sandbox) => {
    scripts += 1;
    assert.equal(script.src, "data/radar/local-data.js");
    queueMicrotask(() => {
      sandbox.__radarLocalData = data;
      script.onload();
    });
  });
  data = Object.fromEntries(urls.map((url) => [url, { source: url }]));
  const results = await Promise.all(urls.map((url) => loader.load(url)));
  assert.deepEqual(results, Object.values(data));
  assert.equal(scripts, 1);
  assert.equal(context.__radarLocalData, undefined);
  assert.equal(await loader.load(urls[0]), data[urls[0]]);
});

test("HTTP requests use fresh JSON, not the offline snapshot", async () => {
  const { loader, urls } = createLoader("https:", async (url, options) => {
    assert.equal(options.cache, "no-store");
    return { ok: true, json: async () => ({ source: url }) };
  }, () => assert.fail("HTTP pages must not load the local bundle"));
  assert.deepEqual(await loader.load(urls[0]), { source: urls[0] });
});

test("missing or incomplete local data rejects instead of leaving loading pending", async () => {
  for (const failure of ["missing", "incomplete"]) {
    const { loader, urls } = createLoader("file:", () => assert.fail("No file fetch fallback"), (script, sandbox) => {
      queueMicrotask(() => {
        if (failure === "missing") script.onerror();
        else {
          sandbox.__radarLocalData = {};
          script.onload();
        }
      });
    });
    await assert.rejects(loader.load(urls[0]), /Local preview data/);
  }
});

test("HTTP errors and unknown data paths are rejected", async () => {
  const { loader, urls } = createLoader("https:", async () => ({ ok: false, status: 404 }));
  await assert.rejects(loader.load(urls[0]), /HTTP 404/);
  await assert.rejects(loader.load(".env"), /Unknown radar data source/);
});

test("generated preview contains exactly the seven public JSON datasets", async () => {
  const { urls } = createLoader("file:");
  const source = await readFile(new URL("../data/radar/local-data.js", import.meta.url), "utf8");
  const bundle = vm.runInNewContext(`${source}\nglobalThis.__radarLocalData;`);
  assert.deepEqual(Object.keys(bundle).sort(), [...urls].sort());
  for (const url of urls) {
    const original = JSON.parse(await readFile(new URL(`../${url}`, import.meta.url), "utf8"));
    assert.equal(JSON.stringify(bundle[url]), JSON.stringify(original), url);
  }
  assert.equal(bundle["data/radar/journals.json"].length, 268);
});
