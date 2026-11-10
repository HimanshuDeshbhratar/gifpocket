import { HttpError } from '../errors.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// twitter.com, x.com and the common "fix" mirrors people share links from.
const HOST_RE =
  /^(?:www\.|mobile\.|m\.)?(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com|twittpr\.com|nitter\.net)$/i;

export const id = 'twitter';
export const name = 'X / Twitter';
export const mediaHosts = ['video.twimg.com', 'pbs.twimg.com'];

/** Returns the tweet id for a tweet URL (or a bare id), or null. */
export function parseTweetId(input) {
  const s = String(input ?? '').trim();
  if (/^\d{1,25}$/.test(s)) return s;
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!HOST_RE.test(u.hostname)) return null;
  const m = u.pathname.match(/\/status(?:es)?\/(\d{1,25})/);
  return m ? m[1] : null;
}

export function match(input) {
  return parseTweetId(input) !== null;
}

export async function extract(input) {
  const tweetId = parseTweetId(input);
  if (!tweetId) throw new HttpError(400, "That doesn't look like a tweet link.");

  let primaryError;
  try {
    const result = await fromSyndication(tweetId);
    if (result.media.length) return result;
    primaryError = new HttpError(404, 'This tweet has no GIF, video or image.');
  } catch (e) {
    primaryError = e;
  }

  // Fallback: the public FxTwitter API handles some tweets the embed API refuses
  // (for example age-restricted ones).
  try {
    const result = await fromFxTwitter(tweetId);
    if (result.media.length) return result;
  } catch {
    /* keep the primary error */
  }
  throw primaryError?.expose
    ? primaryError
    : new HttpError(502, "Couldn't load that tweet. It may be private, deleted or age-restricted.");
}

// ---------- Source 1: Twitter's public embed (syndication) API ----------

function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

async function fromSyndication(tweetId) {
  const url = new URL('https://cdn.syndication.twimg.com/tweet-result');
  url.searchParams.set('id', tweetId);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('token', syndicationToken(tweetId));

  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) throw new HttpError(404, 'Tweet not found. It may be deleted or from a private account.');
  if (!res.ok) throw new Error(`syndication ${res.status}`);
  const text = await res.text();
  if (!text) throw new HttpError(404, 'Tweet not found. It may be deleted or from a private account.');
  const d = JSON.parse(text);
  if (d.__typename === 'TweetTombstone') {
    throw new HttpError(403, 'This tweet is unavailable (private, deleted or age-restricted).');
  }

  let details = d.mediaDetails ?? [];
  if (!details.length && d.quoted_tweet?.mediaDetails) details = d.quoted_tweet.mediaDetails;

  const media = details
    .map((m, index) => {
      if (m.type === 'photo') {
        const w = m.original_info?.width;
        const h = m.original_info?.height;
        return {
          index,
          type: 'photo',
          thumbnail: m.media_url_https,
          width: w,
          height: h,
          variants: [
            { url: withName(m.media_url_https, 'orig'), contentType: 'image/jpeg', width: w, height: h, label: 'Original' },
          ],
        };
      }
      const variants = (m.video_info?.variants ?? [])
        .filter((v) => v.content_type === 'video/mp4')
        .map((v) => mp4Variant(v.url, v.bitrate, m.original_info))
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      return {
        index,
        type: m.type === 'animated_gif' ? 'gif' : 'video',
        thumbnail: m.media_url_https,
        width: m.original_info?.width,
        height: m.original_info?.height,
        durationMs: m.video_info?.duration_millis,
        variants,
      };
    })
    .filter((m) => m.variants.length);

  return {
    platform: id,
    id: tweetId,
    url: `https://x.com/${d.user?.screen_name ?? 'i'}/status/${tweetId}`,
    text: d.text ?? '',
    createdAt: d.created_at,
    author: {
      name: d.user?.name ?? '',
      handle: d.user?.screen_name ?? '',
      avatar: d.user?.profile_image_url_https ?? '',
    },
    media,
    source: 'syndication',
  };
}

// ---------- Source 2: FxTwitter public API (fallback) ----------

async function fromFxTwitter(tweetId) {
  const res = await fetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {
    headers: { 'user-agent': 'loopsave/0.1', accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`fxtwitter ${res.status}`);
  const { tweet: t } = await res.json();
  if (!t) throw new Error('fxtwitter: no tweet');

  const all = t.media?.all ?? [];
  const media = all
    .map((m, index) => {
      if (m.type === 'photo') {
        return {
          index,
          type: 'photo',
          thumbnail: m.url,
          width: m.width,
          height: m.height,
          variants: [{ url: withName(m.url, 'orig'), contentType: 'image/jpeg', width: m.width, height: m.height, label: 'Original' }],
        };
      }
      let variants = (m.variants ?? [])
        .filter((v) => v.content_type === 'video/mp4')
        .map((v) => mp4Variant(v.url, v.bitrate, m));
      if (!variants.length && m.url) variants = [mp4Variant(m.url, 0, m)];
      variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      return {
        index,
        type: m.type === 'gif' ? 'gif' : 'video',
        thumbnail: m.thumbnail_url,
        width: m.width,
        height: m.height,
        durationMs: m.duration ? Math.round(m.duration * 1000) : undefined,
        variants,
      };
    })
    .filter((m) => m.variants.length && isAllowedMedia(m.variants[0].url));

  return {
    platform: id,
    id: tweetId,
    url: t.url ?? `https://x.com/i/status/${tweetId}`,
    text: t.text ?? '',
    createdAt: t.created_at,
    author: { name: t.author?.name ?? '', handle: t.author?.screen_name ?? '', avatar: t.author?.avatar_url ?? '' },
    media,
    source: 'fxtwitter',
  };
}

// ---------- helpers ----------

function isAllowedMedia(u) {
  try {
    return mediaHosts.includes(new URL(u).hostname);
  } catch {
    return false;
  }
}

function withName(imgUrl, size) {
  try {
    const u = new URL(imgUrl);
    const ext = u.pathname.match(/\.(\w+)$/)?.[1] ?? 'jpg';
    u.pathname = u.pathname.replace(/\.\w+$/, '');
    u.searchParams.set('format', ext);
    u.searchParams.set('name', size);
    return u.toString();
  } catch {
    return imgUrl;
  }
}

function mp4Variant(url, bitrate, original) {
  // Video URLs look like .../vid/avc1/720x1280/xxx.mp4 — read the size from there.
  const m = url.match(/\/(\d{2,5})x(\d{2,5})\//);
  const width = m ? Number(m[1]) : original?.width;
  const height = m ? Number(m[2]) : original?.height;
  const label = m ? `${Math.min(width, height)}p` : width ? `${width}×${height}` : 'Original';
  return { url, contentType: 'video/mp4', bitrate: bitrate ?? 0, width, height, label };
}
