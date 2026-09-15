/**
 * SaveReel backend
 *
 * Two endpoints:
 *   POST /api/media     -> resolves an Instagram URL into playable video formats
 *   GET  /api/download  -> streams a CDN file back with an attachment header
 *
 * Requires yt-dlp on the PATH:
 *   pip install -U yt-dlp        (or: brew install yt-dlp)
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const { execFile } = require("child_process");
const { pipeline } = require("stream/promises");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * CORS
 *
 * Your frontend (WordPress/Elementor, e.g. https://yourdomain.com) and this
 * backend (e.g. https://savereel-backend.onrender.com) live on different
 * domains, so the browser blocks requests unless the backend explicitly
 * allows them.
 *
 * Set ALLOWED_ORIGINS as a comma-separated env var to your real domain(s):
 *   ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
 *
 * If ALLOWED_ORIGINS is not set, it falls back to allowing all origins
 * (useful while testing, but tighten it before going live).
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!allowedOrigins.length) return callback(null, true); // no allowlist set yet
      if (!origin) return callback(null, true); // same-origin / server-to-server
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS: " + origin));
    }
  })
);

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------- */

const IG_URL_RE =
  /^https:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?$/;

// Only these hosts may be proxied by /api/download. Without this check the
// endpoint becomes an open proxy and can be pointed at internal addresses.
const ALLOWED_MEDIA_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;

function validateInstagramUrl(input) {
  if (typeof input !== "string") return null;
  const match = IG_URL_RE.exec(input.trim());
  if (!match) return null;
  return { type: match[1], shortcode: match[2], url: match[0] };
}

/* ---------------------------------------------------------------
 * Tiny in-memory cache + rate limit
 * ------------------------------------------------------------- */

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

const buckets = new Map();
const LIMIT = 20;              // requests
const WINDOW = 60 * 1000;      // per minute

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const bucket = buckets.get(ip) || { count: 0, resetAt: now + WINDOW };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + WINDOW;
  }

  bucket.count += 1;
  buckets.set(ip, bucket);

  if (bucket.count > LIMIT) {
    return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
  }
  next();
}

/* ---------------------------------------------------------------
 * yt-dlp
 * ------------------------------------------------------------- */

function runYtDlp(url) {
  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--no-call-home",
    "--socket-timeout", "20"
  ];

  // Some posts need a logged-in session. Export cookies.txt from a browser
  // and set IG_COOKIES to its path. Only use an account you own.
  if (process.env.IG_COOKIES) args.push("--cookies", process.env.IG_COOKIES);
  if (process.env.IG_PROXY) args.push("--proxy", process.env.IG_PROXY);

  args.push(url);

  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      args,
      { timeout: 40000, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message || "").toLowerCase();
          if (message.includes("login") || message.includes("private")) {
            return reject(Object.assign(new Error("This post is private or needs a login."), { status: 404 }));
          }
          if (message.includes("not found") || message.includes("404")) {
            return reject(Object.assign(new Error("This post is unavailable or was deleted."), { status: 404 }));
          }
          if (message.includes("rate") || message.includes("429")) {
            return reject(Object.assign(new Error("Instagram is rate limiting requests. Try again shortly."), { status: 429 }));
          }
          return reject(Object.assign(new Error("Could not resolve that link."), { status: 502 }));
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(Object.assign(new Error("Unexpected response from the media resolver."), { status: 502 }));
        }
      }
    );
  });
}

function normalise(info, shortcode) {
  // A carousel post comes back with entries; take the first video.
  const item = Array.isArray(info.entries) && info.entries.length ? info.entries[0] : info;

  const formats = (item.formats || [])
    .filter((f) => f.url && f.vcodec && f.vcodec !== "none")
    .map((f) => ({
      url: f.url,
      label: f.height ? f.height + "p" : (f.format_note || "Video"),
      height: f.height || 0,
      ext: f.ext || "mp4",
      filesize: f.filesize || f.filesize_approx || null
    }))
    .sort((a, b) => b.height - a.height);

  // Fall back to the single URL yt-dlp picked if no format list came back.
  if (!formats.length && item.url) {
    formats.push({ url: item.url, label: "Video", height: 0, ext: item.ext || "mp4", filesize: null });
  }

  // Drop duplicate resolutions.
  const seen = new Set();
  const unique = formats.filter((f) => {
    if (seen.has(f.label)) return false;
    seen.add(f.label);
    return true;
  });

  const title = (item.title || item.description || "Instagram video")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);

  return {
    title,
    author: item.uploader || item.channel || null,
    duration: item.duration || null,
    thumbnail: item.thumbnail || null,
    filename: "instagram-" + shortcode,
    formats: unique
  };
}

/* ---------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------- */

app.post("/api/media", rateLimit, async (req, res) => {
  const parsed = validateInstagramUrl(req.body && req.body.url);

  if (!parsed) {
    return res.status(400).json({ error: "Send a valid Instagram reel, post or IGTV URL." });
  }

  const cached = cacheGet(parsed.shortcode);
  if (cached) return res.json(cached);

  try {
    const info = await runYtDlp(parsed.url);
    const payload = normalise(info, parsed.shortcode);

    if (!payload.formats.length) {
      return res.status(404).json({ error: "That post has no downloadable video." });
    }

    cacheSet(parsed.shortcode, payload);
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/download", rateLimit, async (req, res) => {
  const src = req.query.src;
  const name = (req.query.name || "instagram-video.mp4").replace(/[^\w.\-]/g, "_");

  let target;
  try {
    target = new URL(src);
  } catch (e) {
    return res.status(400).send("Invalid source URL.");
  }

  if (target.protocol !== "https:" || !ALLOWED_MEDIA_HOSTS.test(target.hostname)) {
    return res.status(403).send("That host is not allowed.");
  }

  try {
    const upstream = await fetch(target.href, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.instagram.com/" }
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).send("The media file could not be fetched.");
    }

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '"');

    const length = upstream.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);

    // Lets the frontend read Content-Length when it is served cross-origin.
    res.setHeader("Access-Control-Expose-Headers", "Content-Length");

    await pipeline(upstream.body, res);
  } catch (err) {
    if (!res.headersSent) res.status(502).send("Streaming failed.");
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("SaveReel running on http://localhost:" + PORT);
});
