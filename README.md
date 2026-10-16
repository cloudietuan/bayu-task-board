# Bayu Member Board

Bayu Consulting's shared to-do list. One list, four ways to look at it, and it stays in sync with Notion, so members, Claude, and other apps all work off the same tasks.

**Views**

| View | Good for |
|---|---|
| Board | To do / In progress / Done columns. Drag a card to move it. |
| List | A checklist you can tick off, grouped by status. |
| Calendar | What's due when, plus everything without a date. |
| Canvas | A free-form board. Drag notes anywhere to group or brainstorm. Positions save for everyone. |

Every view has a filter by person, and anyone with the team code can add or edit tasks.

## How it fits together

```
 Members' phones/laptops ──► GitHub Pages site (docs/)
                                   │  reads + writes
                                   ▼
                         Task server (server/, on Render)
                                   │  Notion API
                                   ▼
            Notion "Task Board" database  ◄── Claude (Notion connector)
                                          ◄── Zapier, Slack, Google Calendar…
```

- **The data lives in Notion.** The site never stores tasks itself.
- **The task server** keeps the Notion key secret. The website is public, so the key can't live in it.
- **Writes need the team code**, so a stranger who finds the link can look but can't change anything.

## One-time setup (about 15 minutes)

### 1. Make a Notion key
1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and create an **internal integration** called "Bayu Task Board".
2. Copy its secret. Keep it private; it goes on Render only, never in this repo.
3. In Notion, open the **Bayu Consulting** page, click **⋯ → Connections**, and add "Bayu Task Board". This lets the server see the Task Board.

### 2. Run the task server on Render (free)
1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Blueprint**, pick this repo. Render reads `render.yaml`.
3. When it asks for environment variables, fill in:
   - `NOTION_TOKEN`: the Notion secret from step 1
   - `TEAM_CODE`: any phrase you'll give members (for example a word only the club knows)
4. Deploy. Copy the service address, like `https://bayu-task-server.onrender.com`.
5. Check `https://<your-address>/api/health` shows `"notion":true,"writes":true`.

Free Render servers sleep after 15 minutes without visits, so the first load after a quiet stretch takes about a minute. Upgrading the server to the cheapest paid plan removes that.

### 3. Point the site at the server
Edit `docs/config.js` on GitHub and set:

```js
apiBase: "https://bayu-task-server.onrender.com",
```

Commit. The site updates in about a minute. The dot at the top turns green and says **Live from Notion**.

Until step 3 is done, the site shows the read-only snapshot in `docs/tasks.json`.

## Using it with Claude

Claude already connects to the Notion Task Board, so in any Claude chat you can say things like:

- "Add a task for Nathan to book the room for Friday's meeting, due Oct 20."
- "What's overdue on the Bayu board?"
- "Mark the flyers task done."

Changes show up on the site within 30 seconds.

## Connecting other apps

Because the list lives in Notion, anything that connects to Notion works:

- **Slack:** Notion's Slack app can post when tasks change.
- **Google Calendar:** Notion Calendar shows the Task Board's due dates.
- **Zapier / Make:** use the Notion "New database item" or "Update database item" triggers and actions, for example turning a Google Form response into a task.

Apps that can call a web address can also use the task server directly:

| Do this | Request |
|---|---|
| List tasks | `GET /api/tasks` |
| Add a task | `POST /api/tasks` with header `X-Team-Code` and JSON `{"title": "...", "owner": "...", "area": "...", "due": "2026-10-25"}` |
| Update a task | `PATCH /api/tasks/<id>` with header `X-Team-Code` and any of `title, status (todo/doing/done), owner, area, priority, due, note` |

## Changing things

- **Header facts** (deadline, meeting time): edit `docs/config.js`.
- **People, areas, priorities:** add them as options on the Notion Task Board. The site picks them up automatically.
- **Colors and fonts** follow the Bayu Consulting design system (Home v7) in `docs/style.css`.

## Developing

No build step and no dependencies. Node 18 or newer.

```bash
npm test                 # server tests with a mocked Notion
NOTION_TOKEN=... TEAM_CODE=... ALLOWED_ORIGINS=http://localhost:8000 npm start
cd docs && python3 -m http.server 8000   # then set apiBase to http://localhost:8787
```
