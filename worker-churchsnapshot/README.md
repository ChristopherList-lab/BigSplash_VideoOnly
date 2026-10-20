# Church Snapshot intake worker

A Cloudflare Worker that receives the Church Growth Snapshot form from the church page and puts the request in front of Chris.

## The job

A pastor submits the form. The worker then:

1. Checks the request: required fields, email shape, a real http(s) sermon link, the form's own choices for attendance and sermon source, a 20 KB size limit and a honeypot for bots.
2. Opens a ClickUp task named `<church>, <city>` in list `901421191181`, due 72 hours out, tagged `snapshot` and `website-form`. The description lists everything the pastor sent and a seven-step checklist.
3. Posts an alert to Slack with the church, the contact, the sermon link, the due time in Central and a link to the ClickUp task.
4. Forwards the cleaned request to GoHighLevel if `GHL_WEBHOOK_URL` is set. The payload adds `clickup_task`, `due_at`, `due_text` and `turnaround_hours`, so a GoHighLevel workflow can send the church its confirmation.
5. Answers the page with `{ ok, due_at, turnaround_hours, results }`. The thanks page shows the due time from `due_at`.

ClickUp goes first so Slack and GoHighLevel can carry the task link. One destination failing never blocks the others. If ClickUp fails, the Slack alert ends with `ClickUp task FAILED: add it by hand`.

Each morning at 13:00 UTC the worker reads the list and posts one Slack digest: overdue snapshots, snapshots due in the next 24 hours, other open ones, and deliveries from the last 24 hours. A morning with nothing open and nothing delivered gets no message. If ClickUp cannot be read, Slack gets a one-line note saying so.

The worker sends nothing to the church itself. The church sees the thanks page, and GoHighLevel sends the confirmation email or text once you build that workflow.

## LeadDesk: Front Door audit leads

The same deployed worker also runs LeadDesk, a named entrypoint in `entry.js`. The Front Door worker (`../worker-frontdoor/`) calls it after each audit over a Cloudflare service binding. LeadDesk has no public route: only a worker on Chris's Cloudflare account with the binding can reach it.

The Front Door worker binds to it with this block in its own `wrangler.toml`:

```
[[services]]
binding = "DESK"
service = "bigsplash-church-snapshot"
entrypoint = "LeadDesk"
```

and calls `await env.DESK.frontDoorLead(lead)`. The reply is `{ clickup: { ok, id?, url? }, slack: { ok } }`. The call never throws for a ClickUp or Slack failure. Deploy this worker first, so the binding has something to point at.

Per event:

| `lead.event` | ClickUp (list `FRONT_DOOR_LIST_ID`, "Front Door Leads") | Slack headline |
| --- | --- | --- |
| `ready` | New task | New Front Door lead |
| `review` | New task that opens with "Held for your review": reasons, possible duplicate listings, the preview link and an "Approve and send" link | Front Door audit needs your review |
| `failed` | New task that opens with "The audit failed. Run it by hand and email the pastor." and the error | Front Door audit failed |
| `approved` | A comment ("Approved. The scorecard went to the pastor.") on `clickup_task_id`. With no task id, a new task as for `ready` | Front Door audit approved |

Each new task is named `<church>, <city>` (the address stands in for a missing city), tagged `front-door` and `audit`, priority high, assigned to `CLICKUP_ASSIGNEE_IDS`, and due 5 PM the next weekday in `TIMEZONE`. A Friday evening lead is due Monday at 5 PM. The description holds the contact (email and phone as links, texts OK yes or no, attendance, the Facebook answer), the church, the grades table ("Not checked" for an area the audit skipped), the top fixes, households nearby, the scorecard and walkthrough links, the UTM source, campaign and content, the page, and a four-step checklist: text or call within 24 hours, walkthrough booked, proposal sent, won or lost.

The Slack alert names the church, city and overall grade, the contact, attendance, the ClickUp link, the scorecard link (or the preview and approve links for `review`) and the UTM campaign.

LeadDesk cleans and escapes every value the same way the intake does, because the contact fields come from a public form and the church name comes from Google. A typed address never becomes a link: LeadDesk breaks `://` and puts a space before each domain dot, so `www.evil.com` reads `www .evil .com` in ClickUp and Slack. Email and texts to the pastor go through GoHighLevel, never through LeadDesk.

### Founding partners: `won` and `billing`

The Front Door worker's founding checkout (Stripe) sends two more events through the same `frontDoorLead` call.

| `lead.event` | ClickUp | Slack headline |
| --- | --- | --- |
| `won` | New task `Onboard <church>: founding partner` in `CHURCH_CLIENTS_LIST_ID` ("Church Clients"), priority urgent, due 5 PM two weekdays out, tagged `founding-partner` and `onboarding`. The description holds the contact, the term and monthly amount, the amount paid, the Stripe customer (linked to the dashboard), the checkout session, the agreement summary, the "Start monthly billing" link and a seven-step onboarding checklist | New founding partner |
| `billing` | A comment on `clickup_task_id` when the call names one; Slack only otherwise. `kind` is `started`, `invoice_paid`, `invoice_failed`, `canceled`, `bank_processing` or `bank_failed`, and `message` is the line Chris reads | Per kind, for example "Monthly billing set" |

Both events get the same cleaning and the same `DESK_SEEN` repeat protection, keyed `desk:won:<checkout session id>` and `desk:billing:<kind>-<Stripe id>`.

### Repeated calls

The Front Door worker calls LeadDesk from a Workflow step with retries, and Cloudflare can run a step twice. LeadDesk remembers each delivery for four days in the `DESK_SEEN` KV namespace: `desk:<event>:<audit id>` once ClickUp takes it, and `desk:<event>:<audit id>:slack` once Slack takes it. A second call with the same event and audit id gets the first result back and sends nothing twice. A destination that failed the first time gets tried again on the repeat, and a Slack retry still carries the saved task link. A double click on the approve link posts one comment and one alert.

Two calls landing in the same second can both get through, because KV is not a lock. An audit with no id, or a deploy with no `DESK_SEEN` binding, gets no protection, and the log says so.

### Who posts the Slack alert

LeadDesk owns the Slack alert for `ready`, `review`, `failed` and `approved`. Before the Front Door worker deploys with the `DESK` binding, its own Slack posts for those events have to go: the "Front Door Audit sent", "needs your review" and "failed" alerts in `../worker-frontdoor/src/worker.js`. Leave them in and every audit posts two alerts with two different approve links.

The Front Door worker keeps two Slack posts of its own:

1. "Front Door Audit email did not send". LeadDesk never hears how the GoHighLevel send went.
2. A fallback when `env.DESK.frontDoorLead` throws, which means the binding or the deploy is broken and LeadDesk posted nothing.

For `review`, pass the approve link the Front Door worker builds from its review token as `approve_url`. LeadDesk prints that link as given, so Chris sees one approve link in ClickUp and Slack.

The morning digest adds a section, "Front Door leads waiting on a first touch": tasks in `FRONT_DOOR_LIST_ID` still in status `to do` more than 24 hours after they were created, oldest first, plus the count of new leads in the last 24 hours. A morning with no snapshots to report and no Front Door leads posts nothing.

### Routes

| Route | Purpose |
| --- | --- |
| `POST /` or `POST /intake` | The form intake |
| `GET /health` | Shows which destinations are configured, as true or false. Never shows a secret. |
| `OPTIONS` anything | CORS preflight |

### Replies from the intake

| Status | Meaning |
| --- | --- |
| 200 | At least one destination accepted the request |
| 400 | A field is missing or wrong. The `error` text says which. |
| 403 | A browser on a site outside `ALLOWED_ORIGIN` sent the post |
| 413 | Body over 20 KB |
| 415 | The post was not `application/json` |
| 429 | More than 5 posts in a minute from one address |
| 500 | No destination is configured, or the worker crashed |
| 502 | Every configured destination failed |

The page shows its "email your sermon link" fallback on anything other than 200.

`results` holds one value per destination: `true` for accepted, `false` for failed, `null` for not configured. The reason for a failure goes to the log (`npx wrangler tail`) and to the Slack alert. The public reply never carries a task link, an upstream status or an upstream error.

### Length caps

Church, city, name and role stop at 120 characters. Phone stops at 40, the UTM text at 500, notes at 1,500. The task description names any field the worker shortened.

Addresses are refused, never shortened. An email over 200 characters gets a 400, because a shortened one would reach the wrong inbox. A sermon link over 500 characters gets a 400, because a shortened link points somewhere else. A page link over 500 characters is dropped.

### Spam and abuse

The form is public, so the worker assumes a hostile sender.

- **Rate limit.** `[[ratelimits]]` in `wrangler.toml` allows 5 posts a minute from one address. Past that the sender gets a 429.
- **Other sites.** A browser post from a site outside `ALLOWED_ORIGIN` gets a 403, and a post that is not JSON gets a 415. Add a staging or preview domain to `ALLOWED_ORIGIN` before you test the form there.
- **Honeypot.** A bot that fills the hidden `website` field gets the same reply as a real request, and the worker sends nothing.
- **ClickUp.** The description escapes every value from the form. Notes sit at the end as a quote block. Nothing a sender types can add a link label, an image, a rule, a ticked box or a second "Promised" line.
- **Slack.** The alert escapes `&`, `<` and `>`, drops `*`, `_`, `~` and backticks from form values, puts a space after `://` in any address typed into a text field, and puts a space before each domain dot (`www .evil .com`), so Slack cannot link a bare domain. The only links are the sermon link and the ClickUp task. Link previews are off.

Two gaps remain, and both need work outside this folder:

1. The rate limit slows one sender. It does not stop many senders at once. Cloudflare Turnstile on the form closes that gap: add the widget to `../church/index.html` and verify its token here before any destination call.
2. GoHighLevel messages whatever email and phone the sender typed. Until Turnstile is in, keep the GoHighLevel confirmation to email only, or trigger it by hand after you look at the task.

A repeat of one request opens a second task and a second alert. Delete the extra task in ClickUp.

### The morning digest in detail

- A task counts as delivered if its status type is `done` or `closed` and its done date or closed date falls in the last 24 hours.
- A status whose name starts with `cancel` is left out: `cancelled`, `canceled`, `cancelled - no reply`. Give any other "we did not do this" status a name that starts with `cancel`, or the task shows as delivered on the day you close it.
- Tasks named `TEMPLATE ...` or `SETUP ...` are left out. The match is on the whole word in capitals, so a church called "Setup Sunday" still shows.
- Each section shows 15 tasks, oldest due date first, and then counts the rest.
- The digest reads 500 snapshot tasks at most, closed ones included. Past that it adds a line telling you to archive old tasks in ClickUp.

## Deploy

Run these from this folder:

```
npx wrangler login
npx wrangler deploy
npx wrangler secret put CLICKUP_TOKEN
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler secret put GHL_WEBHOOK_URL
```

`login` opens a browser. `deploy` prints the `https://...workers.dev` address. The first deploy also creates the `DESK_SEEN` KV namespace, since `wrangler.toml` lists it with no id, and asks you to confirm. To make it by hand first, run `npx wrangler kv namespace create DESK_SEEN` and paste the printed id under `binding = "DESK_SEEN"`. Each `secret put` asks for the value: paste it at that terminal prompt. Never paste a secret into a chat or a file. `GHL_WEBHOOK_URL` is optional.

- `CLICKUP_TOKEN`: ClickUp > Settings > Apps > API token.
- `SLACK_WEBHOOK_URL`: an incoming webhook for the Slack channel that should get the alerts and the digest.
- `GHL_WEBHOOK_URL`: the inbound webhook trigger of the GoHighLevel workflow that confirms with the church.

After the secrets are in:

1. Open `https://...workers.dev/health`. `clickup` and `slack` should read `true`.
2. Paste the workers.dev address into `SNAPSHOT_API_URL` in `../church/index.html` and publish the page.

## Test

### Automated tests

```
node test/worker.test.mjs
node --test test/desk.test.mjs
```

`npm test` runs both. Plain Node, no install. The tests import `index.js`, replace `fetch` with a stub and print one PASS or FAIL line per check. They never reach ClickUp, Slack or GoHighLevel. The run exits non-zero if any check fails.

### A live test after deploy

Send a request by hand. Replace the address with yours:

```
curl -s -X POST https://YOUR-WORKER.workers.dev/intake \
  -H "Content-Type: application/json" \
  -d '{"church":"SETUP test","city":"Georgetown","attendance":"100 to 249","source":"YouTube link","sermon_link":"https://www.youtube.com/watch?v=YOUR_VIDEO_ID","name":"Chris List","role":"Tester","email":"chris@bigsplash.agency","phone":"512-555-0100"}'
```

The reply should say `"ok":true` with `true` beside each destination you connected. ClickUp should show a task named `SETUP test, Georgetown` due in 72 hours, and Slack should show the alert. Naming the church `SETUP test` keeps the task out of the morning digest. Delete the task once you have looked at it. With `GHL_WEBHOOK_URL` set, the test also lands in GoHighLevel as a contact, so clear it there too.

`attendance` and `source` must match the form's choices letter for letter, or the worker answers 400.

On the first live task, check three things the automated tests cannot see:

1. The description shows one field per line and the checklist renders as checkboxes.
2. No stray backslashes show. The worker escapes markdown with backslashes, for example `\*`. Send one test with `*stars*` in the church name. If ClickUp prints the backslash, tell Claude and the escaping changes.
3. The Slack alert says `Central` after the due time.

To see a digest, leave one test task open overnight under a name that does not start with `SETUP`. The message arrives at 13:00 UTC.

`npx wrangler tail` shows live logs from the deployed worker, including why a destination failed and any digest error.

### Local testing

`npx wrangler dev` runs the worker on this Mac. It reads secrets from a `.dev.vars` file and keeps state in `.wrangler/`. Git ignores both. Put placeholder values in `.dev.vars`, never real ones, and delete both once local testing ends.

## Change the turnaround

1. Edit `TURNAROUND_HOURS` in `wrangler.toml`.
2. Run `npx wrangler deploy`.

The ClickUp due date, the promise line in the task, the Slack alert, `due_at` and the GoHighLevel payload all follow that number. `GET /health` shows the value in use. The worker accepts 1 to 720 hours and falls back to 72 for anything else.

The church page states the promise in its own copy and in `const TURNAROUND_HOURS = 72` inside `../church/index.html`. Change those by hand so the page and the worker agree.

## Other settings

All of these sit under `[vars]` in `wrangler.toml`.

- `TIMEZONE`: the zone for every date in Slack and ClickUp text. Default `America/Chicago`. The label after the time reads well for US zones: Central, Eastern, Mountain, Pacific.
- `ALLOWED_ORIGIN`: comma-separated sites allowed to post the form from a browser. Keep it set. An empty value allows every site.
- `CLICKUP_LIST_ID`: the list that receives the snapshot tasks.
- `FRONT_DOOR_LIST_ID`: the "Front Door Leads" list that receives LeadDesk tasks. Unset, LeadDesk opens no task and the Slack alert says so.

`DESK_SEEN` sits under `[[kv_namespaces]]`, outside `[vars]`. It holds the LeadDesk repeat record and nothing else.
- `CLICKUP_API_BASE`: optional. Points the worker at a mock ClickUp server for local testing. Leave it unset in production.

The digest time lives under `[triggers]`. Cron runs on UTC, so `0 13 * * *` means 8 AM Central in summer and 7 AM in winter.

The rate limit lives under `[[ratelimits]]`. `limit` is the number of posts and `period` is 10 or 60 seconds.

## Choices that go past the original brief

- An email or sermon link over its length cap gets a 400. The brief said to shorten them.
- The worker sets `form_type` and the submitted time itself and ignores the browser's values.
- Fields the form does not send are dropped.
- The Slack alert has two extra last lines: `ClickUp is not connected: add the task by hand` and `ClickUp task created, but ClickUp sent back no link`.
- The task description adds a `Cut for length` line and an `Upload` line.
- A ClickUp outage during the digest posts a note to Slack, so a quiet morning always means nothing is open.
- `results` holds true, false or null. It never holds task links or upstream statuses.

## Files

- `entry.js`: the deployed entry point. Re-exports the intake from `index.js` and exports the `LeadDesk` entrypoint. It imports `cloudflare:workers`, so Node cannot load it; the tests load `index.js` and `desk.js` directly.
- `index.js`: the snapshot intake and the morning digest. No dependencies, no build step.
- `desk.js`: LeadDesk, the Front Door task and alert logic.
- `wrangler.toml`: name, vars, cron trigger, rate limit and the deploy steps.
- `package.json`: marks this folder as ES modules so Node can run the tests. The repo root is set to CommonJS.
- `test/worker.test.mjs`: the intake and digest tests.
- `test/desk.test.mjs`: the LeadDesk and Front Door digest tests.
