// Run: node server/test.js   (no Notion account needed; Notion is mocked)
"use strict";
const assert = require("assert");
const { createClient, taskToProps, pageToTask } = require("./notion");
const { createServer } = require("./index");

const DS = "300f4efd-0e5f-4233-bb45-01b97f2d00a5";
const PAGE_ID = "3fbaea2e-e8d5-81d6-9b1f-dfe133fa4de3";

function fakePage(id, props) {
  return {
    id, url: "https://www.notion.so/" + id.replace(/-/g, ""), last_edited_time: "2026-10-15T00:00:00Z",
    parent: { type: "data_source_id", data_source_id: DS },
    properties: {
      Task: { title: [{ plain_text: props.title }] },
      Status: { status: { name: props.status || "To do" } },
      Owner: { select: props.owner ? { name: props.owner } : null },
      Area: { select: { name: props.area || "Recruitment" } },
      Priority: { select: { name: "High" } },
      Due: { date: props.due ? { start: props.due } : null },
      Notes: { rich_text: [{ plain_text: props.note || "" }] },
      "Canvas X": { number: props.x ?? null },
      "Canvas Y": { number: null }
    }
  };
}

function mockFetch(log) {
  return async (url, init) => {
    log.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.endsWith("/data_sources/" + DS + "/query")) {
      return ok({ results: [fakePage(PAGE_ID, { title: "Promote applications", due: "2026-10-25", x: 120 })], has_more: false });
    }
    if (url.endsWith("/data_sources/" + DS)) {
      return ok({ properties: { Owner: { select: { options: [{ name: "John Vu" }, { name: "Nathan Yu" }] } }, Area: { select: { options: [{ name: "Recruitment" }] } }, Priority: { select: { options: [{ name: "High" }] } } } });
    }
    if (url.endsWith("/pages") && init.method === "POST") return ok(fakePage("11111111-2222-3333-4444-555555555555", { title: "New one" }));
    if (url.includes("/pages/") && init.method === "GET") return ok(fakePage(PAGE_ID, { title: "Promote applications" }));
    if (url.includes("/pages/") && init.method === "PATCH") return ok(fakePage(PAGE_ID, { title: "Promote applications", status: "Done" }));
    return { ok: false, status: 404, json: async () => ({ message: "nope" }) };
  };
}

(async () => {
  // Mapping
  const t = pageToTask(fakePage(PAGE_ID, { title: "Promote applications", owner: "John Vu", due: "2026-10-25", note: "hi", x: 40 }));
  assert.deepStrictEqual([t.title, t.status, t.owner, t.due, t.note, t.x, t.y], ["Promote applications", "todo", "John Vu", "2026-10-25", "hi", 40, null]);

  const props = taskToProps({ title: "  Flyers ", status: "doing", owner: "", due: "", x: 10.6 });
  assert.strictEqual(props.Task.title[0].text.content, "Flyers");
  assert.strictEqual(props.Status.status.name, "In progress");
  assert.strictEqual(props.Owner.select, null);
  assert.strictEqual(props.Due.date, null);
  assert.strictEqual(props["Canvas X"].number, 11);
  assert.throws(() => taskToProps({ status: "later" }), /Status/);
  assert.throws(() => taskToProps({ due: "Oct 25" }), /Due/);
  assert.throws(() => taskToProps({}, { creating: true }), /title/);
  assert.throws(() => taskToProps({ owner: "a,b" }), /comma/);

  // Client
  const log = [];
  const client = createClient({ token: "test", dataSourceId: DS, fetchImpl: mockFetch(log) });
  const list = await client.listTasks();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(log[0].headers["Notion-Version"], "2025-09-03");
  const created = await client.createTask({ title: "New one", area: "Admin" });
  assert.strictEqual(created.title, "New one");
  const createCall = log.find((c) => c.url.endsWith("/pages"));
  assert.deepStrictEqual(createCall.body.parent, { type: "data_source_id", data_source_id: DS });
  assert.strictEqual(createCall.body.properties.Status.status.name, "To do");
  const updated = await client.updateTask(PAGE_ID, { status: "done" });
  assert.strictEqual(updated.status, "done");
  await assert.rejects(client.updateTask("not-an-id", { status: "done" }), /Unknown/);

  // HTTP server
  const server = createServer({ TEAM_CODE: "bayu-2026", ALLOWED_ORIGINS: "https://cloudietuan.github.io" }, { notion: client });
  await new Promise((r) => server.listen(0, r));
  const base = "http://127.0.0.1:" + server.address().port;
  const origin = { Origin: "https://cloudietuan.github.io" };

  let r = await fetch(base + "/api/tasks", { headers: origin });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("access-control-allow-origin"), "https://cloudietuan.github.io");
  const body = await r.json();
  assert.deepStrictEqual(body.options.people, ["John Vu", "Nathan Yu"]);

  r = await fetch(base + "/api/tasks", { headers: { Origin: "https://evil.example" } });
  assert.strictEqual(r.headers.get("access-control-allow-origin"), null);

  r = await fetch(base + "/api/tasks", { method: "OPTIONS", headers: origin });
  assert.strictEqual(r.status, 204);

  r = await fetch(base + "/api/tasks", { method: "POST", headers: { ...origin, "Content-Type": "application/json" }, body: JSON.stringify({ title: "x" }) });
  assert.strictEqual(r.status, 401);

  r = await fetch(base + "/api/tasks", { method: "POST", headers: { ...origin, "Content-Type": "application/json", "X-Team-Code": "bayu-2026" }, body: JSON.stringify({ title: "New one" }) });
  assert.strictEqual(r.status, 201);

  r = await fetch(base + "/api/tasks/" + PAGE_ID, { method: "PATCH", headers: { ...origin, "Content-Type": "application/json", "X-Team-Code": "bayu-2026" }, body: JSON.stringify({ status: "nope" }) });
  assert.strictEqual(r.status, 400);

  r = await fetch(base + "/api/tasks/" + PAGE_ID, { method: "PATCH", headers: { ...origin, "Content-Type": "application/json", "X-Team-Code": "bayu-2026" }, body: JSON.stringify({ status: "done", x: 300, y: 200 }) });
  assert.strictEqual(r.status, 200);

  server.close();
  console.log("All server tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
