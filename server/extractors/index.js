import { HttpError } from '../errors.js';
import * as twitter from './twitter.js';

/**
 * Every platform is a module exporting:
 *   id, name, mediaHosts[], match(url) -> bool, extract(url) -> Promise<Result>
 * To add Instagram / Reddit / TikTok later, write a new file and add it here.
 */
export const extractors = [twitter];

/** Hosts the media proxy and GIF converter may fetch from (prevents SSRF). */
export const allowedMediaHosts = new Set(extractors.flatMap((e) => e.mediaHosts));

const cache = new Map(); // key -> { at, value }
const TTL = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

export async function extract(input) {
  const url = String(input ?? '').trim();
  if (!url) throw new HttpError(400, 'Paste a tweet link first.');
  if (url.length > 2000) throw new HttpError(400, 'That link is too long.');

  const ex = extractors.find((e) => e.match(url));
  if (!ex) throw new HttpError(400, `Unsupported link. Supported: ${extractors.map((e) => e.name).join(', ')}.`);

  const key = `${ex.id}:${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const value = await ex.extract(url);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}
