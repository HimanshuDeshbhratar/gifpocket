/** Minimal in-memory per-IP rate limiter. Swap for Redis when running several instances. */
export function rateLimit({ windowMs, max, message = 'Too many requests. Slow down a little.' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, (h = { count: 0, reset: now + windowMs }));
    h.count++;
    if (h.count > max) {
      res.setHeader('retry-after', Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
