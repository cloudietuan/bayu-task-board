// Bayu task server: a small bridge between the website and the Notion Task Board.
//
// Environment variables (set these on Render, never in the code):
//   NOTION_TOKEN        Internal integration secret from notion.so/profile/integrations
//   NOTION_DATA_SOURCE  Task Board data source id (default below)
//   TEAM_CODE           Shared code members type once to add or edit tasks
//   ALLOWED_ORIGINS     Comma-separated site origins, e.g. https://cloudietuan.github.io
//   PORT                Set by Render automatically
"use strict";

const http = require("http");
const crypto = require("crypto");
const { createClient } = require("./notion");

const DEFAULT_DATA_SOURCE = "300f4efd-0e5f-4233-bb45-01b97f2d00a5";

function sameCode(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function createServer(env, deps = {}) {
  const notion = deps.notion || createClient({
    token: env.NOTION_TOKEN,
    dataSourceId: env.NOTION_DATA_SOURCE || DEFAULT_DATA_SOURCE
  });
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const teamCode = env.TEAM_CODE || "";

  // Short cache so a room full of members opening the site doesn't hammer Notion.
  let cache = { at: 0, body: null };
  const CACHE_MS = 5000;

  // Very small rate limit on writes: 60 per minute per IP.
  const hits = new Map();
  function tooMany(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
    list.push(now);
    hits.set(ip, list);
    return list.length > 60;
  }

  function send(res, status, data, origin) {
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (origin && (origins.includes(origin) || origins.includes("*"))) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0, chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > 20000) { reject(Object.assign(new Error("Request too large."), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
        catch (e) { reject(Object.assign(new Error("Body must be JSON."), { status: 400 })); }
      });
      req.on("error", reject);
    });
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      const ok = origin && (origins.includes(origin) || origins.includes("*"));
      res.writeHead(ok ? 204 : 403, ok ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Team-Code",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin"
      } : {});
      return res.end();
    }

    try {
      if (req.method === "GET" && path === "/api/health") {
        return send(res, 200, { ok: true, notion: !!env.NOTION_TOKEN, writes: !!teamCode }, origin);
      }

      if (req.method === "GET" && path === "/api/tasks") {
        if (!cache.body || Date.now() - cache.at > CACHE_MS) {
          const [tasks, options] = await Promise.all([notion.listTasks(), notion.getOptions()]);
          cache = { at: Date.now(), body: { tasks, options, fetchedAt: new Date().toISOString() } };
        }
        return send(res, 200, cache.body, origin);
      }

      const isCreate = req.method === "POST" && path === "/api/tasks";
      const m = path.match(/^\/api\/tasks\/([0-9a-fA-F-]{32,36})$/);
      const isUpdate = req.method === "PATCH" && m;

      if (isCreate || isUpdate) {
        if (!teamCode) return send(res, 503, { error: "Editing is off until TEAM_CODE is set on the server." }, origin);
        const code = req.headers["x-team-code"] || "";
        if (!code || !sameCode(code, teamCode)) return send(res, 401, { error: "That team code isn't right." }, origin);
        const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        if (tooMany(ip)) return send(res, 429, { error: "Too many changes at once. Wait a minute and try again." }, origin);

        const body = await readBody(req);
        const task = isCreate ? await notion.createTask(body) : await notion.updateTask(m[1], body);
        cache = { at: 0, body: null };
        return send(res, isCreate ? 201 : 200, { task }, origin);
      }

      return send(res, 404, { error: "Not found." }, origin);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      const msg = status >= 500 && status !== 502 ? "Something went wrong on the server." : err.message;
      return send(res, status, { error: msg }, origin);
    }
  });
}

if (require.main === module) {
  if (!process.env.NOTION_TOKEN) console.warn("NOTION_TOKEN is not set. /api/tasks will fail until it is.");
  const port = Number(process.env.PORT) || 8787;
  createServer(process.env).listen(port, () => console.log("Bayu task server on port " + port));
}

module.exports = { createServer };
