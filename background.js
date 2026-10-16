/*
 * Video Catcher - Service Worker (background)
 * --------------------------------------------
 * Escucha el trafico de red de cada pestana y captura las peticiones que
 * parecen ser video (por extension de archivo o por cabecera Content-Type).
 * Guarda los resultados por tabId para que el popup los pueda consultar.
 */

// Mapa: tabId -> Map(url -> infoDelVideo)
const detectedByTab = new Map();

// Extensiones / patrones que consideramos "media descargable".
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv|avi|flv|3gp|ts|m3u8|mpd)(\?|#|$)/i;

// Content-Types que nos interesan.
const VIDEO_CT = /(^video\/)|(application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|octet-stream))|(audio\/(mp4|aac|mpeg))/i;

// URLs a ignorar (ruido).
const IGNORE = /\.(jpg|jpeg|png|gif|webp|svg|css|js|json|woff2?|ttf|ico)(\?|#|$)/i;

function tabMap(tabId) {
  if (!detectedByTab.has(tabId)) detectedByTab.set(tabId, new Map());
  return detectedByTab.get(tabId);
}

function guessType(url, contentType) {
  const m = url.match(VIDEO_EXT);
  if (m) {
    const ext = m[1].toLowerCase();
    if (ext === 'm3u8') return 'HLS (m3u8)';
    if (ext === 'mpd') return 'DASH (mpd)';
    if (ext === 'ts') return 'segmento TS';
    return ext.toUpperCase();
  }
  if (contentType) {
    if (/mpegurl/i.test(contentType)) return 'HLS (m3u8)';
    if (/dash/i.test(contentType)) return 'DASH (mpd)';
    const ct = contentType.split(';')[0].split('/')[1];
    if (ct) return ct.toUpperCase();
  }
  return 'video';
}

function shortName(url) {
  try {
    const u = new URL(url);
    let name = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (!name || name.length > 60) name = (u.hostname + u.pathname).slice(-60);
    return name || u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

function addCandidate(tabId, url, { contentType, size, fromHeaders } = {}) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
  if (IGNORE.test(url)) return;

  const looksVideoUrl = VIDEO_EXT.test(url);
  const looksVideoCt = contentType && VIDEO_CT.test(contentType);
  if (!looksVideoUrl && !looksVideoCt) return;

  const map = tabMap(tabId);
  const existing = map.get(url) || {};
  const info = {
    url,
    name: shortName(url),
    type: guessType(url, contentType),
    contentType: contentType || existing.contentType || '',
    size: size != null ? size : existing.size,
    source: 'network',
    isStream: /m3u8|mpd/i.test(url) || (contentType && /mpegurl|dash/i.test(contentType)),
    ts: Date.now()
  };
  map.set(url, info);
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const map = detectedByTab.get(tabId);
  const count = map ? map.size : 0;
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#e23b3b' }).catch(() => {});
}

// --- Captura de peticiones ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    addCandidate(details.tabId, details.url, {});
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    let contentType = '';
    let size = null;
    for (const h of details.responseHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = h.value || '';
      if (name === 'content-length') size = parseInt(h.value, 10) || null;
    }
    addCandidate(details.tabId, details.url, { contentType, size, fromHeaders: true });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Limpia al navegar a una pagina nueva (no en navegaciones internas/subframes).
chrome.webNavigation?.onCommitted?.addListener?.((d) => {
  if (d.frameId === 0) {
    detectedByTab.delete(d.tabId);
    updateBadge(d.tabId);
  }
});

// Alternativa: limpiar cuando el frame principal carga.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    detectedByTab.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => detectedByTab.delete(tabId));

// --- Mensajeria con popup / content script ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_NETWORK_VIDEOS') {
    const tabId = msg.tabId;
    const map = detectedByTab.get(tabId);
    sendResponse({ videos: map ? Array.from(map.values()) : [] });
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, saveAs: msg.saveAs !== false },
      (id) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, id });
        }
      }
    );
    return true; // respuesta asincrona
  }

  if (msg.type === 'CONTENT_FOUND' && sender.tab) {
    // El content script encontro videos en el DOM (no via red). Los anadimos.
    const map = tabMap(sender.tab.id);
    for (const v of msg.videos || []) {
      if (!v.url) continue;
      const prev = map.get(v.url) || {};
      map.set(v.url, { ...prev, ...v, source: v.source || 'dom' });
    }
    updateBadge(sender.tab.id);
    sendResponse({ ok: true });
    return true;
  }
});
