// Poster rendering only: a stand-in for the chrome.* APIs so the real side panel runs in a normal page
// with sample data. ?scene=<name> picks the data from SCENES (scenes.js); ?view=<tab> opens a tab.
window.onerror = (msg) => { document.title = 'ERROR: ' + msg; };
window.addEventListener('unhandledrejection', (e) => { document.title = 'ERROR: ' + (e.reason && e.reason.message || e.reason); });
(() => {
  const params = new URLSearchParams(location.search);
  const sceneName = params.get('scene') || 'rec';
  const ok = (v) => Promise.resolve(v);
  const noop = () => {};
  window.chrome = {
    storage: {
      local: {
        get: (defaults) => ok({ ...(typeof defaults === 'object' && defaults ? defaults : {}), ...JSON.parse(JSON.stringify(SCENES[sceneName] || {})) }),
        set: () => ok(),
        remove: () => ok(),
      },
      onChanged: { addListener: noop },
    },
    runtime: {
      getManifest: () => ({ version: window.POSTER_VERSION || '5.9' }),
      sendMessage: () => ok({}),
      onMessage: { addListener: noop },
      lastError: null,
      getURL: (p) => p,
    },
    tabs: { query: () => ok([{ id: 1, url: 'https://shop.example.com/admin', title: 'Admin' }]), get: () => ok({ id: 1 }), onActivated: { addListener: noop }, onUpdated: { addListener: noop } },
    scripting: { executeScript: () => ok([]) },
    notifications: { create: noop, clear: noop },
  };
  // Open the requested tab once the panel has rendered.
  window.addEventListener('load', () => setTimeout(() => {
    const tab = { flows: 'tabFlows', rec: 'tabRec' }[params.get('view')];
    if (tab) document.getElementById(tab)?.click();
    if (params.get('open') === 'vars') document.getElementById('varsBox').open = true;
    document.documentElement.dataset.ready = '1';
  }, 300));
})();
