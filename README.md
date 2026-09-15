# SaveReel — setup

## 1. Install

```bash
# yt-dlp (the resolver the backend shells out to)
pip install -U yt-dlp        # or: brew install yt-dlp

# project deps
npm install
```

Node 18 or newer is required (the download proxy uses the built-in `fetch`).

## 2. Folder layout

```
savereel/
├── server.js
├── package.json
└── public/
    └── index.html
```

Put `index.html` inside a `public/` folder — Express serves it from there.

```bash
mkdir -p public && mv index.html public/
```

## 3. Run

```bash
npm start
# http://localhost:3000
```

## 4. Optional environment variables

| Variable     | What it does |
|--------------|--------------|
| `PORT`       | Port to listen on (default 3000). |
| `IG_COOKIES` | Path to a `cookies.txt` export. Needed for posts that require a logged-in session — use an account you own. |
| `IG_PROXY`   | Proxy URL passed to yt-dlp, useful if your server IP gets rate limited. |
| `ALLOWED_ORIGINS` | Comma-separated list of domains allowed to call this backend, e.g. `https://yourdomain.com,https://www.yourdomain.com`. Leave unset while testing (allows all origins); set it before going live. |

## What was added to the frontend

- URL parsing that accepts `/reel/`, `/reels/`, `/p/`, `/tv/` and links pasted without `https://`
- Live validation under the input, Enter-key submit, real paste button with a manual fallback
- Real `fetch` to `POST /api/media` with abort + 45s timeout, and status-specific error messages
- Result card with poster, inline preview, author, duration, and quality chips when several resolutions exist
- Save button that streams through `/api/download` and shows real byte progress, then saves a blob so the file lands in Downloads instead of opening a tab
- Copy direct link, recent-links list, and `?url=` support so the page works as a share target

## Notes on the backend

- `/api/download` only proxies `*.cdninstagram.com` / `*.fbcdn.net`. Keep that allowlist — without it the endpoint is an open proxy anyone can point at your internal network.
- Results are cached for 10 minutes per shortcode and requests are rate limited to 20/min per IP. Instagram throttles aggressively, so both matter once the site is public.
- Private posts will not resolve without cookies, and even then only if the account can see them.

One practical thing: downloading content you don't own and republishing it can get a public site DMCA'd, and Instagram's terms don't allow automated scraping. For your own reels, or content you have permission to save, this is fine.
