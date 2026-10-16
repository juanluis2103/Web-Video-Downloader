/*
 * Video Catcher - Popup
 * ----------------------
 * Reune los videos detectados por el background (red) y por el content
 * script (DOM), los combina y los muestra con botones de descarga.
 */

const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
document.getElementById('refresh').addEventListener('click', load);

let activeTabId = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

function sendToBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

function dedupe(videos) {
  const byUrl = new Map();
  for (const v of videos) {
    if (!v.url) continue;
    const prev = byUrl.get(v.url);
    // Preferimos la entrada con mas datos (quality, type concreto).
    if (!prev) byUrl.set(v.url, v);
    else byUrl.set(v.url, { ...prev, ...v, quality: v.quality || prev.quality });
  }
  return Array.from(byUrl.values());
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

async function load() {
  listEl.innerHTML = '';
  statusEl.textContent = 'Escaneando la pagina...';

  const tab = await getActiveTab();
  activeTabId = tab.id;

  const [dom, net] = await Promise.all([
    sendToTab(tab.id, { type: 'GET_DOM_VIDEOS' }),
    sendToBg({ type: 'GET_NETWORK_VIDEOS', tabId: tab.id })
  ]);

  const domVideos = (dom && dom.videos) || [];
  const netVideos = (net && net.videos) || [];
  const all = dedupe([...domVideos, ...netVideos]);

  // Orden: primero los que tienen calidad/DOM, luego streams, luego red.
  all.sort((a, b) => {
    const score = (v) => (v.source === 'dom' ? 0 : 1) + (v.isStream || v.isBlob ? 0.5 : 0);
    return score(a) - score(b);
  });

  render(all);
}

function render(videos) {
  if (!videos.length) {
    statusEl.textContent = '';
    listEl.innerHTML = `<div class="empty">
      No se detectaron videos todavia.<br><br>
      Reproduce o carga el video y pulsa &#x21BB; para volver a escanear.<br>
      Tambien puedes pasar el puntero sobre el video y usar el boton de descarga directo.
    </div>`;
    return;
  }

  statusEl.textContent = `${videos.length} video(s) detectado(s)`;

  videos.forEach((v, i) => {
    const li = document.createElement('li');
    li.className = 'item';

    const badges = [];
    if (v.type) badges.push(`<span class="badge type">${esc(v.type)}</span>`);
    if (v.quality) badges.push(`<span class="badge quality">${esc(v.quality)}</span>`);
    if (v.duration) badges.push(`<span class="badge">${fmtDuration(v.duration)}</span>`);
    if (v.size) badges.push(`<span class="badge">${fmtSize(v.size)}</span>`);
    if (v.source === 'network') badges.push(`<span class="badge net">red</span>`);
    if (v.isStream || v.isBlob) badges.push(`<span class="badge stream">stream</span>`);

    const streamNote = (v.isStream || v.isBlob)
      ? `<div class="note">&#9888; Es un stream (HLS/DASH/MSE). La descarga directa puede no funcionar; necesitaras una herramienta como yt-dlp/ffmpeg con esta URL.</div>`
      : '';

    li.innerHTML = `
      <div class="item-top">
        <div class="item-name" data-i="${i}" title="Click para resaltar el video en la pagina">${esc(v.name || v.url)}</div>
      </div>
      <div class="badges">${badges.join('')}</div>
      ${streamNote}
      <div class="item-actions">
        <button class="dl" data-dl="${i}">&#x2B07; Descargar</button>
        <button class="dl secondary" data-copy="${i}" title="Copiar URL">&#x1F517;</button>
      </div>
    `;
    listEl.appendChild(li);

    li.querySelector(`[data-dl="${i}"]`).addEventListener('click', () => downloadVideo(v));
    li.querySelector(`[data-copy="${i}"]`).addEventListener('click', () => {
      navigator.clipboard.writeText(v.url);
      flash(statusEl, 'URL copiada al portapapeles');
    });
    const nameEl = li.querySelector(`[data-i="${i}"]`);
    if (v.source === 'dom') {
      nameEl.addEventListener('click', () =>
        sendToTab(activeTabId, { type: 'HIGHLIGHT', index: i })
      );
    }
  });
}

async function downloadVideo(v) {
  // Si es un blob/DOM, dejamos que el content script lo maneje (fetch del blob).
  if (v.isBlob || (v.source === 'dom' && v.url.startsWith('blob:'))) {
    await sendToTab(activeTabId, { type: 'DOWNLOAD_DOM', info: v });
    flash(statusEl, 'Iniciando descarga...');
    return;
  }
  const filename = safeName(v);
  const res = await sendToBg({ type: 'DOWNLOAD', url: v.url, filename, saveAs: true });
  if (res && res.ok) flash(statusEl, 'Descarga iniciada');
  else flash(statusEl, 'Error: ' + ((res && res.error) || 'no se pudo iniciar'), true);
}

function safeName(v) {
  let base = (v.name || 'video').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  if (!/\.\w{2,4}$/.test(base)) base += '.mp4';
  return base;
}

function fmtDuration(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

let flashTimer;
function flash(el, text, isError) {
  el.textContent = text;
  el.style.color = isError ? '#ff7a7a' : '#9ff0a8';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.style.color = '';
    el.textContent = '';
    load();
  }, 1800);
}

load();
