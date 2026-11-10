# Gifpocket

Paste a tweet link → download its GIF (as MP4 or a real `.gif`), video or images.

## Run

```bash
npm install
npm run dev        # http://localhost:3000 (auto-restarts on changes)
```

`npm start` for production (set `NODE_ENV=production`, `PORT`, and `TRUST_PROXY` if behind a proxy/CDN).
ffmpeg is bundled through `ffmpeg-static`, so no separate install is needed.

## Features

- Accepts x.com, twitter.com, mobile links, fxtwitter/vxtwitter/fixupx links and bare tweet IDs
- Every media item in a tweet: GIFs, videos (all quality levels), photos (original resolution)
- **Download GIF** (one click): full length, original size and frame rate, **always under 5 MB**. If needed, the server lowers frame rate (to 8 fps), then width, then colours, using a quick 3 s sample to predict the size so the clip is usually encoded once
- **WebP** (one click): animated WebP, usually ~⅓ the size of the GIF, so it stays sharper under the same cap
- **Convert your own video or GIF**: drag & drop or pick a file (MP4/MOV/WebM/GIF, up to 100 MB, upload progress bar). Uploads are deleted after 30 min
- **Customize & presets**: Standard GIF (5 MB), Sharper WebP (5 MB), Discord (10 MB), Discord emoji (128px square, 256 KB), WhatsApp/Telegram sticker (512×512 WebP, 500 KB), Re-post on X/Telegram (15 MB). Plus format, max size, shape (original / square crop / sticker), width, frame rate, speed, reverse, trim (with "now" buttons that use the video position)
- Preview before download, copy direct link, copy GIF to clipboard (where the browser supports it)
- Auto-start when a link is pasted, Paste button, ✕ clear button (or Esc), `?url=` deep links, bookmarklet
- **Recent** (stored in the browser only): animated preview on hover, one-click GIF re-download, ⭐ pin (pinned items are never pushed out), remove single items, "time ago"
- Light/dark theme, mobile layout

## How it works

| Path | What it does |
| --- | --- |
| `POST /api/extract {url}` | Finds media. Uses Twitter's public embed API first and falls back to the public FxTwitter API. Results are cached for 10 minutes. |
| `GET /api/media?src=&dl=1&name=` | Streams media from `video.twimg.com` / `pbs.twimg.com` only, with Range support for seeking and a filename for downloads. |
| `POST /api/upload` (raw file body) | Saves the user's own video/GIF (max 100 MB), checks it with ffmpeg, returns `src: "upload:<id>"`. |
| `POST /api/gif {src,format,fit,maxBytes,width,fps,start,end,speed,reverse}` → `GET /api/gif/<id>.<gif\|webp>` | Converts with ffmpeg (`format` gif/webp, `fit` none/square/sticker, `maxBytes` 64 KB–15 MB, default 5 MB). Finished files are kept 15 min (max 2 min clips, 100 MB input, limited number of jobs at once). |

Rate limits are per IP and kept in memory (`server/rateLimit.js`).

## Adding another platform

Create `server/extractors/<name>.js` exporting `id`, `name`, `mediaHosts`, `match(url)` and `extract(url)`
(returning the same shape as `twitter.js`), then add it to the list in `server/extractors/index.js`.
The UI, proxy, GIF converter and host allow-list pick it up automatically.

## Ideas / roadmap

- More platforms: Reddit, Tumblr, Bluesky, Threads, Instagram, TikTok (Instagram and TikTok are the hardest: they need logins or change often)
- Mobile share target (PWA) so users can share straight from the X app
- Browser extension that adds a download button under tweets
- Download all media in a tweet (or a thread) as a ZIP
- Captions / meme text, GIF → MP4, video → MP3, save a frame as PNG, boomerang loops
- Separate SEO landing pages (/video-to-gif, /twitter-video-downloader, /gif-to-webp…)
- Telegram / Discord bot: send a link, get the file back
- Ads or a Pro tier (bigger GIFs, batch downloads, no limits)
- Redis-backed cache and rate limits so several servers can run at once
