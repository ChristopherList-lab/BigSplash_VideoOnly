// Big Splash Church Snapshot intake Worker
// POST JSON from church/index.html -> ClickUp task, Slack alert, optional GHL forward.
// A daily cron posts a Slack digest of open and delivered snapshots.

const REQUIRED = ['church', 'city', 'name', 'role', 'email', 'phone', 'source'];

// Character caps per field. Fields not listed here are dropped, including the
// honeypot ("website"), so nothing unexpected travels on to ClickUp, Slack or GHL.
const LIMITS = {
  church: 120, city: 120, name: 120, role: 120,
  attendance: 40, source: 40,
  email: 200, cc_email: 200, phone: 40,
  sermon_link: 500, page_url: 500, utm: 500,
  upload_confirmed: 60, notes: 1500,
};

// The choices the form offers. Anything else did not come from the form.
const ATTENDANCE = ['Under 100', '100 to 249', '250 to 499', '500 to 999', '1,000+'];
const SOURCES = ['YouTube link', 'Google Drive link', 'Upload'];
const FORM_TYPE = 'church_snapshot';

const CHECKLIST = [
  'Confirm the sermon link plays',
  'Run the prep: transcript and suggested moments',
  'Pick and edit 3 clips',
  'Look up the reach number',
  'Record the 2-minute walkthrough',
  'Build the delivery page and send it',
  'Mark this task complete',
];

const DIGEST_LABELS = {
  overdue: 'Overdue',
  soon: 'Due in the next 24 hours',
  open: 'Open',
  delivered: 'Delivered in the last 24 hours',
};

const MAX_BODY_BYTES = 20 * 1024;
const MAX_DIGEST_PAGES = 5;
const CLICKUP_PAGE_SIZE = 100;
const MAX_SECTION_LINES = 15;
const MAX_NAME_CHARS = 120;
const MAX_TURNAROUND_HOURS = 720;
const DEFAULT_TURNAROUND_HOURS = 72;
const UPSTREAM_TIMEOUT_MS = 8000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TIMEZONE = 'America/Chicago';
// Control characters, zero-width characters and the marks that reverse text direction.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    try {
      return await route(request, env, cors);
    } catch (err) {
      // Without this a crash would reach the page with no JSON and no CORS header.
      console.error('Request failed:', scrub(err?.message, env));
      return json({ ok: false, error: 'Server error' }, 500, cors);
    }
  },

  async scheduled(controller, env) {
    try {
      await sendDigest(env, controller?.scheduledTime || Date.now());
    } catch (err) {
      console.error('Digest failed:', scrub(err?.message, env));
    }
  },
};

async function route(request, env, cors) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (path === '/health') {
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, cors);
    return json({ ok: true, ...destinations(env), turnaround_hours: turnaroundHours(env) }, 200, cors);
  }
  if (path === '/' || path === '/intake') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
    return intake(request, env, cors);
  }
  return json({ error: 'Not found' }, 404, cors);
}

// ---------- Intake ----------

async function intake(request, env, cors) {
  // CORS headers only stop a browser reading the reply. These two checks stop
  // another site's page from posting the form through its visitors' browsers.
  if (!originAllowed(env, request)) return json({ error: 'Origin not allowed' }, 403, cors);
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) {
    return json({ error: 'Content-Type must be application/json' }, 415, cors);
  }
  if (await overLimit(request, env)) return json({ error: 'Too many requests' }, 429, cors);

  const raw = await readBody(request, MAX_BODY_BYTES);
  if (raw === null) return json({ error: 'Request too large' }, 413, cors);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON' }, 400, cors);

  const { form, cut } = cleanForm(body);
  const problem = validate(form, cut);
  if (problem) return json({ error: problem }, 400, cors);

  // With no destination configured the request would vanish while the page
  // says "sent". Fail loudly so the form shows its email fallback.
  const on = destinations(env);
  if (!on.clickup && !on.slack && !on.ghl) {
    return json({ ok: false, error: 'Intake has no destination configured' }, 500, cors);
  }

  const hours = turnaroundHours(env);
  const due = Date.now() + hours * HOUR;
  const job = { form, cut, hours, due, dueText: `${formatDate(due, env)} ${zoneLabel(env)}` };

  // Honeypot: the real form never fills "website". A bot that does gets the
  // same reply as a real success, and nothing is sent anywhere.
  const trapped = Boolean(String(body.website ?? '').trim());
  const results = trapped
    ? { clickup: on.clickup || null, slack: on.slack || null, ghl: on.ghl || null }
    : await deliver(job, on, env);

  // Success means at least one destination took the request.
  const ok = Object.values(results).some(Boolean);
  return json({
    ok,
    due_at: new Date(due).toISOString(),
    turnaround_hours: hours,
    results,
  }, ok ? 200 : 502, cors);
}

// Each result is true (accepted), false (failed) or null (not configured).
// The reasons go to the log and the Slack alert, never to the public reply.
async function deliver(job, on, env) {
  // ClickUp goes first so Slack and GHL can carry its link.
  const clickup = on.clickup ? await attempt('ClickUp', () => createClickUpTask(job, env), env) : null;
  const [slack, ghl] = await Promise.all([
    on.slack ? attempt('Slack', () => postSlack(env, intakeSlackText(job, clickup)), env) : null,
    on.ghl ? attempt('GoHighLevel', () => postJson(env.GHL_WEBHOOK_URL, ghlPayload(job, clickup)), env) : null,
  ]);
  return { clickup: clickup && true, slack: slack && true, ghl: ghl && true };
}

// What the destination sent back, or false after logging why it failed.
async function attempt(name, send, env) {
  try {
    return await send();
  } catch (err) {
    console.error(`${name} failed:`, scrub(err?.message, env));
    return false;
  }
}

function originAllowed(env, request) {
  const origin = request.headers.get('Origin');
  const list = allowedOrigins(env);
  return !origin || list.includes('*') || list.includes(origin);
}

// INTAKE_LIMIT is the rate limit binding in wrangler.toml. A limiter that is
// missing or broken lets the request through, so it can never block a pastor.
async function overLimit(request, env) {
  if (!env.INTAKE_LIMIT) return false;
  try {
    const key = request.headers.get('CF-Connecting-IP') || 'unknown';
    return !(await env.INTAKE_LIMIT.limit({ key })).success;
  } catch (err) {
    console.error('Rate limiter failed:', scrub(err?.message, env));
    return false;
  }
}

// Stops reading once the limit is passed, so a huge body never sits in memory.
async function readBody(request, limit) {
  if (Number(request.headers.get('Content-Length') || 0) > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      await reader.cancel();
      return null;
    }
    bytes.set(value, size);
    size += value.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, size));
}

function cleanForm(body) {
  const form = {};
  const cut = [];
  for (const [key, max] of Object.entries(LIMITS)) {
    const chars = Array.from(tidy(body[key], key === 'notes'));
    if (chars.length > max) cut.push(key);
    form[key] = chars.slice(0, max).join('').trim();
  }
  // Links travel on as the parsed address, so text typed after a space cannot
  // ride along. A shortened link points somewhere else, so it is dropped.
  for (const key of ['sermon_link', 'page_url']) {
    form[key] = cut.includes(key) ? '' : httpUrl(form[key]) || '';
  }
  // The worker's own values. The browser's clock and form_type are not trusted.
  form.form_type = FORM_TYPE;
  form.submitted_at = new Date(Date.now()).toISOString();
  return { form, cut };
}

// One-line fields lose their line breaks so a value cannot add lines of its
// own to the ClickUp task or the Slack alert. Notes keep theirs.
function tidy(value, multiline) {
  if (typeof value !== 'string') return '';
  const text = value.replace(INVISIBLE, '');
  return (multiline ? text.replace(/\r\n?|[\u2028\u2029]/g, '\n') : text.replace(/\s+/g, ' ')).trim();
}

function validate(form, cut) {
  const missing = REQUIRED.filter((k) => !form[k]);
  if (missing.length) return 'Missing: ' + missing.join(', ');
  if (!SOURCES.includes(form.source)) return 'Sermon source is not one of the choices';
  if (form.attendance && !ATTENDANCE.includes(form.attendance)) return 'Sunday attendance is not one of the choices';
  // A shortened address would go to the wrong inbox, so an over-long one is refused.
  if (cut.includes('email') || !EMAIL_SHAPE.test(form.email)) return 'Email looks wrong';
  if (form.cc_email && (cut.includes('cc_email') || !EMAIL_SHAPE.test(form.cc_email))) return 'Also-copy email looks wrong';
  if (form.source !== 'Upload') {
    if (cut.includes('sermon_link')) return 'Sermon link is too long';
    if (!form.sermon_link) return 'Sermon link must be a URL';
  }
  return '';
}

// ---------- ClickUp ----------

// CLICKUP_ASSIGNEE_IDS holds ClickUp user ids separated by commas. Tasks with
// no assignee stay out of "My Tasks" and the daily summary email.
function assigneeIds(env) {
  return String(env.CLICKUP_ASSIGNEE_IDS || '').split(',').map((id) => Number(id.trim())).filter((id) => Number.isInteger(id) && id > 0).slice(0, 5);
}

async function createClickUpTask(job, env) {
  const res = await fetch(`${clickUpBase(env)}/list/${encodeURIComponent(env.CLICKUP_LIST_ID)}/task`, {
    method: 'POST',
    headers: { 'Authorization': env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${job.form.church}, ${job.form.city}`,
      markdown_description: taskDescription(job, env),
      priority: 2,
      due_date: job.due,
      due_date_time: true,
      tags: ['snapshot', 'website-form'],
      ...(assigneeIds(env).length ? { assignees: assigneeIds(env) } : {}),
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 1000)}`);
  const task = await res.json();
  return { id: String(task?.id || '').slice(0, 40), url: httpUrl(task?.url) };
}

// Every value from the form goes through md, plainHref or quote, so the task
// shows what the pastor typed and nothing typed can pose as part of the task.
function taskDescription(job, env) {
  const f = job.form;
  const fields = [
    `**Church:** ${md(f.church)}`,
    `**City:** ${md(f.city)}`,
    f.attendance && `**Sunday attendance:** ${f.attendance}`,
    `**Contact:** ${md(f.name)} (${md(f.role)})`,
    `**Email:** ${md(f.email)}`,
    `**Cell:** ${md(f.phone)}`,
    f.cc_email && `**Also copy:** ${md(f.cc_email)}`,
    `**Sermon source:** ${f.source === 'Upload' ? 'Upload (Dropbox file request)' : f.source}`,
    f.sermon_link && `**Sermon link:** ${plainHref(f.sermon_link)}`,
    f.source === 'Upload' && `**Upload:** ${md(f.upload_confirmed) || 'not confirmed'}, check the Dropbox inbox folder`,
    `**Submitted:** ${formatDate(Date.parse(f.submitted_at), env)} ${zoneLabel(env)}`,
    f.page_url && `**Page:** ${plainHref(f.page_url)}`,
    f.utm && `**Came from:** ${md(f.utm)}`,
    job.cut.length && `**Cut for length:** ${job.cut.join(', ')}`,
    f.notes && `**Notes:**\n${quote(f.notes)}`,
  ].filter(Boolean);
  return [
    ...fields,
    '',
    '---',
    '',
    ...CHECKLIST.map((step) => `- [ ] ${step}`),
    '',
    `Promised to the church: delivery within ${hoursText(job.hours)}`,
  ].join('\n');
}

// Backslash-escapes what markdown reads as a link, image, code, bold or table.
// Underscores stay: they only ever make italics, and addresses are full of them.
function md(value) {
  return String(value).replace(/[\\`*~[\]<>|]/g, '\\$&');
}

// Notes are the one field with line breaks. Each line becomes a quote line with
// its first character defused, so no line can start a rule, a heading or a list.
function quote(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => '> ' + md(line).replace(/^[-+#=_]/, '\\$&'))
    .join('\n');
}

function clickUpBase(env) {
  return String(env.CLICKUP_API_BASE || 'https://api.clickup.com/api/v2').replace(/\/+$/, '');
}

// ---------- Slack and GoHighLevel ----------

function intakeSlackText(job, clickup) {
  const f = job.form;
  return [
    '*New snapshot request*',
    `*${slackText(f.church)}*, ${slackText(f.city)}` + (f.attendance ? ` · ${f.attendance} on a Sunday` : ''),
    `From ${slackText(f.name)}, ${slackText(f.role)} · ${slackEmail(f.email)} · ${slackText(f.phone)}`,
    f.source !== 'Upload' && f.sermon_link ? `Sermon: ${slackLink(f.sermon_link)}` : 'Sermon: uploaded to Dropbox, check the inbox folder',
    `Due ${job.dueText} (${hoursText(job.hours)})`,
    clickUpLine(clickup),
  ].join('\n');
}

function clickUpLine(result) {
  if (result === null) return 'ClickUp is not connected: add the task by hand';
  if (!result) return 'ClickUp task FAILED: add it by hand';
  return result.url ? slackLink(result.url) : 'ClickUp task created, but ClickUp sent back no link';
}

function ghlPayload(job, clickup) {
  return {
    ...job.form,
    clickup_task: clickup?.url || null,
    due_at: new Date(job.due).toISOString(),
    due_text: job.dueText,
    turnaround_hours: job.hours,
  };
}

// Previews stay off so a link in the message cannot pull outside content into the channel.
function postSlack(env, text) {
  return postJson(env.SLACK_WEBHOOK_URL, { text, unfurl_links: false, unfurl_media: false });
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return { status: res.status };
}

// ---------- Morning digest ----------

// Two sections, each optional: snapshots (CLICKUP_LIST_ID) and Front Door
// leads (FRONT_DOOR_LIST_ID). Nothing posts when both come back empty.
async function sendDigest(env, now) {
  if (!env.CLICKUP_TOKEN || !env.SLACK_WEBHOOK_URL) return;
  if (!env.CLICKUP_LIST_ID && !env.FRONT_DOOR_LIST_ID) return;
  const blocks = [];
  if (env.CLICKUP_LIST_ID) {
    let text;
    try {
      text = digestText(await fetchSnapshotTasks(env), now, env);
    } catch (err) {
      // A quiet morning means "nothing open", so a failed read has to say so.
      const reason = scrub(err?.message, env);
      console.error('Digest could not read ClickUp:', reason);
      text = `*Snapshots this morning*\nThe digest could not read ClickUp (${esc(reason)}). Check the list by hand.`;
    }
    if (text) blocks.push(text);
  }
  if (env.FRONT_DOOR_LIST_ID) {
    const text = await frontDoorDigest(env, now);
    if (text) blocks.push(text);
  }
  if (blocks.length) await postSlack(env, blocks.join('\n\n'));
}

function fetchSnapshotTasks(env) {
  return fetchTasks(env, env.CLICKUP_LIST_ID, 'include_closed=true&tags%5B%5D=snapshot&');
}

// ---------- Front Door leads in the digest ----------

const FRONT_DOOR_TITLE = '*Front Door leads waiting on a first touch*';

// Two reads: open tasks (to find leads still in "to do" after a day) and every
// task created in the last 24 hours, closed ones included, for the new-lead count.
async function frontDoorDigest(env, now) {
  try {
    const open = await fetchTasks(env, env.FRONT_DOOR_LIST_ID, '');
    const recent = await fetchTasks(env, env.FRONT_DOOR_LIST_ID, `include_closed=true&date_created_gt=${Math.floor(now - DAY)}&`);
    return frontDoorDigestText(open, recent, now, env);
  } catch (err) {
    const reason = scrub(err?.message, env);
    console.error('Digest could not read the Front Door list:', reason);
    return `${FRONT_DOOR_TITLE}\nThe digest could not read the Front Door list (${esc(reason)}). Check it by hand.`;
  }
}

function frontDoorDigestText(open, recent, now, env) {
  const real = (task) => !/^(TEMPLATE|SETUP)\b/.test(String(task.name || '').trim());
  const created = (task) => Number(task.date_created) || 0;
  const waiting = open.tasks.filter(real)
    .filter((task) => String(task.status?.status || '').trim().toLowerCase() === 'to do')
    .filter((task) => created(task) > 0 && created(task) <= now - DAY)
    .sort((a, b) => created(a) - created(b));
  const fresh = new Set(recent.tasks.filter(real)
    .filter((task) => created(task) > now - DAY && created(task) <= now)
    .map((task, i) => task.id ?? `no-id-${i}`)).size;
  const cutOff = open.cutOff || recent.cutOff;
  if (!waiting.length && !fresh && !cutOff) return '';

  const lines = [FRONT_DOOR_TITLE, `New leads in the last 24 hours: ${fresh}`];
  if (!waiting.length) lines.push('No lead has waited more than a day.');
  for (const task of waiting.slice(0, MAX_SECTION_LINES)) {
    const name = Array.from(String(task.name || 'Untitled task').trim()).slice(0, MAX_NAME_CHARS).join('');
    const parts = [slackText(name), `in "to do" since ${formatDate(created(task), env)} (${ageText(now - created(task))})`];
    const link = httpUrl(task.url);
    if (link) parts.push(slackLink(link));
    lines.push(`Waiting: ${parts.join(' ')}`);
  }
  const more = waiting.length - MAX_SECTION_LINES;
  if (more > 0) lines.push(`Waiting: and ${more} more, see ClickUp`);
  if (cutOff) {
    lines.push(`The Front Door list holds more than ${MAX_DIGEST_PAGES * CLICKUP_PAGE_SIZE} tasks to read, so this section may miss some. Archive old ones in ClickUp.`);
  }
  return lines.join('\n');
}

// "30 hours" under two days, "3 days" from there on.
function ageText(ms) {
  const hours = Math.max(1, Math.floor(ms / HOUR));
  return hours < 48 ? hoursText(hours) : `${Math.floor(hours / 24)} days`;
}

// Returns the tasks and whether the page cap ended the reading early.
// `query` is the part of the query string before page, ending in "&" when set.
async function fetchTasks(env, listId, query) {
  const byId = new Map();
  for (let page = 0; page < MAX_DIGEST_PAGES; page++) {
    const url = `${clickUpBase(env)}/list/${encodeURIComponent(listId)}/task`
      + `?${query}page=${page}`;
    const res = await fetch(url, {
      headers: { 'Authorization': env.CLICKUP_TOKEN },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ClickUp ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.tasks)) throw new Error('ClickUp sent no task list');
    // Keyed by id: a task can show up on two pages when the list shifts between reads.
    for (const task of data.tasks) {
      if (task && typeof task === 'object') byId.set(task.id ?? `no-id-${byId.size}`, task);
    }
    if (data.last_page || !data.tasks.length) return { tasks: [...byId.values()], cutOff: false };
  }
  return { tasks: [...byId.values()], cutOff: true };
}

function digestText({ tasks, cutOff }, now, env) {
  const sections = { overdue: [], soon: [], open: [], delivered: [] };
  for (const task of tasks) {
    if (/^(TEMPLATE|SETUP)\b/.test(String(task.name || '').trim())) continue;
    const section = digestSection(task, now);
    if (section) sections[section].push(task);
  }
  const lines = [];
  for (const [section, list] of Object.entries(sections)) {
    list.sort((a, b) => sortKey(a) - sortKey(b));
    for (const task of list.slice(0, MAX_SECTION_LINES)) lines.push(digestLine(section, task, now, env));
    const more = list.length - MAX_SECTION_LINES;
    if (more > 0) lines.push(`${DIGEST_LABELS[section]}: and ${more} more, see ClickUp`);
  }
  if (cutOff) {
    lines.push(`The list holds more than ${MAX_DIGEST_PAGES * CLICKUP_PAGE_SIZE} snapshot tasks, so this digest may miss some. Archive old ones in ClickUp.`);
  }
  return lines.length ? ['*Snapshots this morning*', ...lines].join('\n') : '';
}

function digestSection(task, now) {
  const type = task.status?.type;
  const status = String(task.status?.status || '').trim().toLowerCase();
  if (status.startsWith('cancel')) return null;
  if (type === 'done' || type === 'closed') {
    const recent = [task.date_done, task.date_closed].map(Number).some((when) => when > now - DAY && when <= now);
    return recent ? 'delivered' : null;
  }
  const due = Number(task.due_date);
  if (!due) return 'open';
  if (due < now) return 'overdue';
  return due <= now + DAY ? 'soon' : 'open';
}

function digestLine(section, task, now, env) {
  const due = Number(task.due_date);
  const name = Array.from(String(task.name || 'Untitled task').trim()).slice(0, MAX_NAME_CHARS).join('');
  const parts = [slackText(name)];
  if (section === 'overdue') {
    const late = Math.max(1, Math.floor((now - due) / HOUR));
    parts.push(`was due ${formatDate(due, env)} (${hoursText(late)} late)`);
  } else if (section !== 'delivered') {
    parts.push(due ? `due ${formatDate(due, env)}` : 'no due date');
  }
  const link = httpUrl(task.url);
  if (link) parts.push(slackLink(link));
  return `${DIGEST_LABELS[section]}: ${parts.join(' ')}`;
}

// Oldest due date first. Tasks with no due date go last.
function sortKey(task) {
  return Number(task.due_date) || Number.MAX_SAFE_INTEGER;
}

// ---------- Shared helpers ----------

function destinations(env) {
  return {
    clickup: Boolean(env.CLICKUP_TOKEN && env.CLICKUP_LIST_ID),
    slack: Boolean(env.SLACK_WEBHOOK_URL),
    ghl: Boolean(env.GHL_WEBHOOK_URL),
  };
}

// A value outside 1 to 720 hours is a typo, and a huge one would break the due date.
function turnaroundHours(env) {
  const hours = Number(env.TURNAROUND_HOURS);
  return hours >= 1 && hours <= MAX_TURNAROUND_HOURS ? hours : DEFAULT_TURNAROUND_HOURS;
}

function hoursText(hours) {
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

// Error text can carry the address that failed, and the webhook addresses are secrets.
// Secrets are trimmed first: the runtime prints an address without a stray newline.
function scrub(message, env) {
  let text = String(message || 'Request failed');
  for (const secret of [env.CLICKUP_TOKEN, env.SLACK_WEBHOOK_URL, env.GHL_WEBHOOK_URL]) {
    const value = String(secret || '').trim();
    if (value) text = text.split(value).join('[hidden]');
  }
  return text.slice(0, 200);
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    // A name before "@" can dress another host up as the real one.
    if (url.username || url.password) return null;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// Slack reads &, < and > as markup: <url|label> makes a link, <!channel> pings everyone.
function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Form text for Slack. Dropping * ~ ` stops a value restyling the alert, and the
// gap after a scheme stops Slack turning a typed address into a link.
function slackEmail(value) {
  return esc(String(value).replace(/[*~`]/g, '').replace(/:\/\//g, ': //'));
}

// The same, minus underscores, and with every typed domain broken up. Only email
// keeps them, because addresses use them.
function slackText(value) {
  return slackEmail(defuseDomains(String(value).replace(/_/g, '')));
}

// Slack links a bare domain ("evil.com") and markdown links "www.evil.com", so a
// space goes before each dot that starts a domain label: "www .evil .com". Two
// letters after the dot is the shortest TLD, so "e.g.", "St. Mary" and "3.5" stay.
function defuseDomains(value) {
  return String(value).replace(/([\p{L}\p{N}-])\.(?=\p{L}{2})/gu, '$1 .');
}

// Percent-encodes the characters Slack and markdown read as markup inside an address.
// Pass only values that came back from httpUrl.
function plainHref(url) {
  return url.replace(/[[\]*~\\|`]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// A pipe would let the address set its own label, and plainHref encodes it.
function slackLink(url) {
  return `<${esc(plainHref(url))}>`;
}

function timeZone(env) {
  const zone = String(env.TIMEZONE || DEFAULT_TIMEZONE);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function dateParts(ms, env, options) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: timeZone(env), ...options });
  return Object.fromEntries(format.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
}

// "Thu, Oct 15, 3:04 PM". Built from parts because the joined string differs between runtimes.
function formatDate(ms, env) {
  const p = dateParts(ms, env, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return `${p.weekday}, ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

// "Central Time" -> "Central"
function zoneLabel(env) {
  const p = dateParts(Date.now(), env, { timeZoneName: 'longGeneric' });
  return String(p.timeZoneName || '').replace(/ Time$/, '') || timeZone(env);
}

// ALLOWED_ORIGIN may hold several origins separated by commas, for example
// "https://bigsplash.church,https://bigsplash.video". Unset allows any origin.
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '*').split(',').map((o) => o.trim()).filter(Boolean);
}

function corsHeaders(env, request) {
  const list = allowedOrigins(env);
  const origin = request.headers.get('Origin') || '';
  const allowed = list.includes('*') ? '*' : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

// Shared with desk.js, the Front Door lead desk. entry.js wires both into the
// deployed worker; the default export above stays the snapshot intake.
export {
  md, httpUrl, plainHref, esc, slackText, slackEmail, slackLink, defuseDomains, scrub, tidy,
  assigneeIds, clickUpBase, formatDate, zoneLabel, dateParts, timeZone,
  EMAIL_SHAPE, UPSTREAM_TIMEOUT_MS, HOUR, DAY,
};
