const $ = (sel, el = document) => el.querySelector(sel);

const form = $('#form');
const input = $('#url');
const goBtn = $('#go');
const statusEl = $('#status');
const resultEl = $('#result');
const fileInput = $('#file');
const dropzone = $('#convert');
const HISTORY_KEY = 'gifpocket:history';
const MAX_RECENT = 12; // unpinned items kept; pinned ones are always kept
const MAX_SECONDS = 120; // must match MAX_SECONDS on the server
const MAX_UPLOAD = 100 * 1024 * 1024;
const KB = 1024;
const MB = 1024 * 1024;

const PRESETS = {
  standard: { label: 'Standard GIF (max 5 MB)', format: 'gif', fit: 'none', width: 0, maxBytes: 5 * MB },
  webp: { label: 'Sharper WebP (max 5 MB)', format: 'webp', fit: 'none', width: 0, maxBytes: 5 * MB },
  discord: { label: 'Discord (max 10 MB)', format: 'gif', fit: 'none', width: 0, maxBytes: 10 * MB },
  emoji: { label: 'Discord emoji (128px, 256 KB)', format: 'gif', fit: 'square', width: 128, maxBytes: 256 * KB },
  sticker: { label: 'WhatsApp / Telegram sticker (512×512)', format: 'webp', fit: 'sticker', width: 0, maxBytes: 500 * 1000 },
  big: { label: 'Re-post on X / Telegram (max 15 MB)', format: 'gif', fit: 'none', width: 0, maxBytes: 15 * MB },
};

// ---------- helpers ----------
const mediaUrl = (src, dl, name) =>
  `/api/media?src=${encodeURIComponent(src)}${dl ? `&dl=1&name=${encodeURIComponent(name)}` : ''}`;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${+(n / MB).toFixed(1)} MB`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const looksLikeTweet = (s) => /(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com\/.+\/status(?:es)?\/\d+/i.test(s);
function make(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1400);
}

// ---------- tweet lookup ----------
async function load(url) {
  url = url.trim();
  if (!url) return;
  resetResult();
  input.value = url;
  clearBtn.hidden = false;
  goBtn.disabled = true;
  setStatus('Looking up tweet…');
  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).catch(() => {
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    renderTweet(data);
    setStatus(`Found ${data.media.length} ${data.media.length === 1 ? 'item' : 'items'}.`);
    addHistory(url, data);
    history.replaceState(null, '', `?${new URLSearchParams({ url })}`);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    goBtn.disabled = false;
  }
}

function showResult(card) {
  resultEl.replaceChildren(card);
  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTweet(data) {
  const card = $('#tpl-result').content.firstElementChild.cloneNode(true);
  const avatar = $('.avatar', card);
  if (data.author.avatar) avatar.src = data.author.avatar;
  else avatar.remove();
  $('.name', card).textContent = data.author.name;
  const handle = $('.handle', card);
  handle.textContent = data.author.handle ? `@${data.author.handle}` : 'View tweet';
  handle.href = data.url;
  $('.text', card).textContent = data.text;
  const list = $('.media-list', card);
  for (const m of data.media) {
    const base = `${data.author.handle || 'tweet'}_${data.id}${data.media.length > 1 ? `_${m.index + 1}` : ''}`;
    list.append(renderMedia(m, base));
  }
  showResult(card);
}

/**
 * One media item: preview + download buttons + Customize panel.
 * `m.local` (an object URL) marks a file the user uploaded: it has no MP4/link buttons.
 */
function renderMedia(m, base) {
  const node = $('#tpl-media').content.firstElementChild.cloneNode(true);
  const preview = $('.preview', node);
  const quality = $('.quality', node);
  const dl = $('.download', node);
  const isVideo = m.type !== 'photo';

  $('.badge', node).textContent = m.local ? (m.type === 'gif' ? 'Your GIF' : 'Your video') : m.type === 'gif' ? 'GIF' : m.type;

  let video = null;
  if (m.local && m.type === 'gif') {
    preview.append(make('img', { src: m.local, alt: 'Your GIF' })); // <video> can't play GIFs
  } else if (isVideo) {
    video = make('video', { controls: true, playsInline: true, preload: 'metadata' });
    if (m.thumbnail) video.poster = mediaUrl(m.thumbnail);
    if (m.type === 'gif' || m.local) Object.assign(video, { autoplay: true, loop: true, muted: true });
    if (m.local) video.src = m.local;
    preview.append(video);
  } else {
    preview.append(make('img', { src: mediaUrl(m.variants[0].url), alt: 'Tweet image' }));
  }

  if (m.local) {
    $('.quality-wrap', node).hidden = true;
    dl.remove();
    $('.copy', node).remove();
  } else {
    m.variants.forEach((v, i) => quality.add(new Option(v.label + (i === 0 ? ' (best)' : ''), String(i))));
    if (m.variants.length < 2) $('.quality-wrap', node).hidden = true;
    const current = () => m.variants[Number(quality.value) || 0];
    const update = () => {
      const v = current();
      dl.href = mediaUrl(v.url, true, `${base}.${isVideo ? 'mp4' : 'jpg'}`);
      if (video) {
        const t = video.currentTime;
        video.src = mediaUrl(v.url);
        if (t) video.currentTime = t;
      }
    };
    quality.addEventListener('change', update);
    update();
    $('.copy', node).addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(current().url);
        flash(e.currentTarget, 'Copied!');
      } catch {
        flash(e.currentTarget, 'Copy failed');
      }
    });
  }

  if (isVideo) setupConvert(node, m, video, base);
  else {
    // Photos: the image download becomes the main button.
    for (const sel of ['.gif-panel', '.dl-gif', '.gif-note', '.dl-webp']) $(sel, node).remove();
    dl.textContent = 'Download image';
    dl.classList.replace('ghost', 'primary');
  }
  return node;
}

// ---------- conversion ----------

/** Converts on the server (reusing earlier results). Returns { id, bytes, width, fps, format, maxBytes, reduced, url }. */
async function convert(settings) {
  let res;
  try {
    res = await fetch('/api/gif', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Conversion failed.');
  return data;
}

/** Starts a real browser download from a normal URL (works everywhere, unlike blob: links). */
function saveUrl(url, filename) {
  const a = make('a', { href: `${url}?dl=1&name=${encodeURIComponent(filename)}`, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

/** "4.3 MB · 285px · 8 fps (resized to fit 5 MB)" */
function describe(r, custom = false) {
  const parts = [fmtBytes(r.bytes), r.width && `${r.width}px`, r.fps && `${Math.round(r.fps)} fps`].filter(Boolean);
  const why = r.reduced ? `resized to fit ${fmtBytes(r.maxBytes)}` : custom ? `under ${fmtBytes(r.maxBytes)}` : 'original quality';
  return `${parts.join(' · ')} (${why}).`;
}

/** One-click settings: full length, original size and frame rate, default 5 MB cap. */
const oneClickSettings = (src, format) => ({ src, format, width: 0, fps: 0, start: 0 });

/**
 * Picks the smallest source that is still at least `width` wide, so conversion stays fast.
 * width 0 means "original size", which always uses the best-quality source.
 */
function sourceFor(m, width) {
  if (!width) return m.variants[0];
  return [...m.variants].reverse().find((v) => (v.width ?? 0) >= width) ?? m.variants[0];
}

function setupConvert(node, m, video, base) {
  const q = (sel) => $(sel, node);
  const start = q('.g-start');
  const end = q('.g-end');
  const status = q('.g-status');
  const out = q('.g-out');
  const note = q('.gif-note');
  let lastUrl;

  const setNote = (text, kind = '') => {
    note.textContent = text;
    note.className = `gif-note ${kind}`;
  };

  // Trim defaults
  let dur = m.durationMs ? m.durationMs / 1000 : null;
  const fillEnd = () => {
    if (dur && !end.value) end.value = Math.min(dur, MAX_SECONDS).toFixed(1);
    if (dur > MAX_SECONDS) setNote(`This clip is ${Math.round(dur)}s long, so it will use the first ${MAX_SECONDS / 60} minutes (pick a part in Customize).`);
  };
  fillEnd();
  if (video) {
    video.addEventListener('loadedmetadata', () => {
      if (!dur && Number.isFinite(video.duration)) {
        dur = video.duration;
        fillEnd();
      }
    });
    q('.set-start').addEventListener('click', () => (start.value = video.currentTime.toFixed(1)));
    q('.set-end').addEventListener('click', () => (end.value = video.currentTime.toFixed(1)));
  } else {
    q('.set-start').remove();
    q('.set-end').remove();
  }

  // ---- One click: GIF (main) or WebP ----
  const quick = async (btn, format) => {
    const label = btn.textContent;
    const ext = format === 'webp' ? 'WebP' : 'GIF';
    btn.disabled = true;
    btn.textContent = btn.classList.contains('big') ? `Making your ${ext}…` : '…';
    setNote(`Making your ${ext} (max 5 MB). Longer clips take a bit longer.`);
    try {
      const r = await convert(oneClickSettings(m.variants[0].url, format));
      const filename = `${base}.${format}`;
      saveUrl(r.url, filename);
      setNote(`Downloaded ${filename}: ${describe(r)}`, 'ok');
    } catch (e) {
      setNote(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  q('.dl-gif').addEventListener('click', (e) => quick(e.currentTarget, 'gif'));
  q('.dl-webp').addEventListener('click', (e) => quick(e.currentTarget, 'webp'));

  // ---- Customize & presets ----
  const preset = q('.g-preset');
  for (const [key, p] of Object.entries(PRESETS)) preset.add(new Option(p.label, key));
  preset.add(new Option('Custom', 'custom'));
  const fields = { format: q('.g-format'), maxBytes: q('.g-max'), fit: q('.g-fit'), width: q('.g-width') };
  const applyPreset = () => {
    const p = PRESETS[preset.value];
    if (!p) return;
    for (const [k, f] of Object.entries(fields)) f.value = String(p[k]);
    // 500 KB sticker limit is 512000, which is in the list; anything else falls back gracefully.
    if (!fields.maxBytes.value) fields.maxBytes.value = String(5 * MB);
  };
  preset.addEventListener('change', applyPreset);
  for (const f of Object.values(fields)) f.addEventListener('change', () => (preset.value = 'custom'));
  applyPreset();

  q('.make-gif').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const width = Number(fields.width.value);
    const format = fields.format.value;
    btn.disabled = true;
    status.classList.remove('error');
    status.textContent = 'Converting. This usually takes a few seconds.';
    try {
      const r = await convert({
        src: sourceFor(m, width).url,
        format,
        fit: fields.fit.value,
        maxBytes: Number(fields.maxBytes.value),
        width,
        fps: Number(q('.g-fps').value),
        speed: Number(q('.g-speed').value),
        reverse: q('.g-reverse').checked,
        start: Number(start.value) || 0,
        end: end.value ? Number(end.value) : undefined,
      });
      const filename = `${base}${fields.fit.value === 'sticker' ? '_sticker' : ''}.${format}`;
      lastUrl = r.url;
      q('.g-img').src = r.url;
      const save = q('.g-save');
      save.href = `${r.url}?dl=1&name=${encodeURIComponent(filename)}`;
      save.download = filename;
      save.textContent = `Save ${format === 'webp' ? 'WebP' : 'GIF'}`;
      if (copyBtn) copyBtn.hidden = format !== 'gif';
      out.hidden = false;
      status.textContent = `Ready: ${describe(r, true)}`;
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('error');
    } finally {
      btn.disabled = false;
    }
  });

  // Most browsers can only put PNGs on the clipboard, so hide the button where GIF isn't supported.
  let copyBtn = q('.g-copy');
  if (!window.ClipboardItem || !ClipboardItem.supports?.('image/gif')) {
    copyBtn.remove();
    copyBtn = null;
  } else {
    copyBtn.addEventListener('click', async (e) => {
      try {
        const blob = await (await fetch(lastUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/gif': blob })]);
        flash(e.currentTarget, 'Copied!');
      } catch {
        flash(e.currentTarget, 'Copy failed');
      }
    });
  }
}

// ---------- your own files ----------
let localUrl; // object URL of the uploaded file's preview

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'Upload failed. Please try again.'));
    };
    xhr.onerror = () => reject(new Error("Couldn't reach the server. Check your connection and try again."));
    xhr.send(file);
  });
}

async function handleFile(file) {
  if (!file) return;
  const isGif = file.type === 'image/gif';
  if (!isGif && !file.type.startsWith('video/') && file.type !== '') {
    setStatus('Please choose a video (MP4, MOV, WebM…) or a GIF.', true);
    return;
  }
  if (file.size > MAX_UPLOAD) {
    setStatus('Files can be up to 100 MB.', true);
    return;
  }
  input.value = '';
  history.replaceState(null, '', location.pathname);
  resetResult();
  const bar = $('.dz-bar', dropzone);
  bar.hidden = false;
  dropzone.classList.add('busy');
  try {
    const up = await uploadFile(file, (p) => {
      bar.firstElementChild.style.width = `${Math.round(p * 100)}%`;
      setStatus(p < 1 ? `Uploading ${file.name}… ${Math.round(p * 100)}%` : 'Checking your file…');
    });
    localUrl = URL.createObjectURL(file);
    const base = file.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'my-video';
    const m = {
      index: 0,
      type: isGif ? 'gif' : 'video',
      local: localUrl,
      durationMs: up.durationMs,
      variants: [{ url: up.src, width: up.width, height: up.height, label: 'Original' }],
    };
    const card = make('article', { className: 'tweet' }, [
      make('div', { className: 'author' }, [
        make('div', {}, [
          make('div', { className: 'name', textContent: file.name }),
          make('small', { className: 'handle', textContent: `Your file · ${fmtBytes(file.size)}${up.width ? ` · ${up.width}×${up.height}` : ''}` }),
        ]),
      ]),
      make('div', { className: 'media-list' }, [renderMedia(m, base)]),
    ]);
    showResult(card);
    syncClear();
    setStatus('Ready. Choose Download GIF, WebP, or a preset.');
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    bar.hidden = true;
    bar.firstElementChild.style.width = '0';
    dropzone.classList.remove('busy');
    fileInput.value = '';
  }
}

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
for (const t of ['dragenter', 'dragover']) {
  dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const t of ['dragleave', 'drop']) dropzone.addEventListener(t, () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

// ---------- Recent (per-browser convenience only) ----------
function readHistory() {
  try {
    const items = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}
function writeHistory(items) {
  // Pinned first, then newest; keep every pinned item plus the latest MAX_RECENT others.
  const pinned = items.filter((h) => h.pinned);
  const rest = items.filter((h) => !h.pinned).slice(0, MAX_RECENT);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([...pinned, ...rest]));
  } catch {
    /* storage unavailable */
  }
}
function updateItem(id, change) {
  writeHistory(readHistory().map((h) => (h.id === id ? { ...h, ...change } : h)));
  renderHistory();
}
function addHistory(url, data) {
  const old = readHistory();
  const prev = old.find((h) => h.id === data.id);
  const anim = data.media.find((m) => m.type !== 'photo');
  const item = {
    id: data.id,
    url,
    handle: data.author.handle,
    text: data.text.slice(0, 120),
    thumb: data.media[0]?.thumbnail,
    type: data.media[0]?.type,
    src: anim?.variants[0]?.url, // for hover preview + quick GIF
    ts: Date.now(),
    pinned: prev?.pinned ?? false,
  };
  writeHistory([item, ...old.filter((h) => h.id !== data.id)]);
  renderHistory();
}

const canHover = matchMedia('(hover: hover)').matches;

function renderHistory() {
  const items = readHistory();
  $('#history-wrap').hidden = !items.length;
  const hasPinned = items.some((h) => h.pinned);
  const clearHist = $('#clear-history');
  clearHist.textContent = hasPinned ? 'Clear unpinned' : 'Clear';
  clearHist.hidden = items.every((h) => h.pinned);

  $('#history').replaceChildren(
    ...items.map((h) => {
      const thumb = make('span', { className: 'h-thumb' });
      if (h.thumb) thumb.append(make('img', { src: mediaUrl(h.thumb), alt: '', loading: 'lazy' }));
      if (h.src && h.type !== 'photo') thumb.append(make('span', { className: 'h-play', textContent: '▶', ariaHidden: 'true' }));

      const open = make('button', { type: 'button', className: 'h-open', title: 'Open this tweet again' }, [
        thumb,
        make('span', { className: 'h-text', textContent: h.text || '(no text)' }, [
          make('small', { className: 'h-meta', textContent: [`@${h.handle || 'unknown'}`, h.type, timeAgo(h.ts)].filter(Boolean).join(' · ') }, []),
        ]),
      ]);
      open.addEventListener('click', () => load(h.url));

      // Animated preview on hover (desktop): play the clip over the thumbnail.
      if (canHover && h.src && h.type !== 'photo') {
        let v;
        open.addEventListener('mouseenter', () => {
          v = make('video', { muted: true, defaultMuted: true, loop: true, playsInline: true });
          v.src = mediaUrl(h.src);
          thumb.append(v);
          v.play().catch(() => {}); // autoplay on script-added videos isn't reliable; start it ourselves
        });
        open.addEventListener('mouseleave', () => v?.remove());
      }

      const actions = [];
      if (h.src) {
        const gifBtn = make('button', { type: 'button', className: 'h-btn h-gif', textContent: 'GIF', title: 'Download GIF again' });
        gifBtn.addEventListener('click', async () => {
          gifBtn.disabled = true;
          gifBtn.textContent = '…';
          try {
            const r = await convert(oneClickSettings(h.src, 'gif'));
            saveUrl(r.url, `${h.handle || 'tweet'}_${h.id}.gif`);
            flash(gifBtn, '✓');
          } catch (e) {
            setStatus(e.message, true);
            gifBtn.textContent = 'GIF';
          } finally {
            gifBtn.disabled = false;
            setTimeout(() => (gifBtn.textContent = 'GIF'), 1500);
          }
        });
        actions.push(gifBtn);
      }
      const pin = make('button', {
        type: 'button',
        className: `h-btn h-pin${h.pinned ? ' on' : ''}`,
        textContent: h.pinned ? '★' : '☆',
        title: h.pinned ? 'Unpin' : 'Pin (keeps it in the list)',
      });
      pin.setAttribute('aria-pressed', String(Boolean(h.pinned)));
      pin.addEventListener('click', () => updateItem(h.id, { pinned: !h.pinned }));
      const del = make('button', { type: 'button', className: 'h-btn h-del', textContent: '✕', title: 'Remove from Recent' });
      del.addEventListener('click', () => {
        writeHistory(readHistory().filter((x) => x.id !== h.id));
        renderHistory();
      });
      actions.push(pin, del);

      const li = make('li', { className: h.pinned ? 'pinned' : '' }, [make('div', { className: 'h-row' }, [open, ...actions])]);
      li.dataset.ts = h.ts ?? '';
      li.dataset.meta = [`@${h.handle || 'unknown'}`, h.type].filter(Boolean).join(' · ');
      return li;
    }),
  );
}
$('#clear-history').addEventListener('click', () => {
  writeHistory(readHistory().filter((h) => h.pinned));
  renderHistory();
});

// ---------- wiring ----------
form.addEventListener('submit', (e) => {
  e.preventDefault();
  load(input.value);
});

// Clear: reset the link, results and address bar so the next GIF can be fetched right away.
const clearBtn = $('#clear');
function syncClear() {
  clearBtn.hidden = !input.value && resultEl.hidden;
}
function resetResult() {
  resultEl.replaceChildren(); // also stops any playing preview
  resultEl.hidden = true;
  if (localUrl) URL.revokeObjectURL(localUrl);
  localUrl = undefined;
}
function clearAll() {
  input.value = '';
  resetResult();
  setStatus('');
  history.replaceState(null, '', location.pathname);
  syncClear();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  input.focus();
}
clearBtn.addEventListener('click', clearAll);
input.addEventListener('input', syncClear);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (input.value || !resultEl.hidden)) clearAll();
});
new MutationObserver(syncClear).observe(resultEl, { attributes: true, attributeFilter: ['hidden'] });

input.addEventListener('paste', () => {
  setTimeout(() => looksLikeTweet(input.value) && load(input.value), 0);
});

const pasteBtn = $('#paste');
if (!navigator.clipboard?.readText) pasteBtn.remove();
else
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      input.value = text;
      if (looksLikeTweet(text)) load(text);
      else input.focus();
    } catch {
      input.focus();
    }
  });

// Bookmarklet: sends the current tweet page to this site.
$('#bookmarklet').href = `javascript:location.href='${location.origin}/?url='+encodeURIComponent(location.href)`;
$('#bookmarklet').addEventListener('click', (e) => {
  e.preventDefault();
  setStatus('Drag the "⤓ Gifpocket" button to your bookmarks bar, then click it while viewing a tweet.');
});

renderHistory();
// Keep "5m ago" labels fresh without re-drawing the list.
setInterval(() => {
  for (const li of document.querySelectorAll('#history li')) {
    const ago = timeAgo(Number(li.dataset.ts));
    $('.h-meta', li).textContent = [li.dataset.meta, ago].filter(Boolean).join(' · ');
  }
}, 60_000);
const params = new URLSearchParams(location.search);
const initial = params.get('url') || params.get('text');
if (initial) load(initial);
