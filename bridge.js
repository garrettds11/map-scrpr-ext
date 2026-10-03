// ISOLATED world: relays messages posted by hook.js to the extension background.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__mapScrpr !== true) return;
  const { __mapScrpr, ...payload } = e.data;
  try {
    chrome.runtime.sendMessage({ type: 'capture', page: location.href, ...payload });
  } catch { /* extension reloaded; page needs a refresh */ }
});
