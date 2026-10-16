// Talks to the Notion Task Board. No dependencies; needs Node 18+ (built-in fetch).
"use strict";

const NOTION_VERSION = "2025-09-03";
const API = "https://api.notion.com/v1";

// Notion status names <-> the short ids the site uses.
const STATUS_TO_ID = { "To do": "todo", "In progress": "doing", "Done": "done" };
const ID_TO_STATUS = { todo: "To do", doing: "In progress", done: "Done" };

const PROP = {
  title: "Task",
  status: "Status",
  owner: "Owner",
  area: "Area",
  priority: "Priority",
  due: "Due",
  note: "Notes",
  x: "Canvas X",
  y: "Canvas Y"
};

function plain(rich) {
  return (rich || []).map((r) => r.plain_text || (r.text && r.text.content) || "").join("");
}

// Notion page -> the task shape the site uses.
function pageToTask(page) {
  const p = page.properties || {};
  const get = (name) => p[name] || {};
  const status = get(PROP.status).status;
  const num = (name) => (typeof get(name).number === "number" ? get(name).number : null);
  return {
    id: page.id,
    url: page.url,
    title: plain(get(PROP.title).title),
    status: (status && STATUS_TO_ID[status.name]) || "todo",
    owner: (get(PROP.owner).select && get(PROP.owner).select.name) || "",
    area: (get(PROP.area).select && get(PROP.area).select.name) || "",
    priority: (get(PROP.priority).select && get(PROP.priority).select.name) || "Normal",
    due: (get(PROP.due).date && get(PROP.due).date.start ? get(PROP.due).date.start.slice(0, 10) : ""),
    note: plain(get(PROP.note).rich_text),
    x: num(PROP.x),
    y: num(PROP.y),
    edited: page.last_edited_time || ""
  };
}

const LIMITS = { title: 200, note: 2000, select: 60 };

function cleanText(v, max) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f]/g, " ").trim();
  return s.length ? s.slice(0, max) : "";
}

// Site fields -> Notion properties. Only fields present in `input` are written.
// Throws an Error with .status = 400 for bad input.
function taskToProps(input, { creating } = {}) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!input || typeof input !== "object") throw bad("Send the task as a JSON object.");
  const props = {};

  if ("title" in input) {
    const t = cleanText(input.title, LIMITS.title);
    if (!t) throw bad("A task needs a title.");
    props[PROP.title] = { title: [{ text: { content: t } }] };
  } else if (creating) {
    throw bad("A task needs a title.");
  }

  if ("status" in input) {
    const name = ID_TO_STATUS[input.status];
    if (!name) throw bad("Status must be todo, doing, or done.");
    props[PROP.status] = { status: { name } };
  } else if (creating) {
    props[PROP.status] = { status: { name: "To do" } };
  }

  for (const key of ["owner", "area", "priority"]) {
    if (!(key in input)) continue;
    const v = cleanText(input[key], LIMITS.select);
    if (v === null) throw bad(key + " must be text.");
    if (v.includes(",")) throw bad(key + " can't contain a comma.");
    props[PROP[key]] = { select: v ? { name: v } : null };
  }

  if ("due" in input) {
    const d = input.due;
    if (d && !(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))) throw bad("Due must look like 2026-10-25.");
    props[PROP.due] = { date: d ? { start: d } : null };
  }

  if ("note" in input) {
    const n = cleanText(input.note, LIMITS.note);
    if (n === null) throw bad("note must be text.");
    props[PROP.note] = { rich_text: n ? [{ text: { content: n } }] : [] };
  }

  for (const key of ["x", "y"]) {
    if (!(key in input)) continue;
    const v = input[key];
    if (v !== null && !(typeof v === "number" && isFinite(v) && Math.abs(v) < 100000)) throw bad(key + " must be a number.");
    props[PROP[key]] = { number: v === null ? null : Math.round(v) };
  }

  if (!Object.keys(props).length) throw bad("Nothing to change.");
  return props;
}

function createClient({ token, dataSourceId, fetchImpl }) {
  const f = fetchImpl || fetch;
  async function call(method, path, body) {
    const res = await f(API + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || "Notion request failed (" + res.status + ")");
      err.status = res.status === 404 ? 404 : 502;
      err.notionStatus = res.status;
      throw err;
    }
    return data;
  }

  return {
    async listTasks() {
      const tasks = [];
      let cursor;
      for (let i = 0; i < 20; i++) {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const data = await call("POST", "/data_sources/" + dataSourceId + "/query", body);
        (data.results || []).forEach((pg) => { if (!pg.in_trash && !pg.archived) tasks.push(pageToTask(pg)); });
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      return tasks;
    },
    async getOptions() {
      const ds = await call("GET", "/data_sources/" + dataSourceId);
      const props = ds.properties || {};
      const opts = (name) => ((props[name] && props[name].select && props[name].select.options) || []).map((o) => o.name);
      return { people: opts(PROP.owner), areas: opts(PROP.area), priorities: opts(PROP.priority) };
    },
    async createTask(input) {
      const page = await call("POST", "/pages", {
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: taskToProps(input, { creating: true })
      });
      return pageToTask(page);
    },
    async updateTask(id, input) {
      if (!/^[0-9a-f-]{32,36}$/i.test(id)) throw Object.assign(new Error("Unknown task."), { status: 404 });
      // Make sure the page belongs to this board before changing it.
      const current = await call("GET", "/pages/" + id);
      const parent = current.parent || {};
      const parentId = (parent.data_source_id || "").replace(/-/g, "");
      if (parentId !== dataSourceId.replace(/-/g, "")) throw Object.assign(new Error("Unknown task."), { status: 404 });
      const page = await call("PATCH", "/pages/" + id, { properties: taskToProps(input) });
      return pageToTask(page);
    }
  };
}

module.exports = { createClient, pageToTask, taskToProps, PROP };
