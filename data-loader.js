const RADAR_URLS = Object.freeze({
  journals: "data/radar/journals.json",
  sources: "data/radar/journal_sources.json",
  network: "data/radar/research_network.json",
  report: "data/radar/crawl_report.json",
  config: "data/radar/radar-config.json",
  preferences: "data/radar/journal_preferences.json",
  editorProfiles: "data/radar/editor_profiles.json",
});

const RadarData = (() => {
  let localDataPromise;

  function loadLocalData() {
    if (!localDataPromise) {
      // Classic scripts can load adjacent files without file:// fetch permissions.
      localDataPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "data/radar/local-data.js";
        script.onload = () => {
          const data = globalThis.__radarLocalData;
          delete globalThis.__radarLocalData;
          script.remove();
          if (data && Object.values(RADAR_URLS).every((url) => Object.hasOwn(data, url))) {
            resolve(data);
          } else {
            reject(new Error("Local preview data is incomplete"));
          }
        };
        script.onerror = () => {
          script.remove();
          reject(new Error("Local preview data is unavailable"));
        };
        document.head.append(script);
      });
    }
    return localDataPromise;
  }

  return {
    isLocalFile: location.protocol === "file:",
    async load(url) {
      if (!Object.values(RADAR_URLS).includes(url)) throw new Error("Unknown radar data source");
      if (location.protocol === "file:") return (await loadLocalData())[url];
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
      return response.json();
    },
  };
})();
