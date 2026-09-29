const RADAR_URLS = Object.freeze({
  journals: "data/radar/journals.json",
  sources: "data/radar/journal_sources.json",
  network: "data/radar/research_network.json",
  report: "data/radar/crawl_report.json",
  config: "data/radar/radar-config.json",
  preferences: "data/radar/journal_preferences_index.json",
  editorProfiles: "data/radar/editor_profiles.json",
  manifest: "data/radar/data-manifest.json",
});

// Shared by the browser and offline builder: no host, traversal, query or executable URL.
function radarPreferencePath(path) {
  if (typeof path !== "string" || !/^journal_preferences\/[\p{L}\p{N}_-]+\.json$/u.test(path)) {
    throw new Error("Unsafe preference data path");
  }
  return `data/radar/${path}`;
}

const RadarData = (() => {
  let localDataPromise;
  let dataVersion = "";
  const datasets = new Map();
  const preferences = new Map();
  const localPreferenceRequests = new Map();

  function loadLocalData() {
    if (!localDataPromise) {
      localDataPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "data/radar/local-data.js";
        script.onload = () => {
          const data = globalThis.__radarLocalData;
          delete globalThis.__radarLocalData;
          script.remove();
          if (data && Object.values(RADAR_URLS).every((url) => Object.hasOwn(data, url))) resolve(data);
          else reject(new Error("Local preview data is incomplete"));
        };
        script.onerror = () => {
          script.remove();
          reject(new Error("Local preview data is unavailable"));
        };
        document.head.append(script);
      }).catch((error) => {
        localDataPromise = undefined;
        throw error;
      });
    }
    return localDataPromise;
  }

  globalThis.__registerRadarPreference = (id, record) => {
    const pending = localPreferenceRequests.get(id);
    if (pending) pending.record = record;
  };

  function validatePreference(id, record) {
    if (!record || typeof record !== "object" || record.journal_id !== id) {
      throw new Error("Preference journal does not match the requested journal");
    }
    return record;
  }

  function loadLocalPreference(id, url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const pending = {};
      localPreferenceRequests.set(id, pending);
      script.src = url.replace(/\.json$/, ".js");
      const cleanup = () => {
        script.remove();
        localPreferenceRequests.delete(id);
      };
      script.onload = () => {
        cleanup();
        try { resolve(validatePreference(id, pending.record)); }
        catch (error) { reject(error); }
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("Local preference data is unavailable"));
      };
      document.head.append(script);
    });
  }

  async function load(url) {
    if (!Object.values(RADAR_URLS).includes(url)) throw new Error("Unknown radar data source");
    if (!datasets.has(url)) {
      const pending = (async () => {
        let data;
        if (location.protocol === "file:") data = (await loadLocalData())[url];
        else {
          const version = dataVersion && url !== RADAR_URLS.manifest ? `?v=${encodeURIComponent(dataVersion)}` : "";
          const response = await fetch(`${url}${version}`, { cache: "no-store" });
          if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
          data = await response.json();
        }
        if (url === RADAR_URLS.manifest) dataVersion = String(data?.data_version || "");
        return data;
      })().catch((error) => {
        datasets.delete(url);
        throw error;
      });
      datasets.set(url, pending);
    }
    return datasets.get(url);
  }

  async function loadPreference(id) {
    if (!preferences.has(id)) {
      const pending = (async () => {
        const index = await load(RADAR_URLS.preferences);
        const entry = Object.hasOwn(index?.journals || {}, id) ? index.journals[id] : null;
        if (!entry) return null;
        const url = radarPreferencePath(entry.path);
        if (location.protocol === "file:") return loadLocalPreference(id, url);
        const version = dataVersion ? `?v=${encodeURIComponent(dataVersion)}` : "";
        const response = await fetch(`${url}${version}`, { cache: dataVersion ? "force-cache" : "no-store" });
        if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
        return validatePreference(id, await response.json());
      })().catch((error) => {
        preferences.delete(id);
        throw error;
      });
      preferences.set(id, pending);
    }
    return preferences.get(id);
  }

  return { isLocalFile: location.protocol === "file:", load, loadPreference };
})();
