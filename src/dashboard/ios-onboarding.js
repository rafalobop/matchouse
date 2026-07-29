// KAN-47: deteccion de iOS + PWA no instalada, extraida a un archivo aparte (en vez de vivir
// inline en app.js) para poder testear la logica pura con node:test sin necesitar un DOM real -
// app.js si depende de document.getElementById de punta a punta y no se puede cargar en Node.
// Se expone como <script> clasico (window.MatchouseIosOnboarding) y como CommonJS (module.exports)
// para que el mismo archivo sirva tal cual al browser y a los tests.
(function (root) {
  function isIosDevice(nav) {
    nav = nav || (typeof navigator !== 'undefined' ? navigator : {});
    const ua = nav.userAgent || '';
    const isClassicIos = /iPad|iPhone|iPod/.test(ua);
    // iPadOS 13+ reporta un userAgent de Safari de escritorio (se hace pasar por Mac) - se
    // distingue de un Mac real porque soporta touch (maxTouchPoints > 1).
    const isIpadOsDesktopUa = nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1;
    return isClassicIos || isIpadOsDesktopUa;
  }

  function isRunningAsInstalledPwa(nav, win) {
    nav = nav || (typeof navigator !== 'undefined' ? navigator : {});
    win = win || (typeof window !== 'undefined' ? window : {});
    const standaloneFlag = nav.standalone === true;
    const matchesDisplayMode = typeof win.matchMedia === 'function' && !!win.matchMedia('(display-mode: standalone)').matches;
    return standaloneFlag || matchesDisplayMode;
  }

  function shouldShowIosInstallOnboarding(nav, win) {
    return isIosDevice(nav) && !isRunningAsInstalledPwa(nav, win);
  }

  const api = { isIosDevice, isRunningAsInstalledPwa, shouldShowIosInstallOnboarding };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MatchouseIosOnboarding = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
