// Bayu Consulting member board.
// Live mode: reads and writes the Notion Task Board through the task server (config.js -> apiBase).
// Snapshot mode: no server yet, shows tasks.json read-only.
(function () {
  "use strict";

  var cfg = window.BAYU_CONFIG || {};
  var API = (cfg.apiBase || "").replace(/\/+$/, "");
  var STATUSES = [
    { id: "todo", label: "To do" },
    { id: "doing", label: "In progress" },
    { id: "done", label: "Done" }
  ];
  var STATUS_LABEL = { todo: "To do", doing: "In progress", done: "Done" };
  var DEFAULT_AREAS = ["Recruitment", "Marketing", "Website", "Admin", "Clients", "Partnerships"];
  var DEFAULT_PRIORITIES = ["High", "Normal", "Low"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var MON = MONTHS.map(function (m) { return m.slice(0, 3); });
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var NOTE_W = 220, CANVAS_W = 2200, CANVAS_H = 1400;

  var state = { tasks: [], options: { people: [], areas: DEFAULT_AREAS, priorities: DEFAULT_PRIORITIES }, mode: "loading", fetchedAt: null, updated: "" };
  var ui = { view: "board", filter: "", month: null, editing: null, busy: false, dragging: false };

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function store(key, val) { try { if (val === undefined) return localStorage.getItem(key); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val); } catch (e) { return null; } }

  // ---------- dates ----------
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function today() { return iso(new Date()); }
  function parseDay(s) { return s ? new Date(s + "T12:00:00") : null; }
  function fmtDay(s) { var d = parseDay(s); return d ? DAYS[d.getDay()] + ", " + MON[d.getMonth()] + " " + d.getDate() : ""; }
  function dayDiff(due) { var a = parseDay(due), b = parseDay(today()); return a && b ? Math.round((a - b) / 86400000) : null; }
  function dueInfo(t) {
    if (!t.due) return null;
    var n = dayDiff(t.due);
    if (t.status === "done") return { cls: "", text: fmtDay(t.due) };
    if (n < 0) return { cls: "late", text: "Overdue · " + fmtDay(t.due) };
    if (n === 0) return { cls: "soon", text: "Due today" };
    if (n <= 7) return { cls: "soon", text: "Due " + fmtDay(t.due) };
    return { cls: "", text: "Due " + fmtDay(t.due) };
  }
  function byDue(a, b) {
    var x = a.due || "9999-12-31", y = b.due || "9999-12-31";
    if (x !== y) return x < y ? -1 : 1;
    return (a.priority === "High" ? 0 : 1) - (b.priority === "High" ? 0 : 1);
  }

  // ---------- data ----------
  function api(path) { return API + path; }

  function normalize(t) {
    return {
      id: String(t.id), url: t.url || "", title: t.title || "Untitled", status: STATUS_LABEL[t.status] ? t.status : "todo",
      owner: t.owner || "", area: t.area || "", priority: t.priority || "Normal", due: t.due || "", note: t.note || "",
      x: typeof t.x === "number" ? t.x : null, y: typeof t.y === "number" ? t.y : null
    };
  }

  function loadSnapshot(reason) {
    return fetch("tasks.json", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (data) {
      state.tasks = (data.tasks || []).map(normalize);
      state.options.people = data.people || [];
      state.updated = data.updated || "";
      state.mode = "snapshot";
      state.snapshotReason = reason || "";
    });
  }

  function loadLive() {
    return fetch(api("/api/tasks"), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    }).then(function (data) {
      state.tasks = (data.tasks || []).map(normalize);
      var o = data.options || {};
      state.options = {
        people: (o.people || []).filter(function (p) { return p !== "Everyone"; }).concat((o.people || []).indexOf("Everyone") >= 0 ? ["Everyone"] : []),
        areas: o.areas && o.areas.length ? o.areas : DEFAULT_AREAS,
        priorities: o.priorities && o.priorities.length ? o.priorities : DEFAULT_PRIORITIES
      };
      state.fetchedAt = new Date();
      state.mode = "live";
    });
  }

  function load() {
    var p = API ? loadLive().catch(function () { return loadSnapshot("unreachable"); }) : loadSnapshot("no-server");
    return p.catch(function () { state.mode = "error"; }).then(renderAll);
  }

  // Pick up changes made in Notion, by Claude, or by other apps.
  setInterval(function () {
    if (state.mode !== "live" || document.hidden || ui.busy || ui.dragging || $("editor").open) return;
    loadLive().then(renderAll).catch(function () {});
  }, 30000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.mode === "live" && !ui.dragging && !$("editor").open) loadLive().then(renderAll).catch(function () {});
  });

  // ---------- writing ----------
  var codeResolver = null;
  function askCode(message) {
    return new Promise(function (resolve) {
      codeResolver = resolve;
      $("code-input").value = "";
      $("code-error").hidden = !message;
      $("code-error").textContent = message || "";
      $("code-dialog").showModal();
      $("code-input").focus();
    });
  }
  $("code-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("code-input").value.trim();
    if (!v) return;
    $("code-dialog").close();
    if (codeResolver) { codeResolver(v); codeResolver = null; }
  });
  $("code-dialog").addEventListener("close", function () { if (codeResolver) { codeResolver(null); codeResolver = null; } });

  function write(method, path, body, retried) {
    if (state.mode !== "live") {
      toast(state.mode === "snapshot" && state.snapshotReason === "unreachable"
        ? "Can't reach the task server right now, so changes can't be saved."
        : "Editing turns on once the task server is connected. Ask John.");
      return Promise.resolve(null);
    }
    var code = store("bayu-team-code");
    var ready = code ? Promise.resolve(code) : askCode();
    return ready.then(function (c) {
      if (!c) return null;
      return fetch(api(path), {
        method: method,
        headers: { "Content-Type": "application/json", "X-Team-Code": c },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 401 && !retried) {
            store("bayu-team-code", null);
            return askCode("That code didn't work. Try again.").then(function (c2) {
              if (!c2) return null;
              store("bayu-team-code", c2);
              return write(method, path, body, true);
            });
          }
          if (!r.ok) throw new Error(data.error || "Couldn't save. Try again.");
          store("bayu-team-code", c);
          return data.task ? normalize(data.task) : null;
        });
      });
    });
  }

  function updateTask(t, changes) {
    var before = {};
    Object.keys(changes).forEach(function (k) { before[k] = t[k]; t[k] = changes[k]; });
    renderAll();
    ui.busy = true;
    return write("PATCH", "/api/tasks/" + encodeURIComponent(t.id), changes).then(function (saved) {
      if (!saved) { Object.keys(before).forEach(function (k) { t[k] = before[k]; }); renderAll(); return null; }
      Object.assign(t, saved);
      renderAll();
      return saved;
    }).catch(function (err) {
      Object.keys(before).forEach(function (k) { t[k] = before[k]; });
      renderAll();
      toast(err.message);
      return null;
    }).then(function (r) { ui.busy = false; return r; });
  }

  // ---------- shared rendering ----------
  function visible() {
    return state.tasks.filter(function (t) {
      if (!ui.filter) return true;
      if (ui.filter === "__none") return !t.owner;
      return t.owner === ui.filter;
    });
  }
  function avatar(t) {
    return '<p class="owner"><span class="avatar' + (t.owner ? "" : " empty") + '" aria-hidden="true">' + esc(t.owner ? t.owner.charAt(0) : "?") + "</span>" + esc(t.owner || "Unassigned") + "</p>";
  }
  function dueChip(t) { var d = dueInfo(t); return d ? '<span class="due ' + d.cls + '">' + esc(d.text) + "</span>" : ""; }
  function areaClass(a) { var k = (a || "").toLowerCase(); return DEFAULT_AREAS.map(function (x) { return x.toLowerCase(); }).indexOf(k) >= 0 ? "note-" + k : "note-other"; }
  function findTask(id) { return state.tasks.filter(function (t) { return t.id === id; })[0]; }

  function renderChrome() {
    $("facts").innerHTML = (cfg.facts || []).map(function (f) {
      return '<li><span class="mono on-dark">' + esc(f.label) + "</span><span>" + esc(f.value) + "</span></li>";
    }).join("");

    var sync = $("sync"), txt = $("sync-text");
    sync.className = "sync " + state.mode;
    if (state.mode === "live") {
      txt.textContent = "Live from Notion · checked " + state.fetchedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } else if (state.mode === "snapshot") {
      txt.textContent = state.snapshotReason === "unreachable"
        ? "Can't reach the task server. Showing the saved snapshot from " + fmtDay(state.updated) + "."
        : "Snapshot from " + fmtDay(state.updated) + ". View only until the task server is connected.";
    } else if (state.mode === "error") {
      txt.textContent = "Couldn't load tasks. Refresh the page to try again.";
    }
    var nl = $("notion-link");
    nl.hidden = !cfg.notionUrl;
    nl.href = cfg.notionUrl || "#";

    var counts = { todo: 0, doing: 0, done: 0 }, week = 0;
    visible().forEach(function (t) {
      counts[t.status]++;
      var n = dayDiff(t.due);
      if (t.status !== "done" && n !== null && n <= 7) week++;
    });
    $("summary").innerHTML = stat("To do", counts.todo) + stat("In progress", counts.doing) + stat("Done", counts.done) + stat("Due in 7 days", week, true);

    var people = state.options.people.slice();
    state.tasks.forEach(function (t) { if (t.owner && people.indexOf(t.owner) < 0) people.push(t.owner); });
    var chips = [{ v: "", l: "Everyone" }].concat(people.map(function (p) { return { v: p, l: p === "Everyone" ? "Whole team" : p }; }), [{ v: "__none", l: "Unassigned" }]);
    $("chips").innerHTML = chips.map(function (c) {
      var on = ui.filter === c.v;
      return '<button type="button" class="chip' + (on ? " on" : "") + '" data-filter="' + esc(c.v) + '" aria-pressed="' + on + '">' + esc(c.l) + "</button>";
    }).join("");

    document.querySelectorAll(".tab").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-view") === ui.view)); });
    $("add-btn").disabled = state.mode !== "live";
    $("add-btn").title = state.mode === "live" ? "" : "Editing turns on once the task server is connected";
    $("updated").textContent = state.mode === "live" ? "Synced with Notion" : state.updated ? "Snapshot " + fmtDay(state.updated) : "";
  }
  function stat(label, n, hot) {
    return '<div class="stat' + (hot ? " stat-hot" : "") + '"><span class="mono">' + label + "</span><strong>" + n + "</strong></div>";
  }

  function renderAll() {
    renderChrome();
    var v = $("view");
    if (state.mode === "loading") { v.innerHTML = '<p class="empty">Loading tasks…</p>'; return; }
    if (state.mode === "error") { v.innerHTML = '<p class="empty">Couldn\'t load tasks. If you opened this file straight from your computer, use the GitHub Pages link instead.</p>'; return; }
    if (ui.view === "list") renderList(v);
    else if (ui.view === "calendar") renderCalendar(v);
    else if (ui.view === "canvas") renderCanvas(v);
    else renderBoard(v);
  }

  // ---------- board ----------
  function renderBoard(v) {
    var tasks = visible();
    var canEdit = state.mode === "live";
    v.innerHTML = '<div class="board">' + STATUSES.map(function (s) {
      var list = tasks.filter(function (t) { return t.status === s.id; });
      if (s.id !== "done") list.sort(byDue);
      return '<section class="col col-' + s.id + '" data-status="' + s.id + '" aria-labelledby="h-' + s.id + '">' +
        '<h2 class="col-head" id="h-' + s.id + '"><span class="display-s">' + s.label + '</span><span class="count">' + list.length + "</span></h2>" +
        '<ul class="cards">' + (list.length ? list.map(function (t) {
          return '<li class="card' + (t.status === "done" ? " is-done" : "") + '" tabindex="0" role="button" data-id="' + esc(t.id) + '"' + (canEdit ? ' draggable="true"' : "") + ">" +
            '<div class="card-top"><span class="area">' + esc(t.area) + "</span>" + (t.priority === "High" && t.status !== "done" ? '<span class="prio">High priority</span>' : "") + "</div>" +
            '<p class="card-title">' + esc(t.title) + "</p>" +
            (t.note ? '<p class="card-note">' + esc(t.note) + "</p>" : "") +
            '<div class="card-foot">' + avatar(t) + dueChip(t) + "</div></li>";
        }).join("") : '<li class="empty">' + (ui.filter ? "Nothing for this person here." : "Nothing here yet.") + "</li>") +
        "</ul></section>";
    }).join("") + "</div>";

    v.querySelectorAll(".card").forEach(function (card) {
      card.addEventListener("click", function () { openEditor(findTask(card.getAttribute("data-id"))); });
      card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); card.click(); } });
      card.addEventListener("dragstart", function (e) { e.dataTransfer.setData("text/plain", card.getAttribute("data-id")); card.classList.add("dragging"); ui.dragging = true; });
      card.addEventListener("dragend", function () { card.classList.remove("dragging"); ui.dragging = false; });
    });
    v.querySelectorAll(".col").forEach(function (col) {
      col.addEventListener("dragover", function (e) { e.preventDefault(); col.classList.add("drop"); });
      col.addEventListener("dragleave", function () { col.classList.remove("drop"); });
      col.addEventListener("drop", function (e) {
        e.preventDefault(); col.classList.remove("drop"); ui.dragging = false;
        var t = findTask(e.dataTransfer.getData("text/plain"));
        var s = col.getAttribute("data-status");
        if (t && t.status !== s) updateTask(t, { status: s }).then(function (r) { if (r) toast("Moved to " + STATUS_LABEL[s]); });
      });
    });
  }

  // ---------- list ----------
  function renderList(v) {
    var tasks = visible();
    var rows = STATUSES.map(function (s) {
      var list = tasks.filter(function (t) { return t.status === s.id; }).sort(byDue);
      if (!list.length) return "";
      return '<tr class="group"><td colspan="6">' + s.label + " · " + list.length + "</td></tr>" + list.map(function (t) {
        return '<tr class="' + (t.status === "done" ? "is-done" : "") + '">' +
          '<td><input type="checkbox" class="check" data-id="' + esc(t.id) + '" id="chk-' + esc(t.id) + '" aria-label="Mark done: ' + esc(t.title) + '"' + (t.status === "done" ? " checked" : "") + (state.mode === "live" ? "" : " disabled") + "></td>" +
          '<td><button type="button" class="title-btn" data-id="' + esc(t.id) + '">' + esc(t.title) + "</button></td>" +
          "<td>" + avatar(t) + "</td>" +
          '<td><span class="area">' + esc(t.area) + "</span></td>" +
          "<td>" + (dueChip(t) || '<span class="muted">No date</span>') + "</td>" +
          "<td>" + (t.priority === "High" ? '<span class="prio">High</span>' : '<span class="muted">' + esc(t.priority) + "</span>") + "</td></tr>";
      }).join("");
    }).join("");
    v.innerHTML = '<div class="table-wrap"><table class="list"><thead><tr><th style="width:48px"><span class="sr">Done</span></th><th>Task</th><th>Owner</th><th>Area</th><th>Due</th><th>Priority</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6"><p class="muted">Nothing for this person yet.</p></td></tr>') + "</tbody></table></div>";
    v.querySelectorAll(".title-btn").forEach(function (b) { b.addEventListener("click", function () { openEditor(findTask(b.getAttribute("data-id"))); }); });
    v.querySelectorAll(".check").forEach(function (c) {
      c.addEventListener("change", function () {
        var t = findTask(c.getAttribute("data-id"));
        if (t) updateTask(t, { status: c.checked ? "done" : "todo" });
      });
    });
  }

  // ---------- calendar ----------
  function renderCalendar(v) {
    if (!ui.month) {
      var now = new Date();
      ui.month = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    var m = ui.month, first = new Date(m.getFullYear(), m.getMonth(), 1);
    var start = new Date(first); start.setDate(1 - first.getDay());
    var tasks = visible(), t0 = today();
    var byDay = {};
    tasks.forEach(function (t) { if (t.due) (byDay[t.due] = byDay[t.due] || []).push(t); });

    var cells = DAYS.map(function (d) { return '<div class="cal-dow">' + d + "</div>"; }).join("");
    for (var i = 0; i < 42; i++) {
      var d = new Date(start); d.setDate(start.getDate() + i);
      var key = iso(d), out = d.getMonth() !== m.getMonth();
      var items = (byDay[key] || []).sort(byDue);
      cells += '<div class="cal-day' + (out ? " out" : "") + (key === t0 ? " today" : "") + '"><span class="cal-num">' + d.getDate() + "</span>" +
        items.map(function (t) {
          var late = t.status !== "done" && dayDiff(t.due) < 0;
          return '<button type="button" class="cal-task' + (t.status === "done" ? " done" : late ? " late" : "") + '" data-id="' + esc(t.id) + '" title="' + esc(t.title) + '">' + esc(t.title) + "</button>";
        }).join("") + "</div>";
    }
    var undated = tasks.filter(function (t) { return !t.due && t.status !== "done"; });
    v.innerHTML =
      '<div class="cal-head"><h2 class="display-s">' + MONTHS[m.getMonth()] + " " + m.getFullYear() + "</h2>" +
      '<div class="cal-nav"><button type="button" class="btn btn-ghost btn-sm" data-cal="-1">Previous</button><button type="button" class="btn btn-ghost btn-sm" data-cal="0">Today</button><button type="button" class="btn btn-ghost btn-sm" data-cal="1">Next</button></div></div>' +
      '<div class="cal-wrap"><div class="cal">' + cells + "</div></div>" +
      (undated.length ? '<div class="undated"><p class="mono">No due date · ' + undated.length + "</p><ul>" + undated.map(function (t) {
        return '<li><button type="button" class="cal-task" data-id="' + esc(t.id) + '">' + esc(t.title) + "</button></li>";
      }).join("") + "</ul></div>" : "");

    v.querySelectorAll("[data-cal]").forEach(function (b) {
      b.addEventListener("click", function () {
        var step = Number(b.getAttribute("data-cal"));
        if (step === 0) { var n = new Date(); ui.month = new Date(n.getFullYear(), n.getMonth(), 1); }
        else ui.month = new Date(ui.month.getFullYear(), ui.month.getMonth() + step, 1);
        renderAll();
      });
    });
    v.querySelectorAll(".cal-task").forEach(function (b) { b.addEventListener("click", function () { openEditor(findTask(b.getAttribute("data-id"))); }); });
  }

  // ---------- canvas ----------
  function autoPositions(tasks) {
    var areas = state.options.areas.slice();
    tasks.forEach(function (t) { if (t.area && areas.indexOf(t.area) < 0) areas.push(t.area); });
    var rows = {}, pos = {};
    tasks.forEach(function (t) {
      if (t.x !== null && t.y !== null) { pos[t.id] = { x: t.x, y: t.y }; return; }
      var col = Math.max(0, areas.indexOf(t.area));
      rows[col] = (rows[col] || 0);
      pos[t.id] = { x: 32 + col * (NOTE_W + 36), y: 32 + rows[col] * 210 };
      rows[col]++;
    });
    return pos;
  }

  function renderCanvas(v) {
    var tasks = visible();
    var pos = autoPositions(state.tasks);
    var areas = state.options.areas;
    v.innerHTML =
      '<div class="canvas-head"><p class="muted">Drag notes anywhere to group, plan, or brainstorm. Click a note to edit it. Positions are saved for everyone.</p>' +
      '<div class="legend">' + areas.map(function (a) { return '<span><i class="' + areaClass(a) + '"></i>' + esc(a) + "</span>"; }).join("") + "</div></div>" +
      '<div class="canvas-scroll" id="canvas-scroll"><div class="canvas" id="canvas">' +
      tasks.map(function (t) {
        var p = pos[t.id];
        return '<div class="note ' + areaClass(t.area) + (t.status === "done" ? " is-done" : "") + '" tabindex="0" role="button" data-id="' + esc(t.id) + '" style="left:' + p.x + "px;top:" + p.y + 'px">' +
          '<div class="note-meta"><span class="area">' + esc(t.area) + '</span><span class="pill pill-' + t.status + '">' + STATUS_LABEL[t.status] + "</span></div>" +
          '<p class="note-title">' + esc(t.title) + "</p>" +
          '<div class="note-meta">' + avatar(t) + dueChip(t) + "</div></div>";
      }).join("") + "</div></div>";

    v.querySelectorAll(".note").forEach(bindNote);
  }

  var warnedLocalCanvas = false;
  function bindNote(el) {
    var start = null;
    el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEditor(findTask(el.getAttribute("data-id"))); } });
    el.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      start = { px: e.clientX, py: e.clientY, x: parseFloat(el.style.left), y: parseFloat(el.style.top), moved: false };
      ui.dragging = true;
    });
    el.addEventListener("pointermove", function (e) {
      if (!start) return;
      var dx = e.clientX - start.px, dy = e.clientY - start.py;
      if (!start.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      start.moved = true;
      el.classList.add("dragging");
      el.style.left = Math.max(0, Math.min(CANVAS_W - NOTE_W, start.x + dx)) + "px";
      el.style.top = Math.max(0, Math.min(CANVAS_H - 120, start.y + dy)) + "px";
    });
    function end() {
      if (!start) return;
      var s = start; start = null; ui.dragging = false;
      el.classList.remove("dragging");
      var t = findTask(el.getAttribute("data-id"));
      if (!t) return;
      if (!s.moved) { openEditor(t); return; }
      var x = Math.round(parseFloat(el.style.left)), y = Math.round(parseFloat(el.style.top));
      if (state.mode === "live") {
        ui.busy = true;
        write("PATCH", "/api/tasks/" + encodeURIComponent(t.id), { x: x, y: y }).then(function (saved) {
          if (saved) { t.x = saved.x; t.y = saved.y; }
        }).catch(function (err) { toast(err.message); }).then(function () { ui.busy = false; });
      } else {
        t.x = x; t.y = y;
        if (!warnedLocalCanvas) { toast("Moved on this screen only. Saving turns on with the task server."); warnedLocalCanvas = true; }
      }
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  // ---------- editor ----------
  function fillSelect(sel, values, current, blankLabel) {
    var list = values.slice();
    if (current && list.indexOf(current) < 0) list.push(current);
    sel.innerHTML = (blankLabel !== undefined ? '<option value="">' + esc(blankLabel) + "</option>" : "") +
      list.map(function (v) { return '<option value="' + esc(v) + '"' + (v === current ? " selected" : "") + ">" + esc(v) + "</option>"; }).join("");
    if (!current && blankLabel !== undefined) sel.value = "";
  }

  function openEditor(t) {
    if (!t && state.mode !== "live") { write(); return; }
    ui.editing = t || null;
    var readOnly = state.mode !== "live";
    $("editor-title").textContent = t ? (readOnly ? "Task" : "Edit task") : "New task";
    $("f-title").value = t ? t.title : "";
    $("f-status").value = t ? t.status : "todo";
    fillSelect($("f-owner"), state.options.people, t ? t.owner : (ui.filter && ui.filter !== "__none" ? ui.filter : ""), "Unassigned");
    fillSelect($("f-area"), state.options.areas, t ? t.area : state.options.areas[0]);
    fillSelect($("f-priority"), state.options.priorities, t ? t.priority : "Normal");
    $("f-due").value = t ? t.due : "";
    $("f-note").value = t ? t.note : "";
    $("f-error").hidden = true;
    $("editor-form").querySelectorAll("input,select,textarea").forEach(function (el) { el.disabled = readOnly; });
    $("f-save").hidden = readOnly;
    var link = $("f-notion");
    link.hidden = !(t && t.url);
    if (t && t.url) link.href = t.url;
    $("editor").showModal();
    if (!readOnly) $("f-title").focus();
  }

  $("editor-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = ui.editing;
    var data = {
      title: $("f-title").value.trim(),
      status: $("f-status").value,
      owner: $("f-owner").value,
      area: $("f-area").value,
      priority: $("f-priority").value,
      due: $("f-due").value,
      note: $("f-note").value.trim()
    };
    if (!data.title) { $("f-error").textContent = "Give the task a name."; $("f-error").hidden = false; return; }
    var save = $("f-save");
    save.disabled = true; save.textContent = "Saving…";
    var done = function () { save.disabled = false; save.textContent = "Save"; };

    if (t) {
      var changes = {};
      Object.keys(data).forEach(function (k) { if (data[k] !== t[k]) changes[k] = data[k]; });
      if (!Object.keys(changes).length) { done(); $("editor").close(); return; }
      ui.busy = true;
      write("PATCH", "/api/tasks/" + encodeURIComponent(t.id), changes).then(function (saved) {
        done(); ui.busy = false;
        if (!saved) return;
        Object.assign(t, saved);
        $("editor").close(); renderAll(); toast("Saved to Notion");
      }).catch(function (err) { done(); ui.busy = false; $("f-error").textContent = err.message; $("f-error").hidden = false; });
    } else {
      ui.busy = true;
      write("POST", "/api/tasks", data).then(function (saved) {
        done(); ui.busy = false;
        if (!saved) return;
        state.tasks.push(saved);
        $("editor").close(); renderAll(); toast("Added to Notion");
      }).catch(function (err) { done(); ui.busy = false; $("f-error").textContent = err.message; $("f-error").hidden = false; });
    }
  });
  document.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", function () { b.closest("dialog").close(); }); });

  // ---------- toast ----------
  var toastTimer;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 3800);
  }

  // ---------- controls ----------
  function setView(view) {
    if (["board", "list", "calendar", "canvas"].indexOf(view) < 0) view = "board";
    ui.view = view;
    store("bayu-view", view);
    if (location.hash.slice(1) !== view) history.replaceState(null, "", "#" + view);
    renderAll();
  }
  document.querySelector(".tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-view]"); if (b) setView(b.getAttribute("data-view"));
  });
  window.addEventListener("hashchange", function () { setView(location.hash.slice(1)); });
  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest("[data-filter]"); if (!b) return;
    ui.filter = b.getAttribute("data-filter");
    store("bayu-filter", ui.filter);
    renderAll();
  });
  $("add-btn").addEventListener("click", function () { openEditor(null); });

  ui.filter = store("bayu-filter") || "";
  ui.view = location.hash.slice(1) || store("bayu-view") || "board";
  renderAll();
  load();
})();
