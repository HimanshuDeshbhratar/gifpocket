import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import { HttpError } from './errors.js';
import { checkMediaUrl } from './media.js';

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_SECONDS = 120;
const FFMPEG_TIMEOUT_MS = 240_000;
// GIF frame delays are whole hundredths of a second and browsers slow down anything
// faster than 2/100 s, so 50 fps is the highest rate that plays correctly.
const MAX_FPS = 50;
// Output size limit: 5 MB unless a preset asks for another (64 KB – 15 MB).
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;
const MAX_MAX_BYTES = 15 * 1024 * 1024;
// To fit the limit we lower the frame rate to PREFERRED_MIN_FPS first (still smooth),
// then the width, then fps down to MIN_FPS, then colours (GIF) / quality (WebP).
const PREFERRED_MIN_FPS = 8;
const MIN_FPS = 5;
const MIN_WIDTH = 64;
const STICKER_SIZE = 512; // WhatsApp / Telegram sticker canvas
// Last-resort steps: GIF palette size, or WebP quality.
const LEVELS = { gif: [256, 128, 64, 32], webp: [75, 60, 45, 30] };
// How many conversions run at once, and how many threads each ffmpeg may use. Small hosts
// (e.g. Render free: 0.1 CPU, 512 MB) should set FFMPEG_JOBS=1 and FFMPEG_THREADS=1, because
// os.cpus() there reports the whole machine, not the slice this app gets.
const MAX_JOBS = Number(process.env.FFMPEG_JOBS) || Math.max(1, Math.min(4, os.cpus().length - 1));
const THREAD_ARGS = process.env.FFMPEG_THREADS ? ['-threads', String(Number(process.env.FFMPEG_THREADS) || 1)] : [];
const MAX_QUEUE = 20;
const UPLOAD_KEEP_MS = 30 * 60 * 1000;

// ---- tiny job queue so a burst of requests can't spawn unlimited ffmpeg processes ----
let active = 0;
const waiting = [];
function acquire() {
  if (active < MAX_JOBS) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE) throw new HttpError(503, 'Server is busy converting. Try again in a moment.');
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight to the next job
  else active--;
}

function num(v, def, min, max) {
  if (v === undefined || v === '' || v === null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'Invalid settings.');
  return Math.min(max, Math.max(min, n));
}

// 0 or "original" means "keep the source value".
const isOriginal = (v) => v === 0 || v === '0' || v === 'original';

export function fmtSize(bytes) {
  return bytes >= 1024 * 1024 ? `${+(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function parseGifOptions(q) {
  // Source: a tweet media URL, or "upload:<id>" for a file the user uploaded.
  let src;
  if (typeof q.src === 'string' && q.src.startsWith('upload:')) {
    const id = q.src.slice(7);
    if (!uploads.has(id)) throw new HttpError(410, 'Your upload has expired. Please upload the file again.');
    src = `upload:${id}`;
  } else {
    src = checkMediaUrl(q.src).toString();
  }
  const format = q.format === 'webp' ? 'webp' : 'gif';
  const fit = ['square', 'sticker'].includes(q.fit) ? q.fit : 'none';
  const fps = isOriginal(q.fps) ? 0 : Math.round(num(q.fps, 15, MIN_FPS, MAX_FPS));
  const width = isOriginal(q.width) ? 0 : Math.round(num(q.width, 480, MIN_WIDTH, 1920));
  const maxBytes = Math.round(num(q.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES));
  const start = num(q.start, 0, 0, 3600);
  const end = q.end === undefined || q.end === '' || q.end === null ? start + MAX_SECONDS : num(q.end, 0, 0, 3600 + MAX_SECONDS);
  if (end <= start) throw new HttpError(400, 'Trim end must be after trim start.');
  if (end - start > MAX_SECONDS) throw new HttpError(400, `Clips can be at most ${MAX_SECONDS / 60} minutes.`);
  const speed = num(q.speed, 1, 0.25, 4);
  const reverse = q.reverse === true || q.reverse === '1' || q.reverse === 'true';
  return { src, format, fit, fps, width, maxBytes, start, duration: end - start, speed, reverse };
}

// ---------- input files ----------

function sizeLimiter(message) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > MAX_INPUT_BYTES) cb(new HttpError(413, message));
      else cb(null, chunk);
    },
  });
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new HttpError(502, 'The media file is no longer available.');
  if (Number(res.headers.get('content-length') ?? 0) > MAX_INPUT_BYTES) throw new HttpError(413, 'That video is too large to convert.');
  await pipeline(Readable.fromWeb(res.body), sizeLimiter('That video is too large to convert.'), createWriteStream(file));
}

/** Reads what ffmpeg reports about a file: { fps, width, height, durationMs, isVideo }. */
function probe(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    let out = '';
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => resolve({}));
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.includes('Video:')) ?? '';
      const fps = line.match(/(\d+(?:\.\d+)?) (?:fps|tbr)/);
      const size = line.match(/, (\d{2,5})x(\d{2,5})[ ,[]/);
      const dur = out.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve({
        isVideo: Boolean(line),
        fps: fps ? Number(fps[1]) : null,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        durationMs: dur ? Math.round(((+dur[1] * 60 + +dur[2]) * 60 + +dur[3]) * 1000) : null,
      });
    });
  });
}

// ---------- uploads (the user's own videos / GIFs) ----------

const uploads = new Map(); // id -> { file, at }
const uploadRoot = path.join(os.tmpdir(), 'gifpocket-uploads');

/** Streams the request body to disk (max 100 MB) and checks it really is a video or GIF. */
export async function saveUpload(req) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_INPUT_BYTES) throw new HttpError(413, 'Files can be up to 100 MB.');
  await mkdir(uploadRoot, { recursive: true });
  const id = randomBytes(12).toString('hex');
  const file = path.join(uploadRoot, id);
  try {
    await pipeline(req, sizeLimiter('Files can be up to 100 MB.'), createWriteStream(file));
  } catch (e) {
    await rm(file, { force: true });
    throw e.expose ? e : new HttpError(400, 'Upload failed. Please try again.');
  }
  const info = await probe(file);
  if (!info.isVideo) {
    await rm(file, { force: true });
    throw new HttpError(400, "That file isn't a video or GIF we can read.");
  }
  uploads.set(id, { file, at: Date.now() });
  return { id, src: `upload:${id}`, width: info.width, height: info.height, durationMs: info.durationMs };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.at > UPLOAD_KEEP_MS) {
      uploads.delete(id);
      rm(u.file, { force: true }).catch(() => {});
    }
  }
}, 60_000).unref();

// ---------- ffmpeg ----------

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        console.error('ffmpeg failed:', stderr);
        reject(new HttpError(500, 'Conversion failed.'));
      }
    });
  });
}

// ---- finished files are kept for a while so preview + download (and repeat requests) reuse one file ----
const KEEP_MS = 15 * 60 * 1000;
const MAX_STORE_BYTES = 1024 * 1024 * 1024;
const store = new Map(); // id -> { file, bytes, format, cleanup, at, ... }
const inflight = new Map(); // id -> Promise

function prune() {
  const now = Date.now();
  let total = 0;
  for (const e of store.values()) total += e.bytes;
  for (const [id, e] of store) {
    // Map keeps insertion order, so this walks oldest first.
    if (now - e.at > KEEP_MS || total > MAX_STORE_BYTES) {
      store.delete(id);
      total -= e.bytes;
      e.cleanup();
    }
  }
}
setInterval(prune, 60_000).unref();

/** Returns { id, bytes, width, fps, format, maxBytes, reduced }, converting only if needed. */
export async function getOrMakeGif(opts) {
  const id = createHash('sha1').update(JSON.stringify(opts)).digest('hex').slice(0, 20);
  const info = (r) => ({ id, bytes: r.bytes, width: r.width, fps: r.fps, format: r.format, maxBytes: opts.maxBytes, reduced: r.reduced });
  const hit = store.get(id);
  if (hit) return info(hit);
  if (!inflight.has(id)) {
    inflight.set(
      id,
      makeGif(opts)
        .then((r) => {
          store.set(id, { ...r, at: Date.now() });
          prune();
          return r;
        })
        .finally(() => inflight.delete(id)),
    );
  }
  return info(await inflight.get(id));
}

export function getGifFile(id) {
  return /^[a-f0-9]{20}$/.test(id) ? store.get(id) : undefined;
}

/**
 * Converts a video to a GIF or animated WebP no bigger than opts.maxBytes.
 * Starts at the requested (or original) size and frame rate; if the result is too big it
 * lowers the frame rate, then the width, then colours/quality, and tries again.
 * The length is never cut. Returns { file, bytes, width, fps, format, reduced, cleanup }.
 */
export async function makeGif(opts) {
  await acquire();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gifpocket-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    let input;
    if (opts.src.startsWith('upload:')) {
      const u = uploads.get(opts.src.slice(7));
      if (!u) throw new HttpError(410, 'Your upload has expired. Please upload the file again.');
      u.at = Date.now();
      input = u.file;
    } else {
      input = path.join(dir, 'in.mp4');
      await download(opts.src, input);
    }
    const output = path.join(dir, `out.${opts.format}`);

    const src = await probe(input);
    const srcFps = Math.min(src.fps ?? 30, MAX_FPS);
    // Width of the picture before any resizing (a square crop uses the shorter side).
    const baseWidth =
      opts.fit === 'sticker' ? STICKER_SIZE
      : opts.fit === 'square' && src.width && src.height ? Math.min(src.width, src.height)
      : src.width || 480;
    const lockWidth = opts.fit === 'sticker'; // stickers must be exactly 512×512

    let fps = opts.fps ? Math.min(opts.fps, srcFps) : srcFps; // never add frames that aren't there
    let width = Math.min(opts.width || baseWidth, baseWidth);
    let level = 0;
    const levels = LEVELS[opts.format];
    const maxFps = fps;
    const maxWidth = width;
    const limit = opts.maxBytes;

    const encode = async (seconds, file = output) => {
      const f = [];
      if (opts.speed !== 1) f.push(`setpts=PTS/${opts.speed}`);
      if (opts.reverse) f.push('reverse');
      f.push(`fps=${fps}`);
      if (opts.fit === 'sticker') {
        f.push(
          `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos`,
          'format=rgba',
          `pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
        );
      } else {
        if (opts.fit === 'square') f.push("crop='min(iw,ih)':'min(iw,ih)'");
        if (width < baseWidth) f.push(`scale=${width}:-2:flags=lanczos`);
      }
      const common = ['-hide_banner', '-loglevel', 'error', ...(opts.start > 0 ? ['-ss', String(opts.start)] : []), '-t', String(seconds), '-i', input, '-an', ...THREAD_ARGS];
      if (opts.format === 'webp') {
        await runFfmpeg([
          ...common,
          '-vf', f.join(','),
          '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(levels[level]), '-compression_level', '4',
          '-loop', '0', '-y', file,
        ]);
      } else {
        // One shared palette + ordered dithering: good colours and compresses far better
        // than per-frame palettes.
        const vf =
          `${f.join(',')},split[a][b];[a]palettegen=max_colors=${levels[level]}:stats_mode=diff[p];` +
          `[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
        await runFfmpeg([...common, '-vf', vf, '-loop', '0', '-y', file]);
      }
      return (await stat(file)).size;
    };

    // Picks smaller settings for a file of `bytes` so it lands near `target`. Size grows
    // roughly with frames × pixels. Returns null when nothing is left to reduce.
    const shrink = (bytes, target) => {
      let ratio = target / bytes;
      let nextFps = fps;
      if (fps > PREFERRED_MIN_FPS) {
        nextFps = Math.max(PREFERRED_MIN_FPS, Math.floor(fps * ratio));
        ratio /= nextFps / fps;
      }
      let nextWidth = width;
      if (ratio < 1 && !lockWidth && width > MIN_WIDTH) {
        nextWidth = Math.max(MIN_WIDTH, Math.min(Math.floor(width * 0.95), Math.floor(width * Math.sqrt(ratio))));
        ratio /= (nextWidth / width) ** 2;
      }
      if (ratio < 0.95 && nextFps > MIN_FPS) nextFps = Math.max(MIN_FPS, Math.floor(nextFps * ratio));
      let nextLevel = level;
      if (nextFps === fps && nextWidth === width) {
        if (level >= levels.length - 1) return null;
        nextLevel = level + 1;
      }
      return { fps: nextFps, width: nextWidth, level: nextLevel };
    };
    const apply = (next) => ({ fps, width, level } = next);

    let reduced = false;

    // 1) For longer clips, encode a short sample to predict the full size, and pick
    //    settings from that, so the full clip is usually encoded only once.
    const SAMPLE_SECONDS = 3;
    if (opts.duration > SAMPLE_SECONDS * 2) {
      let estimate = (await encode(SAMPLE_SECONDS)) * (opts.duration / SAMPLE_SECONDS);
      for (let i = 0; estimate > limit * 0.95 && i < 30; i++) {
        const next = shrink(estimate, limit * 0.9);
        if (!next) break;
        estimate *= (next.fps / fps) * (next.width / width) ** 2 * (next.level > level ? 0.85 : 1);
        apply(next);
        reduced = true;
      }
    }

    // 2) Full encode, then correct if the prediction was off.
    let bytes = await encode(opts.duration);
    for (let attempt = 0; bytes > limit && attempt < 6; attempt++) {
      const next = shrink(bytes, limit * 0.93);
      if (!next) break;
      apply(next);
      reduced = true;
      bytes = await encode(opts.duration);
    }

    // 3) If the prediction was too cautious and there's lots of room left, grow back
    //    toward the original (quality, then fps up to PREFERRED_MIN_FPS, then width, then fps).
    let file = output;
    for (let attempt = 0; reduced && bytes <= limit && bytes < limit * 0.75 && attempt < 2; attempt++) {
      let ratio = (limit * 0.88) / bytes;
      const next = { fps, width, level: 0 };
      if (level > 0) ratio /= 1.15;
      if (fps < Math.min(maxFps, PREFERRED_MIN_FPS)) {
        next.fps = Math.min(maxFps, PREFERRED_MIN_FPS, Math.floor(fps * ratio));
        ratio /= next.fps / fps;
      }
      if (!lockWidth) {
        next.width = Math.min(maxWidth, Math.floor(width * Math.sqrt(Math.max(1, ratio))));
        ratio /= (next.width / width) ** 2;
      }
      if (ratio > 1.1) next.fps = Math.min(maxFps, Math.floor(next.fps * ratio));
      if (next.fps === fps && next.width === width && next.level === level) break;

      const candidate = path.join(dir, `grow${attempt}.${opts.format}`);
      const prev = { fps, width, level };
      apply(next);
      const grown = await encode(opts.duration, candidate);
      if (grown > limit) {
        apply(prev); // too far — keep the last file that fit
        break;
      }
      file = candidate;
      bytes = grown;
      reduced = fps < maxFps || width < maxWidth || level > 0;
    }

    if (bytes > limit) {
      throw new HttpError(413, `This clip is too long to fit in ${fmtSize(limit)}. Trim it in Customize and try again.`);
    }
    const outWidth = lockWidth ? STICKER_SIZE : width;
    return { file, bytes, width: outWidth, fps, format: opts.format, reduced, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  } finally {
    release();
  }
}
