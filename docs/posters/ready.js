// Poster pages: mark the page ready (data-ready="1") once fonts and every embedded panel have loaded,
// and surface a panel error in this page's title so scripts/posters.sh fails instead of shipping an empty panel.
window.onerror = (msg) => { document.title = 'ERROR: ' + msg; };
(async () => {
  await document.fonts.ready;
  if (![...document.fonts].some((f) => f.family.includes('Inter Tight') && f.status === 'loaded')) {
    document.title = 'ERROR: poster fonts did not load (network?)';
  }
  const frames = [...document.querySelectorAll('iframe')];
  await Promise.all(frames.map((f) => new Promise((res) => {
    const check = () => {
      let d = null;
      try { d = f.contentDocument; } catch { /* opaque origin */ }
      // A panel we cannot look into could be broken: fail instead of shipping it unchecked.
      if (!d) { document.title = 'ERROR: cannot read panel frame (run Chrome with --allow-file-access-from-files)'; return res(); }
      if (d.title.startsWith('ERROR:')) { document.title = 'ERROR in panel: ' + d.title; return res(); }
      if (d.documentElement.dataset.ready === '1') return res();
      setTimeout(check, 100);
    };
    check();
  })));
  document.documentElement.dataset.ready = '1';
})();
