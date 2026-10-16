/*
 * Video Catcher - Content Script
 * --------------------------------
 * 1. Escanea el DOM en busca de elementos <video> y sus fuentes.
 * 2. Muestra un boton de descarga flotante al pasar el puntero sobre un video.
 * 3. Responde al popup cuando pide la lista de videos del DOM.
 */
(() => {
  if (window.__videoCatcherLoaded) return;
  window.__videoCatcherLoaded = true;

  const seen = new WeakMap(); // video element -> id
  let counter = 0;

  function collectSources(video) {
    const urls = new Set();
    if (video.currentSrc) urls.add(video.currentSrc);
    if (video.src) urls.add(video.src);
    video.querySelectorAll('source').forEach((s) => {
      if (s.src) urls.add(s.src);
    });
    return Array.from(urls).filter(Boolean);
  }

  function describeVideo(video) {
    const urls = collectSources(video);
    const primary = video.currentSrc || urls[0] || '';
    const isBlob = primary.startsWith('blob:');
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    return {
      url: primary,
      allUrls: urls,
      name: filenameFromUrl(primary) || 'video',
      type: isBlob ? 'stream (blob/MSE)' : (extOf(primary) || 'video'),
      width: w,
      height: h,
      quality: w && h ? `${w}x${h}` : '',
      duration: isFinite(video.duration) ? Math.round(video.duration) : 0,
      isBlob,
      source: 'dom'
    };
  }

  function extOf(url) {
    const m = (url || '').match(/\.(mp4|webm|ogg|ogv|mov|m4v|mkv|avi|flv|m3u8|mpd)(\?|#|$)/i);
    return m ? m[1].toUpperCase() : '';
  }

  function filenameFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      let n = decodeURIComponent(u.pathname.split('/').pop() || '');
      return n;
    } catch {
      return '';
    }
  }

  function safeName(info) {
    let base = filenameFromUrl(info.url) || (document.title || 'video');
    base = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    if (!/\.\w{2,4}$/.test(base)) {
      const ext = info.isBlob ? 'mp4' : (extOf(info.url).toLowerCase() || 'mp4');
      base += '.' + ext;
    }
    return base;
  }

  // --- Descarga ---
  async function downloadVideo(info) {
    const filename = safeName(info);

    // Para blobs (MediaSource normalmente no es descargable, pero blobs reales si):
    if (info.url && info.url.startsWith('blob:')) {
      try {
        const resp = await fetch(info.url);
        const blob = await resp.blob();
        const objUrl = URL.createObjectURL(blob);
        triggerAnchorDownload(objUrl, filename);
        setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
        toast('Descargando: ' + filename);
        return;
      } catch (e) {
        toast('No se pudo descargar el stream directamente (probablemente MSE/HLS). Revisa el popup para la fuente real.', true);
        return;
      }
    }

    // URL normal -> usar el gestor de descargas via background.
    chrome.runtime.sendMessage(
      { type: 'DOWNLOAD', url: info.url, filename, saveAs: true },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          // fallback: anchor directo
          triggerAnchorDownload(info.url, filename);
        }
        toast('Descargando: ' + filename);
      }
    );
  }

  function triggerAnchorDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // --- Overlay (boton flotante sobre el video) ---
  const btn = document.createElement('div');
  btn.className = 'vc-download-btn';
  btn.innerHTML = '&#x2B07; Descargar';
  btn.style.display = 'none';
  let currentVideo = null;

  function mountBtn() {
    if (!btn.isConnected && document.body) document.body.appendChild(btn);
  }

  function positionBtn(video) {
    const r = video.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) {
      btn.style.display = 'none';
      return;
    }
    mountBtn();
    btn.style.display = 'flex';
    btn.style.top = (window.scrollY + r.top + 10) + 'px';
    btn.style.left = (window.scrollX + r.left + 10) + 'px';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (currentVideo) downloadVideo(describeVideo(currentVideo));
  });

  // Mostrar boton al pasar el puntero sobre cualquier <video>.
  document.addEventListener('mouseover', (e) => {
    const v = e.target instanceof HTMLVideoElement ? e.target : null;
    if (v) {
      currentVideo = v;
      positionBtn(v);
    }
  }, true);

  document.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget;
    if (to === btn || (to && to.closest && to.closest('.vc-download-btn'))) return;
    if (e.target instanceof HTMLVideoElement) {
      setTimeout(() => {
        // Ocultar solo si el puntero no esta sobre el boton.
        if (!btn.matches(':hover')) btn.style.display = 'none';
      }, 150);
    }
  }, true);

  window.addEventListener('scroll', () => {
    if (currentVideo && btn.style.display !== 'none') positionBtn(currentVideo);
  }, true);

  // --- Escaneo periodico del DOM y aviso al background ---
  function scanAndReport() {
    const videos = Array.from(document.querySelectorAll('video'))
      .map(describeVideo)
      .filter((v) => v.url);
    if (videos.length) {
      chrome.runtime.sendMessage({ type: 'CONTENT_FOUND', videos }, () => void chrome.runtime.lastError);
    }
    return videos;
  }

  // Observa cambios del DOM (LLMs que insertan videos dinamicamente).
  const mo = new MutationObserver(() => {
    clearTimeout(mo._t);
    mo._t = setTimeout(scanAndReport, 500);
  });
  if (document.body) mo.observe(document.body, { childList: true, subtree: true });

  setInterval(scanAndReport, 3000);
  scanAndReport();

  // --- Responder al popup ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_DOM_VIDEOS') {
      sendResponse({ videos: scanAndReport() });
      return true;
    }
    if (msg.type === 'DOWNLOAD_DOM') {
      downloadVideo(msg.info);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'HIGHLIGHT') {
      const vids = document.querySelectorAll('video');
      const v = vids[msg.index];
      if (v) {
        v.scrollIntoView({ behavior: 'smooth', block: 'center' });
        v.classList.add('vc-flash');
        setTimeout(() => v.classList.remove('vc-flash'), 1500);
      }
      sendResponse({ ok: true });
      return true;
    }
  });

  // --- Toast simple ---
  function toast(text, isError) {
    const t = document.createElement('div');
    t.className = 'vc-toast' + (isError ? ' vc-toast-error' : '');
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('vc-show'));
    setTimeout(() => {
      t.classList.remove('vc-show');
      setTimeout(() => t.remove(), 400);
    }, isError ? 5000 : 2500);
  }
})();
