// Tests for the snapshot intake worker. Plain Node, no framework.
// Run from the worker folder: node test/worker.test.mjs
// Every outbound call goes to a stub. Nothing here reaches ClickUp, Slack or GoHighLevel.

import { readFileSync } from 'node:fs';
import worker from '../index.js';

// ---------- Harness ----------

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail === undefined ? '' : `\n      got: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

// Monday, October 12, 2026, 3:04 PM Central. 72 hours later is Thursday, October 15, 3:04 PM.
const NOW = Date.parse('2026-10-12T20:04:00Z');
const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
let clock = NOW;
Date.now = () => clock;

// What the worker logs. Chris reads these with "wrangler tail"; the public never does.
const logs = [];
console.error = (...parts) => logs.push(parts.join(' '));

// AbortSignal timers do not keep Node alive, so this does while the tests wait on one.
const keepAlive = setInterval(() => {}, 1000);

const BASE = 'https://clickup.test/api/v2';
const SLACK = 'https://hooks.slack.test/services/T000/B000/not-a-real-webhook';
const GHL = 'https://ghl.test/hooks/not-a-real-hook';
const TOKEN = 'test-token-not-real-0123456789';
const TASK_URL = 'https://app.clickup.test/t/abc123';
const ORIGINS = ['https://bigsplash.church', 'https://www.bigsplash.church', 'https://bigsplash.video'];
const ATTENDANCE = ['Under 100', '100 to 249', '250 to 499', '500 to 999', '1,000+'];

const ENV = {
  CLICKUP_TOKEN: TOKEN,
  CLICKUP_LIST_ID: '901421191181',
  SLACK_WEBHOOK_URL: SLACK,
  GHL_WEBHOOK_URL: GHL,
  ALLOWED_ORIGIN: ORIGINS.join(','),
  TURNAROUND_HOURS: '72',
  TIMEZONE: 'America/Chicago',
  CLICKUP_API_BASE: BASE,
};

const GOOD = {
  church: 'Grace Church',
  city: 'Austin',
  attendance: '250 to 499',
  source: 'YouTube link',
  sermon_link: 'https://www.youtube.com/watch?v=abc123&t=42',
  upload_confirmed: '',
  name: 'Dana Pastor',
  role: 'Lead Pastor',
  email: 'dana@gracechurch.org',
  phone: '512-555-0142',
  cc_email: 'office@gracechurch.org',
  notes: 'Start at the 12 minute mark.\nSkip the announcements.',
  website: '',
  page_url: 'https://bigsplash.church/church/?utm_source=facebook',
  utm: 'utm_source=facebook&utm_campaign=fall',
  form_type: 'church_snapshot',
  submitted_at: '2026-10-12T20:03:30.000Z',
};

const SUCCESS = { ok: true, due_at: '2026-10-15T20:04:00.000Z', turnaround_hours: 72, results: { clickup: true, slack: true, ghl: true } };

const CHECKLIST = [
  '- [ ] Confirm the sermon link plays',
  '- [ ] Run the prep: transcript and suggested moments',
  '- [ ] Pick and edit 3 clips',
  '- [ ] Look up the reach number',
  '- [ ] Record the 2-minute walkthrough',
  '- [ ] Build the delivery page and send it',
  '- [ ] Mark this task complete',
];

// Replaces globalThis.fetch. Each destination answers 'ok', an HTTP status number, 'throw',
// 'hang' (waits for the worker's own timeout), or a function that returns a Response.
// `tasks` answers the digest's task listing: (page) => response body, or one of the modes above.
// `task` is what ClickUp sends back for a created task.
function stubFetch({ clickup = 'ok', slack = 'ok', ghl = 'ok', tasks = null, task = { id: 'abc123', url: TASK_URL } } = {}) {
  const calls = [];
  logs.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      // The runtime drops a stray newline from an address before it connects.
      url: String(url).trim(),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
      timed: init.signal instanceof AbortSignal,
    };
    calls.push(call);
    const reply = (mode, okBody) => {
      if (typeof mode === 'function') return mode(call);
      if (mode === 'throw') throw new Error(`connect failed for ${call.url} with ${TOKEN}`);
      if (mode === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
      if (mode === 'ok') return new Response(JSON.stringify(okBody), { status: 200 });
      return new Response('upstream said no '.repeat(400), { status: mode });
    };
    if (call.url.startsWith('https://api.clickup.com/') || call.url.startsWith(BASE)) {
      call.to = 'clickup';
      if (call.method === 'GET') {
        const page = Number(new URL(call.url).searchParams.get('page'));
        const answer = typeof tasks === 'function' ? tasks(page) : tasks;
        if (answer instanceof Response) return answer;
        return typeof answer === 'object' && answer !== null ? reply('ok', answer) : reply(answer || 'ok', { tasks: [], last_page: true });
      }
      return reply(clickup, task);
    }
    if (call.url === SLACK) { call.to = 'slack'; return reply(slack, {}); }
    if (call.url === GHL) { call.to = 'ghl'; return reply(ghl, {}); }
    throw new Error('Test tried to reach a real address: ' + call.url);
  };
  return calls;
}

function post(payload, { path = '/', headers = {}, raw } = {}) {
  return new Request('https://worker.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw === undefined ? JSON.stringify(payload) : raw,
  });
}

async function send(payload, env = ENV, options) {
  const res = await worker.fetch(post(payload, options), env);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { res, status: res.status, text, data };
}

const to = (calls, name) => calls.filter((c) => c.to === name);
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const description = (calls) => to(calls, 'clickup')[0]?.body.markdown_description || '';
const slackLines = (calls) => (to(calls, 'slack')[0]?.body.text || '').split('\n');
const noSecrets = (text) => !text.includes(TOKEN) && !text.includes(TOKEN.slice(0, 12)) && !text.includes(SLACK) && !text.includes(GHL) && !text.includes('not-a-real');
const read = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

// ---------- Preflight and CORS ----------

for (const origin of ORIGINS) {
  const res = await worker.fetch(new Request('https://worker.test/intake', { method: 'OPTIONS', headers: { Origin: origin } }), ENV);
  check(`preflight from ${origin} is allowed`, res.status === 200 && res.headers.get('Access-Control-Allow-Origin') === origin, res.headers.get('Access-Control-Allow-Origin'));
  check(`preflight from ${origin} allows POST and Content-Type`,
    /POST/.test(res.headers.get('Access-Control-Allow-Methods')) && res.headers.get('Access-Control-Allow-Headers') === 'Content-Type');
}
{
  const res = await worker.fetch(new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: 'https://stranger.example' } }), ENV);
  check('preflight from a stranger does not echo the stranger', res.headers.get('Access-Control-Allow-Origin') === ORIGINS[0], res.headers.get('Access-Control-Allow-Origin'));
  check('preflight sets Vary: Origin', res.headers.get('Vary') === 'Origin');
}
{
  const res = await worker.fetch(new Request('https://worker.test/anything/else', { method: 'OPTIONS', headers: { Origin: ORIGINS[2] } }), ENV);
  check('preflight works on any path', res.status === 200 && res.headers.get('Access-Control-Allow-Origin') === ORIGINS[2]);
}
{
  const res = await worker.fetch(new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: 'https://stranger.example' } }), without(ENV, 'ALLOWED_ORIGIN'));
  check('unset ALLOWED_ORIGIN allows any origin', res.headers.get('Access-Control-Allow-Origin') === '*');
}
for (const origin of ORIGINS) {
  stubFetch();
  const r = await send(GOOD, ENV, { headers: { Origin: origin } });
  check(`POST from ${origin} is accepted and carries its CORS header`, r.status === 200 && r.res.headers.get('Access-Control-Allow-Origin') === origin, r.text);
}

// ---------- Posts from other sites ----------

for (const origin of ['https://stranger.example', 'null', 'https://bigsplash.church.evil.example', 'http://bigsplash.church']) {
  const calls = stubFetch();
  const r = await send(GOOD, ENV, { headers: { Origin: origin } });
  check(`POST with Origin "${origin}" is 403 and sends nothing`, r.status === 403 && calls.length === 0, r.text);
  check(`POST with Origin "${origin}" never gets its origin echoed`, r.res.headers.get('Access-Control-Allow-Origin') === ORIGINS[0]);
}
{
  const calls = stubFetch();
  const r = await send(GOOD);
  check('POST with no Origin header (curl, a server) is accepted', r.status === 200 && to(calls, 'clickup').length === 1, r.text);
  stubFetch();
  const open = await send(GOOD, without(ENV, 'ALLOWED_ORIGIN'), { headers: { Origin: 'https://stranger.example' } });
  check('with ALLOWED_ORIGIN unset any origin may post', open.status === 200, open.text);
}
for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp', '']) {
  const calls = stubFetch();
  const res = await worker.fetch(new Request('https://worker.test/intake', { method: 'POST', headers: type ? { 'Content-Type': type } : {}, body: new TextEncoder().encode(JSON.stringify(GOOD)) }), ENV);
  check(`Content-Type "${type}" is 415 and sends nothing`, res.status === 415 && calls.length === 0, res.status);
}
{
  stubFetch();
  const r = await send(GOOD, ENV, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  check('Content-Type with a charset is accepted', r.status === 200, r.text);
}

// ---------- Rate limit ----------

{
  const asked = [];
  const limiter = (allow) => ({ limit: async (options) => { asked.push(options); return { success: allow(asked.length) }; } });
  const from = { headers: { 'CF-Connecting-IP': '203.0.113.9' } };

  let calls = stubFetch();
  const allowed = await send(GOOD, { ...ENV, INTAKE_LIMIT: limiter(() => true) }, from);
  check('rate limit: a request under the limit goes through', allowed.status === 200 && calls.length === 3, allowed.text);
  equal('rate limit: the limiter is keyed on the sender address', asked, [{ key: '203.0.113.9' }]);

  calls = stubFetch();
  const refused = await send(GOOD, { ...ENV, INTAKE_LIMIT: limiter(() => false) }, from);
  check('rate limit: a request over the limit is 429 and sends nothing', refused.status === 429 && refused.data.error === 'Too many requests' && calls.length === 0, refused.text);
  check('rate limit: the 429 is JSON with CORS', refused.res.headers.get('Content-Type') === 'application/json' && Boolean(refused.res.headers.get('Access-Control-Allow-Origin')));

  asked.length = 0;
  calls = stubFetch();
  const flood = { ...ENV, INTAKE_LIMIT: limiter((count) => count <= 5) };
  const statuses = [];
  for (let i = 0; i < 20; i++) statuses.push((await send(GOOD, flood, from)).status);
  equal('rate limit: 20 posts against a limit of 5 open 5 tasks and reach GoHighLevel 5 times',
    [statuses.filter((s) => s === 200).length, statuses.filter((s) => s === 429).length, to(calls, 'clickup').length, to(calls, 'ghl').length], [5, 15, 5, 5]);

  asked.length = 0;
  stubFetch();
  await send(GOOD, { ...ENV, INTAKE_LIMIT: limiter(() => true) });
  equal('rate limit: a request with no sender address shares one key', asked, [{ key: 'unknown' }]);

  asked.length = 0;
  stubFetch();
  await send(GOOD, { ...ENV, INTAKE_LIMIT: limiter(() => true) }, { headers: { Origin: 'https://stranger.example' } });
  await send(GOOD, { ...ENV, INTAKE_LIMIT: limiter(() => true) }, { headers: { 'Content-Type': 'text/plain' } });
  check('rate limit: requests refused for origin or type never count', asked.length === 0, asked.length);

  calls = stubFetch();
  const broken = await send(GOOD, { ...ENV, INTAKE_LIMIT: { limit: async () => { throw new Error('limiter down'); } } }, from);
  check('rate limit: a broken limiter lets the request through', broken.status === 200 && calls.length === 3, broken.text);
  check('rate limit: a broken limiter is logged', logs.some((line) => line.includes('Rate limiter failed')), logs);
}

// ---------- GET /health ----------

{
  const calls = stubFetch();
  const res = await worker.fetch(new Request('https://worker.test/health'), ENV);
  const text = await res.text();
  equal('health with every destination set', JSON.parse(text), { ok: true, clickup: true, slack: true, ghl: true, turnaround_hours: 72 });
  check('health returns no part of a secret', noSecrets(text) && !text.includes('hooks.slack') && !text.includes('ghl.test'), text);
  check('health calls nothing upstream', calls.length === 0);
  check('health reply is JSON with CORS', res.headers.get('Content-Type') === 'application/json' && Boolean(res.headers.get('Access-Control-Allow-Origin')));
}
{
  const res = await worker.fetch(new Request('https://worker.test/health'), { ALLOWED_ORIGIN: ENV.ALLOWED_ORIGIN });
  equal('health with no destination set', await res.json(), { ok: true, clickup: false, slack: false, ghl: false, turnaround_hours: 72 });
}
{
  const res = await worker.fetch(new Request('https://worker.test/health'), { CLICKUP_TOKEN: TOKEN, SLACK_WEBHOOK_URL: SLACK, TURNAROUND_HOURS: '48' });
  equal('health: token without a list id is not a ClickUp destination; turnaround follows the var', await res.json(),
    { ok: true, clickup: false, slack: true, ghl: false, turnaround_hours: 48 });
}
for (const [value, expected] of [['soon', 72], ['', 72], ['0', 72], ['-5', 72], ['0.5', 72], ['721', 72], ['1e10', 72], ['Infinity', 72], ['1', 1], ['720', 720], ['36.5', 36.5]]) {
  const res = await worker.fetch(new Request('https://worker.test/health'), { ...ENV, TURNAROUND_HOURS: value });
  const got = (await res.json()).turnaround_hours;
  check(`health: TURNAROUND_HOURS "${value}" gives ${expected}`, got === expected, got);
}
{
  const res = await worker.fetch(new Request('https://worker.test/health', { method: 'POST', body: '{}' }), ENV);
  check('POST /health is 405', res.status === 405);
}

// ---------- Validation ----------

for (const field of ['church', 'city', 'name', 'role', 'email', 'phone', 'source']) {
  const calls = stubFetch();
  const r = await send(without(GOOD, field));
  check(`missing ${field} is 400 and names the field`, r.status === 400 && r.data.error.includes(field) && calls.length === 0, r.text);
}
{
  const calls = stubFetch();
  const r = await send({ ...GOOD, church: '   ', city: '\n\t' });
  check('whitespace-only fields count as missing', r.status === 400 && r.data.error === 'Missing: church, city' && calls.length === 0, r.text);
}
{
  const calls = stubFetch();
  const r = await send({ ...GOOD, church: { name: 'x' }, city: ['Austin'] });
  check('objects and arrays in text fields count as missing', r.status === 400 && r.data.error === 'Missing: church, city' && calls.length === 0, r.text);
  const typed = await send({ ...GOOD, church: true, city: 0, name: 42 });
  check('booleans and numbers in text fields count as missing', typed.status === 400 && typed.data.error === 'Missing: church, city, name' && calls.length === 0, typed.text);
}
for (const email of ['dana', 'dana@', '@gracechurch.org', 'dana@gracechurch', 'dana smith@gracechurch.org', 'dana@@gracechurch.org', 'dana@gracechurch.org extra', 'x dana@gracechurch.org']) {
  const calls = stubFetch();
  const r = await send({ ...GOOD, email });
  check(`email "${email}" is 400`, r.status === 400 && r.data.error === 'Email looks wrong' && calls.length === 0, r.text);
}
for (const cc_email of ['office at gracechurch', 'office@gracechurch.org extra']) {
  const calls = stubFetch();
  const r = await send({ ...GOOD, cc_email });
  check(`also-copy email "${cc_email}" is 400`, r.status === 400 && r.data.error === 'Also-copy email looks wrong' && calls.length === 0, r.text);
}
{
  stubFetch();
  const blank = await send({ ...GOOD, cc_email: '' });
  check('an empty also-copy email is fine', blank.status === 200);
}
for (const source of ['Carrier pigeon', 'upload', 'YouTube', 'Upload <!channel>']) {
  const calls = stubFetch();
  const r = await send({ ...GOOD, source, sermon_link: '' });
  check(`source "${source}" is 400`, r.status === 400 && r.data.error === 'Sermon source is not one of the choices' && calls.length === 0, r.text);
}
for (const attendance of ['ten million', 'under 100', '<!here>', '1000+']) {
  const calls = stubFetch();
  const r = await send({ ...GOOD, attendance });
  check(`attendance "${attendance}" is 400`, r.status === 400 && r.data.error === 'Sunday attendance is not one of the choices' && calls.length === 0, r.text);
}
for (const attendance of [...ATTENDANCE, '']) {
  stubFetch();
  const r = await send({ ...GOOD, attendance });
  check(`attendance "${attendance}" passes`, r.status === 200, r.text);
}
for (const link of ['', 'youtube.com/watch?v=abc', 'javascript:alert(1)', 'ftp://files.example/sermon.mp4', 'https://', '//youtube.com/watch?v=abc', 'data:text/html,hello']) {
  const calls = stubFetch();
  const r = await send({ ...GOOD, sermon_link: link });
  check(`sermon link "${link}" is 400 for a link source`, r.status === 400 && r.data.error === 'Sermon link must be a URL' && calls.length === 0, r.text);
}
for (const link of ['https://www.youtube.com%2Fwatch%3Fv%3Dabc123@evil.example/x.mp4', 'https://dana:secret@youtube.com/watch?v=abc123']) {
  const calls = stubFetch();
  const r = await send({ ...GOOD, sermon_link: link });
  check(`sermon link with a name before the host is 400: ${link}`, r.status === 400 && r.data.error === 'Sermon link must be a URL' && calls.length === 0, r.text);
}
{
  stubFetch();
  const r = await send({ ...GOOD, source: 'Google Drive link', sermon_link: 'http://drive.google.com/file/d/1AbC/view' });
  check('a Google Drive link over http passes', r.status === 200, r.text);
}
{
  const calls = stubFetch();
  const bad = await send(null, ENV, { raw: '{"church": ' });
  check('broken JSON is 400', bad.status === 400 && bad.data.error === 'Invalid JSON' && calls.length === 0, bad.text);
  for (const raw of ['["church"]', 'null', '"text"', '42', '']) {
    const r = await send(null, ENV, { raw });
    check(`a body of ${raw || 'nothing'} is 400 "Invalid JSON"`, r.status === 400 && r.data.error === 'Invalid JSON' && calls.length === 0, r.text);
  }
}

// ---------- Trimming and length caps ----------

{
  const calls = stubFetch();
  const r = await send({ ...GOOD, church: '  Grace Church \n', city: '\tAustin  ', email: '  dana@gracechurch.org ', name: 'Dana\nPastor' });
  const task = to(calls, 'clickup')[0].body;
  const ghl = to(calls, 'ghl')[0].body;
  check('strings are trimmed', r.status === 200 && task.name === 'Grace Church, Austin' && ghl.email === 'dana@gracechurch.org', task.name);
  check('line breaks inside one-line fields become spaces', ghl.name === 'Dana Pastor', ghl.name);
}
{
  // Control characters, zero-width characters and the marks that reverse text direction.
  const hidden = [0x00, 0x07, 0x1B, 0x7F, 0x85, 0x200B, 0x200E, 0x202A, 0x202E, 0x2066, 0x2069, 0xFEFF].map((code) => String.fromCodePoint(code));
  const calls = stubFetch();
  await send({ ...GOOD, church: 'Gr' + hidden.join('') + 'ace Church', notes: 'one' + hidden.join('') + String.fromCodePoint(0x2028) + 'two' });
  const ghl = to(calls, 'ghl')[0].body;
  check('control, zero-width and direction characters are removed', ghl.church === 'Grace Church', JSON.stringify(ghl.church));
  check('they are removed from notes too, and a line separator becomes a line break', ghl.notes === 'one\ntwo', JSON.stringify(ghl.notes));
  check('Slack and ClickUp get the clean name', slackLines(calls)[1].startsWith('*Grace Church*') && to(calls, 'clickup')[0].body.name === 'Grace Church, Austin');
}
{
  const calls = stubFetch();
  const long = (n) => 'x'.repeat(n);
  const r = await send({
    ...GOOD,
    church: 'C' + long(300), city: 'T' + long(300), name: 'N' + long(300), role: 'R' + long(300),
    phone: '5'.repeat(100),
    page_url: 'https://bigsplash.church/church/?pad=' + long(900),
    utm: 'utm_source=' + long(900),
    notes: long(4000),
    cc_email: '',
  });
  const ghl = to(calls, 'ghl')[0].body;
  const task = to(calls, 'clickup')[0].body;
  check('long request still goes through', r.status === 200, r.text);
  for (const field of ['church', 'city', 'name', 'role']) {
    check(`${field} is capped at 120 characters`, ghl[field].length === 120, ghl[field].length);
  }
  check('phone is capped at 40 characters', ghl.phone.length === 40, ghl.phone.length);
  check('utm is capped at 500 characters', ghl.utm.length === 500, ghl.utm.length);
  check('notes are capped at 1500 characters', ghl.notes.length === 1500, ghl.notes.length);
  check('a page link over 500 characters is dropped, never shortened', ghl.page_url === '' && !task.markdown_description.includes('**Page:**'), ghl.page_url.length);
  check('task name uses the capped church and city', task.name.length === 242, task.name.length);
  check('task description says which fields were cut', task.markdown_description.includes('**Cut for length:** church, city, name, role, phone, page_url, utm, notes'), task.markdown_description.match(/Cut for length.*/)?.[0]);
}
{
  const calls = stubFetch();
  const r = await send({ ...GOOD, source: 'Upload', sermon_link: '', upload_confirmed: 'opened ' + 'x'.repeat(200) });
  check('upload note is capped at 60 characters', r.status === 200 && to(calls, 'ghl')[0].body.upload_confirmed.length === 60, to(calls, 'ghl')[0]?.body.upload_confirmed.length);
}
{
  const link500 = 'https://drive.google.com/file/d/' + 'a'.repeat(463) + '/view';
  const calls = stubFetch();
  const edge = await send({ ...GOOD, sermon_link: link500 });
  check('a sermon link of exactly 500 characters passes untouched', link500.length === 500 && edge.status === 200 && to(calls, 'ghl')[0].body.sermon_link === link500, edge.text);
  const over = stubFetch();
  const r = await send({ ...GOOD, sermon_link: 'https://drive.google.com/file/d/' + 'a'.repeat(464) + '/view' });
  check('a sermon link over 500 characters is refused, never shortened', r.status === 400 && r.data.error === 'Sermon link is too long' && over.length === 0, r.text);
}
{
  // Still shaped like an address after a cut at 200, so only the "refuse, never shorten" rule stops it.
  const longEmail = 'd'.repeat(150) + '@' + 'a.'.repeat(30) + 'example.org';
  const calls = stubFetch();
  const r = await send({ ...GOOD, email: longEmail });
  check('an email over 200 characters is refused, never shortened', longEmail.length === 222 && r.status === 400 && r.data.error === 'Email looks wrong' && calls.length === 0, r.text);
  const cc = await send({ ...GOOD, cc_email: longEmail });
  check('an also-copy email over 200 characters is refused', cc.status === 400 && cc.data.error === 'Also-copy email looks wrong' && calls.length === 0, cc.text);
  const ok = await send({ ...GOOD, email: 'd'.repeat(184) + '@gracechurch.org', cc_email: 'c'.repeat(184) + '@gracechurch.org' });
  check('emails of exactly 200 characters pass', ok.status === 200 && to(calls, 'ghl')[0].body.email.length === 200 && to(calls, 'ghl')[0].body.cc_email.length === 200, ok.text);
}
{
  const calls = stubFetch();
  await send({ ...GOOD, extra_field: 'surprise', church_id: 42, form_type: 'something else', submitted_at: '2020-01-01T00:00:00.000Z' });
  const ghl = to(calls, 'ghl')[0].body;
  check('fields the form does not send are dropped', !('extra_field' in ghl) && !('church_id' in ghl));
  check('form_type is set by the worker', ghl.form_type === 'church_snapshot', ghl.form_type);
  check('the submitted time is the worker clock, never the browser value', ghl.submitted_at === '2026-10-12T20:04:00.000Z' && description(calls).includes('**Submitted:** Mon, Oct 12, 3:04 PM Central'), ghl.submitted_at);
}

// ---------- Honeypot ----------

{
  stubFetch();
  const real = await send(GOOD);
  for (const website of ['https://spam.example', 'x', ' 1 ', 1, true]) {
    const calls = stubFetch();
    const r = await send({ ...GOOD, website });
    check(`honeypot: website ${JSON.stringify(website)} gets the same reply as a real request`, r.status === 200 && r.text === real.text, r.text);
    check(`honeypot: website ${JSON.stringify(website)} sends nothing anywhere`, calls.length === 0, calls.length);
  }
  const calls = stubFetch();
  const blank = await send({ ...GOOD, website: '   ' });
  check('honeypot: a whitespace-only website field is a real request', blank.status === 200 && calls.length === 3, calls.length);
}
{
  const calls = stubFetch();
  const trapped = await send({ website: 'x' });
  const plain = await send({});
  check('honeypot: a trapped empty form gets the same 400 as any empty form', trapped.status === 400 && trapped.text === plain.text && calls.length === 0, trapped.text);
  const slackOnly = without(ENV, 'CLICKUP_TOKEN', 'GHL_WEBHOOK_URL');
  const quiet = await send({ ...GOOD, website: 'x' }, slackOnly);
  const real = await send(GOOD, slackOnly);
  check('honeypot: the reply mirrors which destinations are connected', quiet.text === real.text && calls.length === 1, quiet.text);
  const none = await send({ ...GOOD, website: 'x' }, { ALLOWED_ORIGIN: ENV.ALLOWED_ORIGIN });
  check('honeypot: no destination configured is still a 500', none.status === 500, none.text);
}

// ---------- 20 KB limit ----------

// A request body of exactly `bytes` bytes: the good form with notes padded to fit.
const bodyOf = (bytes) => JSON.stringify({ ...GOOD, notes: 'x'.repeat(bytes - JSON.stringify({ ...GOOD, notes: '' }).length) });
{
  const calls = stubFetch();
  const big = await send({ ...GOOD, notes: 'x'.repeat(21000) });
  check('a body over 20 KB is 413', big.status === 413 && calls.length === 0, big.text);
  const wide = await send({ ...GOOD, notes: 'é'.repeat(11000) });
  check('the limit counts bytes, so 11,000 two-byte characters are 413', wide.status === 413 && calls.length === 0, wide.text);
  const declared = await send(GOOD, ENV, { headers: { 'Content-Length': '50000' } });
  check('a declared Content-Length over 20 KB is 413', declared.status === 413 && calls.length === 0, declared.text);
  const justOver = await send(null, ENV, { raw: bodyOf(20481) });
  check('a body of 20,481 bytes is 413', bodyOf(20481).length === 20481 && justOver.status === 413 && calls.length === 0, justOver.text);
  const declaredOver = await send(GOOD, ENV, { headers: { 'Content-Length': '20481' } });
  check('a declared Content-Length of 20,481 is 413', declaredOver.status === 413 && calls.length === 0, declaredOver.text);
  const exact = await send(null, ENV, { raw: bodyOf(20480) });
  check('a body of exactly 20,480 bytes is accepted', bodyOf(20480).length === 20480 && exact.status === 200, exact.text);
  const declaredExact = await send(GOOD, ENV, { headers: { 'Content-Length': '20480' } });
  check('a declared Content-Length of 20,480 is accepted', declaredExact.status === 200, declaredExact.text);
}
{
  const calls = stubFetch();
  let produced = 0;
  const endless = new ReadableStream({
    pull(controller) {
      produced += 4096;
      controller.enqueue(new Uint8Array(4096).fill(120));
      if (produced >= 400 * 1024) controller.close();
    },
  });
  const res = await worker.fetch(new Request('https://worker.test/intake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: endless, duplex: 'half' }), ENV);
  check('a streamed body with no declared length is 413', res.status === 413 && calls.length === 0, res.status);
  check('the worker stops reading soon after the limit', produced < 64 * 1024, produced);
}

// ---------- A good request ----------

{
  const calls = stubFetch();
  const r = await send(GOOD);
  const clickup = to(calls, 'clickup');
  const task = clickup[0]?.body || {};
  const desc = task.markdown_description || '';

  check('good request is 200 and ok', r.status === 200 && r.data.ok === true, r.text);
  equal('response is ok, due_at, turnaround_hours and one true per destination', r.data, SUCCESS);
  check('response names no task id, task link or upstream status', !r.text.includes('abc123') && !r.text.includes('clickup.test') && !/"status"/.test(r.text), r.text);
  equal('each destination is called once, ClickUp first', calls.map((c) => c.to).slice(0, 1).concat(calls.map((c) => c.to).slice(1).sort()), ['clickup', 'ghl', 'slack']);
  check('every upstream call carries a timeout', calls.every((c) => c.timed));
  check('ClickUp call goes to the list', clickup[0].url === `${BASE}/list/901421191181/task` && clickup[0].method === 'POST', clickup[0].url);
  check('ClickUp call sends the token', clickup[0].headers.Authorization === TOKEN);
  check('task name is "<church>, <city>"', task.name === 'Grace Church, Austin', task.name);
  check('task is due 72 hours out', task.due_date === NOW + 72 * HOUR && task.due_date_time === true, task.due_date);
  equal('task priority and tags', [task.priority, task.tags], [2, ['snapshot', 'website-form']]);
  check('task has no assignees when CLICKUP_ASSIGNEE_IDS is unset', !('assignees' in task));
  {
    const seen = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => { if (String(url).includes('/task')) seen.push(JSON.parse(init.body)); return real(url, init); };
    await worker.fetch(new Request('https://w.example/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://bigsplash.church' }, body: JSON.stringify(GOOD) }), { ...ENV, CLICKUP_ASSIGNEE_IDS: '112365011, abc, -4' });
    globalThis.fetch = real;
    equal('CLICKUP_ASSIGNEE_IDS sets the task owner and drops junk ids', seen[0] && seen[0].assignees, [112365011]);
  }

  equal('description, line by line', desc.split('\n'), [
    '**Church:** Grace Church',
    '**City:** Austin',
    '**Sunday attendance:** 250 to 499',
    '**Contact:** Dana Pastor (Lead Pastor)',
    '**Email:** dana@gracechurch.org',
    '**Cell:** 512-555-0142',
    '**Also copy:** office@gracechurch.org',
    '**Sermon source:** YouTube link',
    '**Sermon link:** https://www.youtube.com/watch?v=abc123&t=42',
    '**Submitted:** Mon, Oct 12, 3:04 PM Central',
    '**Page:** https://bigsplash.church/church/?utm_source=facebook',
    '**Came from:** utm_source=facebook&utm_campaign=fall',
    '**Notes:**',
    '> Start at the 12 minute mark.',
    '> Skip the announcements.',
    '',
    '---',
    '',
    ...CHECKLIST,
    '',
    'Promised to the church: delivery within 72 hours',
  ]);
  check('description has no empty placeholders', !/undefined|null|NaN|\[object/.test(desc) && !desc.includes('Cut for length'), desc);
}
{
  const calls = stubFetch();
  const r = await send(GOOD, ENV, { path: '/intake' });
  check('POST /intake works like POST /', r.status === 200 && to(calls, 'clickup').length === 1, r.text);
  const slash = await send(GOOD, ENV, { path: '/intake/' });
  check('POST /intake/ with a trailing slash works', slash.status === 200, slash.text);
}
{
  const calls = stubFetch();
  await send({ church: 'Grace Church', city: 'Austin', source: 'YouTube link', sermon_link: 'https://youtu.be/abc123', name: 'Dana Pastor', role: 'Lead Pastor', email: 'dana@gracechurch.org', phone: '512-555-0142' });
  const desc = description(calls);
  check('empty optional fields leave no line behind', !/Sunday attendance|Also copy|Notes|Page:|Came from|Upload/.test(desc), desc);
  check('Slack leaves out attendance when the form sent none', slackLines(calls)[1] === '*Grace Church*, Austin');
}
{
  const calls = stubFetch();
  const r = await send(GOOD, { ...ENV, TURNAROUND_HOURS: '48' });
  const task = to(calls, 'clickup')[0].body;
  check('TURNAROUND_HOURS=48 moves the due date', task.due_date === NOW + 48 * HOUR && r.data.turnaround_hours === 48 && r.data.due_at === '2026-10-14T20:04:00.000Z', r.text);
  check('TURNAROUND_HOURS=48 changes the promise line', task.markdown_description.endsWith('delivery within 48 hours'));
  check('TURNAROUND_HOURS=48 changes the Slack line', slackLines(calls)[4] === 'Due Wed, Oct 14, 3:04 PM Central (48 hours)', slackLines(calls)[4]);
  check('TURNAROUND_HOURS=48 reaches GoHighLevel', to(calls, 'ghl')[0].body.turnaround_hours === 48 && to(calls, 'ghl')[0].body.due_text === 'Wed, Oct 14, 3:04 PM Central');
}
for (const value of ['0', '-3', '1e10', '0.5']) {
  const calls = stubFetch();
  const r = await send(GOOD, { ...ENV, TURNAROUND_HOURS: value });
  check(`TURNAROUND_HOURS "${value}" falls back to 72 hours and the request still lands`,
    r.status === 200 && r.data.due_at === SUCCESS.due_at && to(calls, 'clickup')[0].body.due_date === NOW + 72 * HOUR && description(calls).endsWith('delivery within 72 hours'), r.text);
}
{
  const calls = stubFetch();
  await send(GOOD, { ...ENV, TURNAROUND_HOURS: '1' });
  check('TURNAROUND_HOURS=1 says "1 hour"', description(calls).endsWith('delivery within 1 hour') && slackLines(calls)[4].endsWith('(1 hour)'), slackLines(calls)[4]);
}
{
  const calls = stubFetch();
  await send(GOOD, without(ENV, 'CLICKUP_API_BASE'));
  check('without CLICKUP_API_BASE the task goes to api.clickup.com', to(calls, 'clickup')[0].url === 'https://api.clickup.com/api/v2/list/901421191181/task', to(calls, 'clickup')[0].url);
}
{
  const calls = stubFetch();
  await send(GOOD, { ...ENV, TIMEZONE: 'America/New_York' });
  check('TIMEZONE changes the due text', slackLines(calls)[4] === 'Due Thu, Oct 15, 4:04 PM Eastern (72 hours)', slackLines(calls)[4]);
  const bad = stubFetch();
  const r = await send(GOOD, { ...ENV, TIMEZONE: 'Mars/Olympus' });
  check('a broken TIMEZONE falls back to Central', r.status === 200 && slackLines(bad)[4].includes('3:04 PM Central'), r.text);
}
{
  // Friday, October 30, 3:04 PM Central Daylight. Clocks go back on Sunday, November 1.
  clock = Date.parse('2026-10-30T20:04:00Z');
  const calls = stubFetch();
  const r = await send(GOOD);
  check('72 hours across the end of daylight saving is 72 real hours', r.data.due_at === '2026-11-02T20:04:00.000Z' && to(calls, 'clickup')[0].body.due_date === clock + 72 * HOUR, r.text);
  check('the due text follows the clock change', slackLines(calls)[4] === 'Due Mon, Nov 2, 2:04 PM Central (72 hours)', slackLines(calls)[4]);
  clock = NOW;
}
{
  const calls = stubFetch();
  const env = { ...ENV };
  Object.defineProperty(env, 'TURNAROUND_HOURS', { get() { throw new Error(`boom ${TOKEN}`); }, enumerable: true });
  const r = await send(GOOD, env, { headers: { Origin: ORIGINS[1] } });
  check('an unexpected crash is a JSON 500 with the CORS header', r.status === 500 && r.data?.ok === false && r.res.headers.get('Access-Control-Allow-Origin') === ORIGINS[1] && calls.length === 0, r.text);
  check('a crash reply and its log line carry no secret', noSecrets(r.text) && noSecrets(logs.join('\n')) && logs.some((line) => line.includes('Request failed')), logs);
}

// ---------- Upload path ----------

{
  const calls = stubFetch();
  const r = await send({ ...GOOD, source: 'Upload', sermon_link: '', upload_confirmed: 'opened 2026-10-12T20:01:00.000Z' });
  const desc = description(calls);
  check('upload request needs no link', r.status === 200 && r.data.ok === true, r.text);
  check('upload: description names the Dropbox source', desc.includes('**Sermon source:** Upload (Dropbox file request)'), desc);
  check('upload: description carries the upload note', desc.includes('**Upload:** opened 2026-10-12T20:01:00.000Z, check the Dropbox inbox folder'), desc);
  check('upload: description has no sermon link line', !desc.includes('Sermon link'), desc);
  check('upload: Slack points at Dropbox', slackLines(calls)[3] === 'Sermon: uploaded to Dropbox, check the inbox folder', slackLines(calls)[3]);
  check('upload: GHL gets the upload note', to(calls, 'ghl')[0].body.upload_confirmed === 'opened 2026-10-12T20:01:00.000Z');
}
for (const leftover of ['half typed', 'javascript:alert(1)', 'https://drive.google.com/file/d/' + 'a'.repeat(600)]) {
  const calls = stubFetch();
  const r = await send({ ...GOOD, source: 'Upload', sermon_link: leftover, upload_confirmed: '' });
  const desc = description(calls);
  const label = leftover.slice(0, 30);
  check(`upload with leftover "${label}" still goes through`, r.status === 200, r.text);
  check(`upload with leftover "${label}": the leftover goes nowhere`, !desc.includes('Sermon link') && to(calls, 'ghl')[0].body.sermon_link === '' && !slackLines(calls).join('\n').includes(label), desc);
  check(`upload with leftover "${label}": an unconfirmed upload says so`, desc.includes('**Upload:** not confirmed, check the Dropbox inbox folder'), desc);
}
{
  const calls = stubFetch();
  await send({ ...GOOD, source: 'Upload', sermon_link: 'https://youtu.be/abc123', upload_confirmed: 'opened 2026-10-12T20:01:00.000Z' });
  const desc = description(calls);
  check('upload with a real leftover link: the task shows the link and the upload note', desc.includes('**Sermon link:** https://youtu.be/abc123') && desc.includes('**Upload:** opened'), desc);
  check('upload with a real leftover link: Slack still points at Dropbox', slackLines(calls)[3] === 'Sermon: uploaded to Dropbox, check the inbox folder', slackLines(calls)[3]);
}

// ---------- Nothing typed into the form can pose as part of the ClickUp task ----------

const RULE = /^---$/gm;
const OPEN_BOX = /^- \[ \] /gm;
const count = (text, pattern) => (text.match(pattern) || []).length;
const unescapedLink = /(?<!\\)\[[^\]]*\]\(/;

{
  const calls = stubFetch();
  const notes = 'thanks!\n**Sermon link:** https://evil.example/phish\n\n---\n- [x] Mark this task complete\n\n- [ ] Wire $500 to the pastor\n\nPromised to the church: delivery within 2 hours';
  const r = await send({ ...GOOD, notes });
  const desc = description(calls);
  const lines = desc.split('\n');
  const noteLines = lines.slice(lines.indexOf('**Notes:**') + 1, lines.indexOf(''));
  check('hostile notes still go through', r.status === 200, r.text);
  check('hostile notes: the description holds exactly one rule', count(desc, RULE) === 1, desc);
  check('hostile notes: seven unchecked boxes and no ticked one', count(desc, OPEN_BOX) === 7 && !/\[x\]/i.test(desc.replace(/\\\[x\\\]/g, '')), desc);
  check('hostile notes: one sermon link line and one promise line', count(desc, /^\*\*Sermon link:\*\*/gm) === 1 && count(desc, /^Promised to the church/gm) === 1, desc);
  check('hostile notes: the real promise is still the last line', desc.endsWith('\n\nPromised to the church: delivery within 72 hours'), desc.slice(-80));
  equal('hostile notes: every line is a quote line and blank lines are gone', noteLines, [
    '> thanks!',
    '> \\*\\*Sermon link:\\*\\* https://evil.example/phish',
    '> \\---',
    '> \\- \\[x\\] Mark this task complete',
    '> \\- \\[ \\] Wire $500 to the pastor',
    '> Promised to the church: delivery within 2 hours',
  ]);
  check('notes come last, right before the rule', lines.indexOf('**Notes:**') > lines.findIndex((l) => l.startsWith('**Came from:**')) && lines[lines.indexOf('') + 1] === '---');
  check('GoHighLevel still gets the notes as typed', to(calls, 'ghl')[0].body.notes === notes);
}
{
  const calls = stubFetch();
  await send({ ...GOOD, notes: '# Big heading\n===\n___\n* * *\n```\n+ plus\n    indented\n> quote\n| a | b |\n<img src=x>\n1. first' });
  const lines = description(calls).split('\n');
  equal('notes cannot start a heading, rule, list, code block, table or tag',
    lines.slice(lines.indexOf('**Notes:**') + 1, lines.indexOf('')), [
      '> \\# Big heading',
      '> \\===',
      '> \\___',
      '> \\* \\* \\*',
      '> \\`\\`\\`',
      '> \\+ plus',
      '> indented',
      '> \\> quote',
      '> \\| a \\| b \\|',
      '> \\<img src=x\\>',
      '> 1. first',
    ]);
}
{
  const calls = stubFetch();
  const r = await send({
    ...GOOD,
    church: 'Grace `Church` *bold* <b>x</b> | y',
    city: 'Austin ![](https://evil.example/pixel.png)',
    name: 'Pat Pastor',
    role: 'Pastor [Open in ClickUp](https://evil.example/login)',
    email: '[reset-password](https://evil.example/e)@a.b',
    cc_email: '[cc](https://evil.example/c)@a.b',
    phone: '[call](tel:1)',
    sermon_link: 'https://youtu.be/x [Watch the sermon](https://evil.example/malware.dmg)',
    page_url: '[bigsplash.church/church](javascript:alert(document.cookie))',
    utm: '![](https://evil.example/pixel.png?who=chris)',
  });
  const desc = description(calls);
  check('markdown in one-line fields still goes through', r.status === 200, r.text);
  check('no form value makes a labelled link or an image', !unescapedLink.test(desc), desc);
  for (const line of [
    '**Church:** Grace \\`Church\\` \\*bold\\* \\<b\\>x\\</b\\> \\| y',
    '**City:** Austin !\\[\\](https://evil.example/pixel.png)',
    '**Contact:** Pat Pastor (Pastor \\[Open in ClickUp\\](https://evil.example/login))',
    '**Email:** \\[reset-password\\](https://evil.example/e)@a.b',
    '**Also copy:** \\[cc\\](https://evil.example/c)@a.b',
    '**Cell:** \\[call\\](tel:1)',
    '**Sermon link:** https://youtu.be/x%20%5BWatch%20the%20sermon%5D(https://evil.example/malware.dmg)',
    '**Came from:** !\\[\\](https://evil.example/pixel.png?who=chris)',
  ]) {
    check(`escaped line: ${line.slice(0, 48)}`, desc.split('\n').includes(line), desc);
  }
  check('a page value that is no http(s) address is dropped everywhere', !desc.includes('**Page:**') && !desc.includes('javascript') && to(calls, 'ghl')[0].body.page_url === '', desc);
  check('the task name is plain text and keeps what was typed', to(calls, 'clickup')[0].body.name === 'Grace `Church` *bold* <b>x</b> | y, Austin ![](https://evil.example/pixel.png)');
}
{
  const calls = stubFetch();
  await send({ ...GOOD, church: 'A \\[x](https://evil.example)', sermon_link: 'https://youtu.be/a_b-c?list=[1]&x=*~|`y`\\z' });
  const desc = description(calls);
  check('a backslash typed before a bracket cannot undo the escaping', desc.includes('**Church:** A \\\\\\[x\\](https://evil.example)'), desc.split('\n')[0]);
  check('markup characters inside a link are percent-encoded', desc.includes('**Sermon link:** https://youtu.be/a_b-c?list=%5B1%5D&x=%2A%7E%7C%60y%60%5Cz'), desc.split('\n').find((l) => l.includes('Sermon link')));
}

// ---------- Slack alert ----------

{
  const calls = stubFetch();
  await send(GOOD);
  const slack = to(calls, 'slack')[0];
  equal('Slack alert text', slack.body.text.split('\n'), [
    '*New snapshot request*',
    '*Grace Church*, Austin · 250 to 499 on a Sunday',
    'From Dana Pastor, Lead Pastor · dana@gracechurch.org · 512-555-0142',
    'Sermon: <https://www.youtube.com/watch?v=abc123&amp;t=42>',
    'Due Thu, Oct 15, 3:04 PM Central (72 hours)',
    `<${TASK_URL}>`,
  ]);
  equal('Slack payload is the text with link and media previews off', slack.body, { text: slack.body.text, unfurl_links: false, unfurl_media: false });
  check('Slack alert has no emoji', !/\p{Extended_Pictographic}/u.test(slack.body.text));
  check('Slack call is a JSON POST to the webhook', slack.url === SLACK && slack.method === 'POST' && slack.headers['Content-Type'] === 'application/json');
}
{
  const calls = stubFetch();
  const hostile = {
    ...GOOD,
    church: '<!channel> <https://evil.example|Click here> & Sons',
    city: '<@U123>',
    name: 'Dana <b>',
    role: 'R&D > Pastor',
    phone: '<tel:5125550142|call me>',
    email: '<!channel>@x.org',
  };
  const r = await send(hostile);
  const text = to(calls, 'slack')[0].body.text;
  check('hostile request still goes through', r.status === 200, r.text);
  check('Slack escapes <, > and & in the church name', text.includes('*&lt;!channel&gt; &lt;https: //evil .example|Click here&gt; &amp; Sons*'), text);
  check('Slack escapes city, name, role and phone',
    text.includes('&lt;@U123&gt;') && text.includes('Dana &lt;b&gt;') && text.includes('R&amp;D &gt; Pastor') && text.includes('&lt;tel:5125550142|call me&gt;'), text);
  check('Slack escapes the email', text.includes(' · &lt;!channel&gt;@x.org · '), text);
  equal('the only Slack links are the sermon and the ClickUp task', text.match(/<[^>]*>/g),
    ['<https://www.youtube.com/watch?v=abc123&amp;t=42>', `<${TASK_URL}>`]);
  check('no raw ampersand survives outside an entity', !/&(?!amp;|lt;|gt;)/.test(text), text);
}
{
  const reverse = String.fromCodePoint(0x202E);
  const zeroWidth = String.fromCodePoint(0x200B);
  const calls = stubFetch();
  await send({
    ...GOOD,
    church: 'Grace* _Church_ `x` https://evil.example/login',
    city: `~Austin~${reverse}nitsua${zeroWidth}`,
    name: '*Dana*',
    role: 'see http://app.clickup.com.evil.example/t/abc123',
    phone: '`512` ~555~',
    email: 'first_last@gracechurch.org',
  });
  const lines = slackLines(calls);
  check('a form value cannot restyle the alert or reverse its text', lines[1] === '*Grace Church x https: //evil .example/login*, Austinnitsua · 250 to 499 on a Sunday', JSON.stringify(lines[1]));
  check('name, role and phone lose their markup; the email keeps its underscore',
    lines[2] === 'From Dana, see http: //app .clickup .com .evil .example/t/abc123 · first_last@gracechurch.org · 512 555', lines[2]);
  check('an address typed into a text field is never sent as a link', !lines.join('\n').replace(/<[^>]*>/g, '').includes('://'), lines.join('\n'));
  check('the ClickUp task still shows the church as typed', to(calls, 'clickup')[0].body.name.startsWith('Grace* _Church_ `x` https://evil.example/login, ~Austin~nitsua'));
}
{
  const calls = stubFetch();
  await send({ ...GOOD, church: 'Grace www.evil.com', role: 'Pastor at evil.com', phone: 'St. Mary e.g. 3.5' });
  const lines = slackLines(calls);
  check('Slack: a bare www. or bare domain is broken up so Slack cannot link it',
    lines[1].startsWith('*Grace www .evil .com*') && lines[2].includes('Pastor at evil .com') && !/\b(www\.|evil\.com)/.test(lines.slice(0, 3).join('\n')), lines.join('\n'));
  check('Slack: abbreviations and decimals stay as typed', lines[2].includes('St. Mary e.g. 3.5'), lines[2]);
}
{
  const calls = stubFetch();
  await send({ ...GOOD, email: 'https://evil.example/*x*@a.bc' });
  check('an address dressed up as an email is not sent as a link', slackLines(calls)[2].includes(' · https: //evil.example/x@a.bc · '), slackLines(calls)[2]);
}
{
  const calls = stubFetch();
  await send({ ...GOOD, sermon_link: 'https://evil.example/|https://www.youtube.com/watch?v=<real>' });
  const line = slackLines(calls)[3];
  check('a pipe in the sermon link cannot fake a link label', line === 'Sermon: <https://evil.example/%7Chttps://www.youtube.com/watch?v=%3Creal%3E>', line);
}
{
  const calls = stubFetch({ clickup: 500 });
  const r = await send(GOOD);
  const lines = slackLines(calls);
  check('ClickUp error: Slack says FAILED', lines[5] === 'ClickUp task FAILED: add it by hand', lines[5]);
  check('ClickUp error: Slack still carries the request', lines[1].startsWith('*Grace Church*, Austin') && lines[2].includes('dana@gracechurch.org'));
  check('ClickUp error: the request still counts as received', r.status === 200 && r.data.ok === true, r.text);
  const down = stubFetch({ clickup: 'throw' });
  await send(GOOD);
  check('ClickUp unreachable: Slack says FAILED', slackLines(down)[5] === 'ClickUp task FAILED: add it by hand', slackLines(down)[5]);
}
for (const task of [{ id: 'x1' }, { id: 'x1', url: 'javascript:alert(1)' }, { id: 'x1', url: 'https://evil@app.clickup.test/t/x1' }, null]) {
  const calls = stubFetch({ task });
  const r = await send(GOOD);
  const lines = slackLines(calls);
  check(`ClickUp reply ${JSON.stringify(task)}: Slack says the task has no link`, lines[5] === 'ClickUp task created, but ClickUp sent back no link' && lines.length === 6, lines[5]);
  check(`ClickUp reply ${JSON.stringify(task)}: the task counts and GoHighLevel gets no link`, r.data.results.clickup === true && to(calls, 'ghl')[0].body.clickup_task === null, r.text);
}

// ---------- GoHighLevel payload ----------

{
  const calls = stubFetch();
  await send(GOOD);
  const ghl = to(calls, 'ghl')[0];
  equal('GHL payload', ghl.body, {
    church: 'Grace Church',
    city: 'Austin',
    name: 'Dana Pastor',
    role: 'Lead Pastor',
    attendance: '250 to 499',
    source: 'YouTube link',
    email: 'dana@gracechurch.org',
    cc_email: 'office@gracechurch.org',
    phone: '512-555-0142',
    sermon_link: 'https://www.youtube.com/watch?v=abc123&t=42',
    page_url: 'https://bigsplash.church/church/?utm_source=facebook',
    utm: 'utm_source=facebook&utm_campaign=fall',
    upload_confirmed: '',
    notes: 'Start at the 12 minute mark.\nSkip the announcements.',
    form_type: 'church_snapshot',
    submitted_at: '2026-10-12T20:04:00.000Z',
    clickup_task: TASK_URL,
    due_at: '2026-10-15T20:04:00.000Z',
    due_text: 'Thu, Oct 15, 3:04 PM Central',
    turnaround_hours: 72,
  });
  check('GHL payload leaves out the honeypot', !('website' in ghl.body));
  check('GHL call is a JSON POST to the webhook', ghl.url === GHL && ghl.method === 'POST' && ghl.headers['Content-Type'] === 'application/json');
}
{
  const calls = stubFetch({ clickup: 500 });
  await send(GOOD);
  check('GHL gets clickup_task null when ClickUp failed', to(calls, 'ghl')[0].body.clickup_task === null);
  const off = stubFetch();
  await send(GOOD, without(ENV, 'CLICKUP_TOKEN'));
  check('GHL gets clickup_task null when ClickUp is not connected', to(off, 'ghl')[0].body.clickup_task === null);
}

// ---------- Destinations failing ----------

{
  const calls = stubFetch({ clickup: 500 });
  const r = await send(GOOD);
  check('ClickUp 500 alone: still 200, Slack and GHL both called', r.status === 200 && to(calls, 'slack').length === 1 && to(calls, 'ghl').length === 1, r.text);
  equal('ClickUp 500 alone: results say which one failed', r.data.results, { clickup: false, slack: true, ghl: true });
  check('ClickUp 500 alone: the reply carries none of the upstream text', !r.text.includes('upstream') && r.text.length < 200, r.text);
  const line = logs.find((l) => l.startsWith('ClickUp failed: ClickUp 500')) || '';
  check('ClickUp 500 alone: the reason is logged and the log line is short', line.includes('upstream said no') && line.length <= 220, logs);
}
{
  const calls = stubFetch({ clickup: 'throw' });
  const r = await send(GOOD);
  check('ClickUp network failure alone: still 200, others called', r.status === 200 && r.data.results.clickup === false && to(calls, 'slack').length === 1 && to(calls, 'ghl').length === 1, r.text);
  check('ClickUp network failure: no secret in the reply or the log', noSecrets(r.text) && noSecrets(logs.join('\n')) && logs.some((l) => l.includes('[hidden]')), logs);
}
{
  // ClickUp echoing the token far enough into its error that a short cut would split it.
  stubFetch({ clickup: () => new Response('x'.repeat(130) + TOKEN + ' is not valid', { status: 500 }) });
  const r = await send(GOOD);
  check('a token echoed by ClickUp never reaches the reply or the log, whole or in part', noSecrets(r.text) && noSecrets(logs.join('\n')), [r.text, logs]);
  stubFetch({ clickup: () => new Response('{"err":"Token invalid","ECODE":"OAUTH_025","team":"9014000111"}', { status: 401 }) });
  const denied = await send(GOOD, without(ENV, 'SLACK_WEBHOOK_URL', 'GHL_WEBHOOK_URL'));
  check('a ClickUp error body stays out of the reply', denied.status === 502 && !/OAUTH|9014000111|Token invalid/.test(denied.text), denied.text);
  check('a ClickUp error body is in the log for Chris', logs.some((l) => l.includes('ClickUp 401') && l.includes('OAUTH_025')), logs);
}
{
  // A secret saved with a stray newline. The address the runtime reports has none.
  stubFetch({ slack: 'throw', ghl: 'throw', clickup: 'throw' });
  const r = await send(GOOD, { ...ENV, CLICKUP_TOKEN: TOKEN + '\n', SLACK_WEBHOOK_URL: SLACK + '\n', GHL_WEBHOOK_URL: ' ' + GHL + ' \n' });
  check('secrets saved with stray whitespace are still hidden', r.status === 502 && noSecrets(r.text) && noSecrets(logs.join('\n')) && logs.length === 3, logs);
}
{
  const calls = stubFetch({ slack: 500 });
  const r = await send(GOOD);
  equal('Slack 500 alone: still 200, ClickUp and GHL fine', [r.status, r.data.ok, r.data.results, to(calls, 'ghl').length], [200, true, { clickup: true, slack: false, ghl: true }, 1]);
  check('Slack 500 alone: logged', logs.some((l) => l === 'Slack failed: HTTP 500'), logs);
}
{
  const calls = stubFetch({ slack: 'throw' });
  const r = await send(GOOD);
  equal('Slack network failure alone: still 200, GHL still called', [r.status, r.data.results, to(calls, 'ghl').length], [200, { clickup: true, slack: false, ghl: true }, 1]);
  check('Slack network failure: the webhook address is hidden', noSecrets(r.text) && noSecrets(logs.join('\n')), logs);
}
{
  const calls = stubFetch({ ghl: 500 });
  const r = await send(GOOD);
  equal('GHL 500 alone: still 200, ClickUp and Slack fine', [r.status, r.data.ok, r.data.results, to(calls, 'slack').length], [200, true, { clickup: true, slack: true, ghl: false }, 1]);
}
{
  stubFetch({ ghl: 'throw' });
  const r = await send(GOOD);
  check('GHL network failure alone: still 200 and hidden', r.status === 200 && r.data.results.ghl === false && noSecrets(r.text) && noSecrets(logs.join('\n')), r.text);
}
{
  const calls = stubFetch({ clickup: 500, slack: 500, ghl: 500 });
  const r = await send(GOOD);
  equal('all three failing is 502 and not ok', [r.status, r.data.ok, r.data.results], [502, false, { clickup: false, slack: false, ghl: false }]);
  check('all three failing: every destination was still tried', calls.length === 3);
  check('all three failing: reply still carries due_at', r.data.due_at === '2026-10-15T20:04:00.000Z');
  check('all three failing: no upstream body and no secret in the reply', r.text.length < 200 && noSecrets(r.text), r.text.length);
}
{
  stubFetch({ clickup: 'throw', slack: 'throw', ghl: 'throw' });
  const r = await send(GOOD);
  check('all three unreachable is 502 with nothing leaked', r.status === 502 && r.data.ok === false && noSecrets(r.text) && noSecrets(logs.join('\n')), r.text);
}
{
  stubFetch({ clickup: 401 });
  const r = await send(GOOD, without(ENV, 'SLACK_WEBHOOK_URL', 'GHL_WEBHOOK_URL'));
  equal('ClickUp alone and failing is 502', [r.status, r.data.ok, r.data.results], [502, false, { clickup: false, slack: null, ghl: null }]);
}
{
  const calls = stubFetch();
  const r = await send(GOOD, without(ENV, 'CLICKUP_TOKEN', 'GHL_WEBHOOK_URL'));
  equal('Slack alone is enough for a 200', [r.status, r.data.results, calls.length], [200, { clickup: null, slack: true, ghl: null }, 1]);
  check('Slack alone: the alert says ClickUp is not connected', slackLines(calls)[5] === 'ClickUp is not connected: add the task by hand', slackLines(calls)[5]);
}

// ---------- Upstreams that never answer ----------

const realTimeout = AbortSignal.timeout;
{
  // The worker asks for its own timeout; the test shortens the wait.
  const asked = [];
  AbortSignal.timeout = (ms) => { asked.push(ms); return realTimeout.call(AbortSignal, 40); };
  const calls = stubFetch({ clickup: 'hang', slack: 'hang', ghl: 'hang' });
  const started = performance.now();
  const r = await send(GOOD);
  const waited = performance.now() - started;
  equal('all three hanging: 502 once the timeouts fire', [r.status, r.data.results, calls.length], [502, { clickup: false, slack: false, ghl: false }, 3]);
  check('all three hanging: each call set a timeout of 10 seconds or less', asked.length === 3 && asked.every((ms) => ms > 0 && ms <= 10000), asked);
  check('all three hanging: ClickUp waits once, then Slack and GHL wait together', waited < 1000, Math.round(waited));

  const slow = stubFetch({ clickup: 'hang' });
  const one = await send(GOOD);
  check('ClickUp hanging alone: Slack says FAILED and the request lands', one.status === 200 && slackLines(slow)[5] === 'ClickUp task FAILED: add it by hand', one.text);
  AbortSignal.timeout = realTimeout;
}

// ---------- No destination configured ----------

{
  const calls = stubFetch();
  const r = await send(GOOD, { ALLOWED_ORIGIN: ENV.ALLOWED_ORIGIN, CLICKUP_LIST_ID: ENV.CLICKUP_LIST_ID });
  check('no destination configured is a loud 500', r.status === 500 && r.data.ok === false && /no destination/.test(r.data.error) && calls.length === 0, r.text);
}

// ---------- Unknown path and wrong method ----------

{
  const calls = stubFetch();
  const get = (path, method = 'GET') => worker.fetch(new Request('https://worker.test' + path, { method }), ENV);
  check('GET / is 405', (await get('/')).status === 405);
  check('GET /intake is 405', (await get('/intake')).status === 405);
  check('PUT / is 405', (await get('/', 'PUT')).status === 405);
  check('DELETE /intake is 405', (await get('/intake', 'DELETE')).status === 405);
  check('GET /nope is 404', (await get('/nope')).status === 404);
  check('GET /health/extra is 404', (await get('/health/extra')).status === 404);
  const lost = await send(GOOD, ENV, { path: '/admin' });
  check('POST to an unknown path is 404 and sends nothing', lost.status === 404 && calls.length === 0, lost.text);
  const res = await get('/nope');
  check('error replies are JSON with CORS', res.headers.get('Content-Type') === 'application/json' && Boolean(res.headers.get('Access-Control-Allow-Origin')));
}

// ---------- Morning digest ----------

// 13:00 UTC on Monday, October 12, 2026 is 8:00 AM Central.
const MORNING = Date.parse('2026-10-12T13:00:00Z');
const link = (id) => `https://app.clickup.test/t/${id}`;
const openTask = (id, name, dueOffsetHours) => ({
  id, name, url: link(id), status: { status: 'to do', type: 'open' },
  due_date: dueOffsetHours === null ? null : String(MORNING + dueOffsetHours * HOUR), date_done: null, date_closed: null,
});
// doneAgo and closedAgo are hours before the digest runs; null leaves the date empty.
const closedTask = (id, name, doneAgo, status = { status: 'complete', type: 'closed' }, closedAgo = doneAgo) => ({
  id, name, url: link(id), status, due_date: String(MORNING - 30 * HOUR),
  date_done: doneAgo === null ? null : String(MORNING - doneAgo * HOUR),
  date_closed: closedAgo === null ? null : String(MORNING - closedAgo * HOUR),
});
const runDigest = (env = ENV) => worker.scheduled({ scheduledTime: MORNING, cron: '0 13 * * *' }, env, { waitUntil() {} });
async function digestOf(tasks, options = {}) {
  const calls = stubFetch({ tasks: Array.isArray(tasks) ? { tasks, last_page: true } : tasks, ...options });
  let threw = false;
  try { await runDigest(); } catch { threw = true; }
  return { calls, threw, posts: to(calls, 'slack'), lines: slackLines(calls), text: to(calls, 'slack')[0]?.body.text || '' };
}

{
  const mix = [
    openTask('open2', 'Hope Chapel, Round Rock', 60),
    openTask('late2', 'Second Late, Hutto', -2.5),
    closedTask('gone1', 'Cancelled Church, Waco', 1, { status: 'cancelled', type: 'closed' }),
    openTask('soon1', 'First Baptist, Georgetown', 6),
    { ...openTask('tpl', 'TEMPLATE snapshot checklist', -100) },
    { ...openTask('setup', 'SETUP notes for the list', 2) },
    closedTask('done1', 'Calvary, Leander', 3),
    closedTask('done2', 'River Church, Taylor', 20, { status: 'delivered', type: 'done' }),
    closedTask('old1', 'Old Delivery, Temple', 48),
    openTask('late1', 'Grace Church, Austin', -41),
    openTask('nodue', 'No Date Church, Bastrop', null),
    { ...openTask('prog', 'In Progress Church, Elgin', 30), status: { status: 'in progress', type: 'custom' } },
    { ...openTask('gone2', 'Canceled Open Church, Kyle', 5), status: { status: 'Canceled', type: 'custom' } },
  ];
  const { calls, posts, lines, text } = await digestOf(mix);
  const listing = to(calls, 'clickup');
  const query = new URL(listing[0].url);
  check('digest reads the list once when the first page is the last', listing.length === 1 && listing[0].method === 'GET', listing.length);
  check('digest asks for the right list', query.origin + query.pathname === `${BASE}/list/901421191181/task`, listing[0].url);
  equal('digest asks for closed tasks, the snapshot tag and page 0',
    [query.searchParams.get('include_closed'), query.searchParams.getAll('tags[]'), query.searchParams.get('page')], ['true', ['snapshot'], '0']);
  check('digest sends the token and sets a timeout', listing[0].headers.Authorization === TOKEN && listing[0].timed);
  check('digest posts one Slack message', posts.length === 1 && to(calls, 'ghl').length === 0, posts.length);
  equal('digest text', lines, [
    '*Snapshots this morning*',
    `Overdue: Grace Church, Austin was due Sat, Oct 10, 3:00 PM (41 hours late) <${link('late1')}>`,
    `Overdue: Second Late, Hutto was due Mon, Oct 12, 5:30 AM (2 hours late) <${link('late2')}>`,
    `Due in the next 24 hours: First Baptist, Georgetown due Mon, Oct 12, 2:00 PM <${link('soon1')}>`,
    `Open: In Progress Church, Elgin due Tue, Oct 13, 2:00 PM <${link('prog')}>`,
    `Open: Hope Chapel, Round Rock due Wed, Oct 14, 8:00 PM <${link('open2')}>`,
    `Open: No Date Church, Bastrop no due date <${link('nodue')}>`,
    `Delivered in the last 24 hours: Calvary, Leander <${link('done1')}>`,
    `Delivered in the last 24 hours: River Church, Taylor <${link('done2')}>`,
  ]);
  check('digest leaves out cancelled, TEMPLATE, SETUP and old deliveries', !/Cancel|TEMPLATE|SETUP|Old Delivery/i.test(text), text);
  check('digest has no emoji', !/\p{Extended_Pictographic}/u.test(text));
  equal('digest payload is the text with previews off', posts[0].body, { text, unfurl_links: false, unfurl_media: false });
}
{
  const { lines } = await digestOf([closedTask('done1', 'Calvary, Leander', 3)]);
  equal('digest with only a delivery leaves out the empty sections', lines,
    ['*Snapshots this morning*', `Delivered in the last 24 hours: Calvary, Leander <${link('done1')}>`]);
}
{
  // The skip rule is for Chris's own TEMPLATE and SETUP tasks. A church whose name only starts with those letters stays in.
  const { text } = await digestOf([
    openTask('t1', 'SETUPTOWN Community Church, Waco', 2),
    openTask('t2', 'Setup Sunday Church, Austin', 3),
    openTask('t3', 'TEMPLATES and More Church, Hutto', 4),
    openTask('t4', 'template church, Taylor', 5),
    openTask('t5', 'SETUP', 2),
    openTask('t6', 'SETUP: test, Georgetown', 2),
    openTask('t7', '  TEMPLATE-old checklist', 2),
  ]);
  check('digest keeps churches whose names only begin like SETUP or TEMPLATE',
    ['SETUPTOWN Community', 'Setup Sunday', 'TEMPLATES and More', 'template church'].every((name) => text.includes(name)), text);
  check('digest skips SETUP and TEMPLATE as whole words', !/SETUP(:|\n|$)|TEMPLATE-old/.test(text) && text.split('\n').length === 5, text);
}
{
  const edge = (id, minutes) => ({ ...openTask(id, `Edge ${id}, Austin`, 0), due_date: String(MORNING + minutes * MINUTE) });
  const { lines } = await digestOf([edge('a', -1), edge('b', 0), edge('c', 24 * 60 - 1), edge('d', 24 * 60), edge('e', 24 * 60 + 1), edge('f', -119), edge('g', -120)]);
  const section = (id) => lines.find((l) => l.includes(`Edge ${id},`))?.split(':')[0];
  equal('digest: the edges of overdue, due soon and open',
    ['a', 'b', 'c', 'd', 'e'].map(section), ['Overdue', 'Due in the next 24 hours', 'Due in the next 24 hours', 'Due in the next 24 hours', 'Open']);
  check('digest says "1 hour late" for anything under two hours', lines.find((l) => l.includes('Edge a,')).includes('(1 hour late)') && lines.find((l) => l.includes('Edge f,')).includes('(1 hour late)'), lines);
  check('digest says "2 hours late" at two hours', lines.find((l) => l.includes('Edge g,')).includes('(2 hours late)'), lines);
}
{
  const min = (m) => m / 60;
  const { text } = await digestOf([
    closedTask('in1', 'Just Inside, Austin', 24 - min(1)),
    closedTask('out1', 'Just Outside, Austin', 24 + min(1)),
    closedTask('out2', 'Exactly A Day, Austin', 24),
    closedTask('in2', 'Closed Date Only, Austin', null, undefined, 2),
    closedTask('in3', 'Done Date Only, Austin', 2, { status: 'delivered', type: 'done' }, null),
    closedTask('in4', 'Done Long Ago Closed Today, Austin', 72, undefined, 2),
    closedTask('in5', 'Closed Long Ago Done Today, Austin', 2, undefined, 72),
    closedTask('in6', 'Done This Minute, Austin', 0),
    closedTask('out3', 'Done Tomorrow, Austin', -5),
    closedTask('out4', 'No Dates, Austin', null),
    closedTask('out5', 'No Reply, Austin', 2, { status: 'cancelled - no reply', type: 'closed' }),
    closedTask('out6', 'By Church, Austin', 2, { status: 'Canceled by church', type: 'done' }),
    { ...closedTask('out7', 'Custom Status With Done Date, Austin', 2), status: { status: 'review', type: 'custom' }, due_date: null },
  ]);
  const delivered = text.split('\n').filter((l) => l.startsWith('Delivered')).map((l) => l.match(/hours: (.*), Austin/)[1]);
  equal('digest: delivered means a done or closed date inside the last 24 hours', delivered,
    ['Just Inside', 'Closed Date Only', 'Done Date Only', 'Done Long Ago Closed Today', 'Closed Long Ago Done Today', 'Done This Minute']);
  check('digest: a status that starts with "cancel" is left out', !/No Reply|By Church/.test(text), text);
  check('digest: only done and closed status types count as delivered', text.includes('Open: Custom Status With Done Date, Austin no due date'), text);
}
{
  const hostile = { ...openTask('bad1', '<!channel> <https://evil.example|free clips> & *Co* _x_ `y`', 6), url: 'javascript:alert(1)' };
  const { text } = await digestOf([hostile]);
  check('digest escapes task names, drops markup and drops non-http links',
    text === '*Snapshots this morning*\nDue in the next 24 hours: &lt;!channel&gt; &lt;https: //evil .example|free clips&gt; &amp; Co x y due Mon, Oct 12, 2:00 PM', text);
}
{
  const { lines } = await digestOf([openTask('long', 'L'.repeat(300) + ', Austin', 6)]);
  check('digest cuts a task name at 120 characters', lines[1] === `Due in the next 24 hours: ${'L'.repeat(120)} due Mon, Oct 12, 2:00 PM <${link('long')}>`, lines[1]);
}
{
  const many = [];
  for (let i = 0; i < 40; i++) many.push(openTask('o' + i, `Open Church ${i}, Austin`, 100 + i));
  for (let i = 0; i < 16; i++) many.push(openTask('l' + i, `Late Church ${i}, Austin`, -100 + i));
  for (let i = 0; i < 15; i++) many.push(openTask('s' + i, `Soon Church ${i}, Austin`, 1 + i));
  const { lines } = await digestOf(many);
  const starting = (label) => lines.filter((l) => l.startsWith(label + ':'));
  equal('digest shows 15 lines a section and counts the rest',
    [starting('Overdue').length, starting('Overdue').at(-1), starting('Due in the next 24 hours').length, starting('Open').length, starting('Open').at(-1)],
    [16, 'Overdue: and 1 more, see ClickUp', 15, 16, 'Open: and 25 more, see ClickUp']);
  check('digest keeps the most urgent ones when it trims', lines[1].includes('Late Church 0,') && starting('Open')[0].includes('Open Church 0,'), lines[1]);
}
{
  const { calls, posts } = await digestOf([]);
  check('digest sends nothing when the list is empty', posts.length === 0 && to(calls, 'clickup').length === 1, calls.length);
}
{
  const { posts } = await digestOf([
    closedTask('old1', 'Old Delivery, Temple', 48),
    closedTask('gone1', 'Cancelled Church, Waco', 1, { status: 'cancelled', type: 'closed' }),
    openTask('tpl', 'TEMPLATE snapshot checklist', 2),
  ]);
  check('digest sends nothing when only old, cancelled and TEMPLATE tasks exist', posts.length === 0, posts.length);
}
{
  const pages = [
    { tasks: [openTask('p0', 'Page Zero Church, Austin', 6)], last_page: false },
    { tasks: [openTask('p1', 'Page One Church, Austin', 7)], last_page: false },
    { tasks: [openTask('p2', 'Page Two Church, Austin', 8)], last_page: true },
    { tasks: [openTask('p3', 'Never Fetched Church, Austin', 9)], last_page: true },
  ];
  const { calls, posts, text } = await digestOf((page) => pages[page]);
  equal('pagination: asks for pages 0, 1, 2 and stops at last_page', to(calls, 'clickup').map((c) => new URL(c.url).searchParams.get('page')), ['0', '1', '2']);
  check('pagination: tasks from every page land in one message',
    posts.length === 1 && ['Page Zero', 'Page One', 'Page Two'].every((n) => text.includes(n)) && !text.includes('Never Fetched'), text);
  check('pagination: a full read carries no warning', !text.includes('may miss some'), text);
}
{
  const { calls, posts } = await digestOf((page) => (page === 0 ? { tasks: [openTask('p0', 'Page Zero Church, Austin', 6)] } : { tasks: [] }));
  check('pagination: an empty page ends the reading', to(calls, 'clickup').length === 2 && posts.length === 1, to(calls, 'clickup').length);
}
{
  const { calls, lines } = await digestOf((page) => ({ tasks: [openTask('p' + page, `Church ${page}, Austin`, 6 + page)], last_page: page === 4 }));
  check('pagination: a list that ends on page 5 is read whole, with no warning', to(calls, 'clickup').length === 5 && lines.length === 6 && !lines.join('\n').includes('may miss some'), lines);
}
{
  const page100 = (page) => ({ tasks: Array.from({ length: 100 }, (_, i) => openTask(`p${page}-${i}`, `Junk ${page}-${i}, Nowhere`, 100 + page * 100 + i)), last_page: false });
  const { calls, posts, lines, text } = await digestOf(page100);
  check('pagination: stops after 5 pages even when ClickUp never says last_page', to(calls, 'clickup').length === 5 && posts.length === 1, to(calls, 'clickup').length);
  check('a list too long to read says so on the last line', lines.at(-1) === 'The list holds more than 500 snapshot tasks, so this digest may miss some. Archive old ones in ClickUp.', lines.at(-1));
  check('500 open tasks still make a short message', lines.length === 18 && lines[16] === 'Open: and 485 more, see ClickUp' && text.length < 4000, [lines.length, text.length]);
}
{
  const { posts, lines } = await digestOf((page) => ({ tasks: [closedTask('old' + page, 'Old Delivery, Temple', 500)], last_page: false }));
  check('a cut-off list with nothing to show still posts the warning', posts.length === 1 && lines.length === 2 && lines[1].includes('may miss some'), lines);
}
{
  const same = openTask('same', 'Repeat Church, Austin', 5);
  const { lines } = await digestOf((page) => ({ tasks: [same, openTask('other' + page, `Other ${page}, Austin`, 6 + page)], last_page: page === 1 }));
  check('a task that shows up on two pages is listed once', lines.filter((l) => l.includes('Repeat Church')).length === 1 && lines.length === 4, lines);
  const noIds = await digestOf([{ ...openTask(undefined, 'No Id One, Austin', 5) }, { ...openTask(undefined, 'No Id Two, Austin', 6) }]);
  check('tasks with no id are all kept', noIds.lines.length === 3, noIds.lines);
}
{
  const { threw, lines } = await digestOf([openTask('a', 'Real Church, Austin', 5), null, 'text', 7, [], { id: 'bare' }]);
  check('entries that are not tasks never break the digest', threw === false && lines[1].startsWith('Due in the next 24 hours: Real Church, Austin') && !logs.some((l) => l.includes('Digest failed')), lines);
}
for (const [label, answer] of [
  ['an error body with no task list', { err: 'Team not authorized', ECODE: 'OAUTH_027' }],
  ['a task list that is not a list', { tasks: 'none', last_page: true }],
  ['a null body', new Response('null', { status: 200 })],
]) {
  const { threw, posts, text } = await digestOf(() => answer);
  check(`digest: ClickUp answering 200 with ${label} is reported`, threw === false && posts.length === 1
    && text === '*Snapshots this morning*\nThe digest could not read ClickUp (ClickUp sent no task list). Check the list by hand.', text);
}
{
  const { threw, posts, text } = await digestOf(() => new Response('<html>gateway</html>', { status: 200 }));
  check('digest: ClickUp answering 200 with a web page is reported', threw === false && posts.length === 1 && text.includes('could not read ClickUp'), text);
}
{
  const { threw, posts, text } = await digestOf(500);
  check('digest survives a ClickUp 500', threw === false);
  check('digest tells Slack it could not read ClickUp', posts.length === 1 && text === '*Snapshots this morning*\nThe digest could not read ClickUp (ClickUp 500). Check the list by hand.', text);
  check('digest logs the failed read', logs.some((l) => l === 'Digest could not read ClickUp: ClickUp 500'), logs);
}
{
  const { threw, posts, text } = await digestOf('throw');
  check('digest survives ClickUp being unreachable', threw === false && posts.length === 1);
  check('digest failure note carries no secret', noSecrets(text) && text.includes('[hidden]') && noSecrets(logs.join('\n')), text);
}
{
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 40);
  const { threw, posts, text } = await digestOf('hang');
  check('digest gives up on a ClickUp that never answers and says so', threw === false && posts.length === 1 && text.includes('could not read ClickUp'), text);
  AbortSignal.timeout = realTimeout;
}
for (const status of [400, 404, 500]) {
  const { threw } = await digestOf([openTask('s1', 'Grace Church, Austin', 6)], { slack: status });
  check(`digest: Slack answering ${status} is survived and logged`, threw === false && logs.some((l) => l === `Digest failed: HTTP ${status}`), logs);
}
{
  const down = await digestOf([openTask('s1', 'Grace Church, Austin', 6)], { slack: 'throw' });
  check('digest survives Slack being unreachable', down.threw === false && logs.some((l) => l.startsWith('Digest failed:')) && noSecrets(logs.join('\n')), logs);
  const both = await digestOf(500, { slack: 'throw' });
  check('digest survives ClickUp and Slack both failing', both.threw === false);
}
for (const key of ['CLICKUP_TOKEN', 'CLICKUP_LIST_ID', 'SLACK_WEBHOOK_URL']) {
  const calls = stubFetch({ tasks: { tasks: [openTask('s1', 'Grace Church, Austin', 6)], last_page: true } });
  await runDigest(without(ENV, key));
  check(`digest does nothing without ${key}`, calls.length === 0, calls.length);
}
{
  clock = MORNING + 5 * MINUTE;
  const calls = stubFetch({ tasks: { tasks: [openTask('s1', 'Grace Church, Austin', 0.05)], last_page: true } });
  await worker.scheduled({ cron: '0 13 * * *' }, ENV, { waitUntil() {} });
  check('digest falls back to the clock when the trigger carries no time', slackLines(calls)[1]?.startsWith('Overdue:'), slackLines(calls)[1]);
  clock = NOW;
}

// ---------- The files that ship ----------

{
  const toml = read('wrangler.toml');
  const value = (key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
  equal('wrangler.toml keeps the worker name and entry file', [value('name'), value('main')], ['bigsplash-church-snapshot', 'entry.js']);
  check('wrangler.toml runs the digest at 13:00 UTC daily', /^\[triggers\]\ncrons = \["0 13 \* \* \*"\]$/m.test(toml), toml.match(/crons.*/)?.[0]);
  equal('wrangler.toml sets the four vars',
    [value('CLICKUP_LIST_ID'), value('ALLOWED_ORIGIN'), value('TURNAROUND_HOURS'), value('TIMEZONE')],
    ['901421191181', ORIGINS.join(','), '72', 'America/Chicago']);
  check('wrangler.toml binds the rate limiter the worker reads', /^\[\[ratelimits\]\]\nname = "INTAKE_LIMIT"\nnamespace_id = "\d+"\nsimple = \{ limit = 5, period = 60 \}$/m.test(toml), toml.match(/\[\[ratelimits\]\][^[]*/)?.[0]);
  check('wrangler.toml lists the deploy steps in order',
    ['npx wrangler login', 'npx wrangler deploy', 'npx wrangler secret put CLICKUP_TOKEN', 'npx wrangler secret put SLACK_WEBHOOK_URL', 'npx wrangler secret put GHL_WEBHOOK_URL']
      .map((step) => toml.indexOf(step)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1])));
  const shipped = ['wrangler.toml', 'index.js', 'README.md'].map(read).join('\n');
  check('no file that ships holds a token or a webhook address',
    !/pk_\d+_[A-Z0-9]{16,}/.test(shipped) && !/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B/.test(shipped) && !/leadconnectorhq\.com\/hooks\/[A-Za-z0-9]{8,}/.test(shipped));
}

// ---------- Result ----------

clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
