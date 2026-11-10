import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './errors.js';
import { allowedMediaHosts } from './extractors/index.js';

export function checkMediaUrl(src) {
  let u;
  try {
    u = new URL(String(src ?? ''));
  } catch {
    throw new HttpError(400, 'Invalid media URL.');
  }
  if (u.protocol !== 'https:' || !allowedMediaHosts.has(u.hostname)) {
    throw new HttpError(400, 'Media host not allowed.');
  }
  return u;
}

export function safeFilename(name, fallbackExt) {
  let n = String(name ?? '').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 100);
  if (!n) n = 'download';
  if (fallbackExt && !/\.\w{2,4}$/.test(n)) n += `.${fallbackExt}`;
  return n;
}

/**
 * GET /api/media?src=<twimg url>[&dl=1&name=file.mp4]
 * Streams media through our server so the browser can preview it (with seeking)
 * and save it with a proper filename (the `download` attribute is ignored cross-origin).
 */
export async function proxyMedia(req, res) {
  const u = checkMediaUrl(req.query.src);
  const headers = { 'user-agent': 'Mozilla/5.0' };
  if (req.headers.range) headers.range = req.headers.range;

  const up = await fetch(u, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!up.ok) throw new HttpError(502, 'The media file is no longer available.');

  res.status(up.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader('cache-control', 'public, max-age=3600');
  if (req.query.dl) {
    const ext = (up.headers.get('content-type') ?? '').includes('video') ? 'mp4' : 'jpg';
    res.setHeader('content-disposition', `attachment; filename="${safeFilename(req.query.name, ext)}"`);
  }
  try {
    await pipeline(Readable.fromWeb(up.body), res);
  } catch {
    /* client closed the connection — nothing to do */
  }
}
