import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, extractors } from './extractors/index.js';
import { proxyMedia, safeFilename } from './media.js';
import { getGifFile, getOrMakeGif, parseGifOptions, saveUpload } from './gif.js';
import { rateLimit } from './rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
app.use(express.json({ limit: '10kb' }));
// HTML is never cached, so a release is picked up right away; CSS/JS links carry a ?v= tag
// in index.html — bump it whenever those files change.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders: (res, file) => {
      if (file.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
    },
  }),
);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/platforms', (_req, res) => {
  res.json(extractors.map((e) => ({ id: e.id, name: e.name })));
});

app.post(
  '/api/extract',
  rateLimit({ windowMs: 60_000, max: 30 }),
  wrap(async (req, res) => {
    res.json(await extract(req.body?.url));
  }),
);

app.get('/api/media', rateLimit({ windowMs: 60_000, max: 200 }), wrap(proxyMedia));

// Upload your own video or GIF (raw file body, max 100 MB). Returns a source id for /api/gif.
app.post(
  '/api/upload',
  rateLimit({ windowMs: 60_000, max: 10, message: 'Upload limit reached. Try again in a minute.' }),
  wrap(async (req, res) => {
    res.json(await saveUpload(req));
  }),
);

// Step 1: build the GIF / WebP (or reuse one already built) and get its id.
app.post(
  '/api/gif',
  rateLimit({ windowMs: 60_000, max: 15, message: 'Conversion limit reached. Try again in a minute.' }),
  wrap(async (req, res) => {
    const gif = await getOrMakeGif(parseGifOptions(req.body ?? {}));
    res.json({ ...gif, url: `/api/gif/${gif.id}.${gif.format}` });
  }),
);

// Step 2: a normal URL for the file — inline for previews, ?dl=1 to save with a filename.
app.get('/api/gif/:file', (req, res) => {
  const entry = getGifFile(req.params.file.replace(/\.(gif|webp)$/, ''));
  if (!entry) return res.status(404).json({ error: 'This file has expired. Please make it again.' });
  res.setHeader('cache-control', 'private, max-age=900');
  if (req.query.dl) res.attachment(safeFilename(req.query.name, entry.format));
  res.type(entry.format).sendFile(entry.file);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (!err.expose) console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`Gifpocket running at http://localhost:${PORT}`));
