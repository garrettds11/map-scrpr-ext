// Runs in the PAGE's JS world on enabled sites. Wraps fetch/XHR and forwards JSON-looking responses to bridge.js.
// It adds NO requests of its own. What is kept (or discarded) is decided later in the background worker
// (site registry / generic point sniffer), so adding a site never requires editing this file.
(() => {
  if (window.__mapScrprHooked) return;
  window.__mapScrprHooked = true;

  // Trackers/ads/consent/analytics never carry map data; skip them before touching the response.
  const DENY = /(google-analytics|googletagmanager|doubleclick|googlesyndication|clarity\.ms|hotjar|facebook\.(com|net)|fbcdn|segment\.(io|com)|mixpanel|sentry\.io|newrelic|nr-data|datadoghq|optimizely|visualwebsiteoptimizer|trustarc|onetrust|cookielaw|mountain\.com|impactcdn|ssqt\.io|scarabresearch|emarsys|adsystem|taboola|criteo|linkedin\.com\/px|tiktok|pinterest|bat\.bing|twitter\.com\/i\/|stats\.g\.)/i;
  const STATIC = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|ico|map|mp4|webm|pbf|mvt)(\?|#|$)/i;
  const MAX_CHARS = 32_000_000;   // Chrome extension messaging tops out near 64 MB; stay well under
  const absolute = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };
  const worthLooking = (u) => !DENY.test(u) && !STATIC.test(u);
  const jsonCT = (ct) => !ct || /json|javascript|text\/plain/i.test(ct);
  const jsonish = (t) => typeof t === 'string' && /^\s*[\[{]/.test(t);

  const serializeBody = (b) => {
    try {
      if (b == null) return null;
      if (typeof b === 'string') return b;
      if (typeof FormData !== 'undefined' && b instanceof FormData) {
        const o = {};
        for (const [k, v] of b.entries()) if (typeof v === 'string') o[k] = v;
        return JSON.stringify(o);
      }
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
    } catch {}
    return null;
  };

  const send = (payload) => {
    try {
      if (payload.body.length > MAX_CHARS) payload = { ...payload, oversize: payload.body.length, body: null };
      window.postMessage({ __mapScrpr: true, ...payload }, window.location.origin);
    } catch {}
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = absolute(typeof input === 'string' ? input : (input && input.url) || input);
        if (worthLooking(url)) {
          const method = (init && init.method) || (input && input.method) || 'GET';
          const reqBody = serializeBody(init && init.body);
          p.then((res) => {
            if (!jsonCT(res.headers && res.headers.get && res.headers.get('content-type'))) return;
            res.clone().text().then((body) => { if (jsonish(body)) send({ url, method, reqBody, status: res.status, body }); }).catch(() => {});
          }).catch(() => {});
        }
      } catch {}
      return p;
    };
  }

  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const origOpen = XHR.open, origSend = XHR.send;
    XHR.open = function (method, url) {
      try { this.__ms = { method, url: absolute(url) }; } catch {}
      return origOpen.apply(this, arguments);
    };
    XHR.send = function (body) {
      try {
        const ms = this.__ms;
        if (ms && worthLooking(ms.url)) {
          const reqBody = serializeBody(body);
          this.addEventListener('load', () => {
            try {
              if (!jsonCT(this.getResponseHeader && this.getResponseHeader('content-type'))) return;
              const t = this.responseType;
              const text = t === '' || t === 'text' ? this.responseText : t === 'json' ? JSON.stringify(this.response) : null;
              if (jsonish(text)) send({ url: ms.url, method: ms.method, reqBody, status: this.status, body: text });
            } catch {}
          });
        }
      } catch {}
      return origSend.apply(this, arguments);
    };
  }
})();
