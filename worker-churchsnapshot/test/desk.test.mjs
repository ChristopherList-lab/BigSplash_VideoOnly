// Tests for LeadDesk (desk.js) and the Front Door section of the morning digest.
// Run from the worker folder: node --test test/desk.test.mjs
// Every outbound call goes to a stub. Nothing here reaches ClickUp or Slack.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../index.js';
import { frontDoorLead, nextBusinessDue, cleanLead, leadDescription, telHref, FRONT_DOOR_CHECKLIST, SEEN_TTL_SECONDS } from '../desk.js';

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

// ---------- Harness ----------

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Friday, October 16, 2026, 6:00 PM Central (CDT, UTC-5).
const FRIDAY_6PM = Date.parse('2026-10-16T23:00:00Z');
// Monday, October 19, 2026, 5:00 PM Central.
const MONDAY_5PM = Date.parse('2026-10-19T22:00:00Z');

const realNow = Date.now;
let clock = FRIDAY_6PM;
Date.now = () => clock;

const logs = [];
const realError = console.error;
console.error = (...parts) => logs.push(parts.join(' '));
after(() => { Date.now = realNow; console.error = realError; });

const BASE = 'https://clickup.test/api/v2';
const SLACK = 'https://hooks.slack.test/services/T000/B000/not-a-real-webhook';
const TOKEN = 'test-token-not-real-0123456789';
const TASK_URL = 'https://app.clickup.test/t/fd123';
const LIST = '901422444894';

const ENV = {
  CLICKUP_TOKEN: TOKEN,
  CLICKUP_LIST_ID: '901421191181',
  FRONT_DOOR_LIST_ID: LIST,
  CLICKUP_ASSIGNEE_IDS: '112365011',
  SLACK_WEBHOOK_URL: SLACK,
  TIMEZONE: 'America/Chicago',
  CLICKUP_API_BASE: BASE,
};
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const noSecrets = (text) => !text.includes(TOKEN) && !text.includes(TOKEN.slice(0, 12)) && !text.includes(SLACK) && !text.includes('not-a-real');

const LEAD = {
  event: 'ready',
  id: 'aud_7f3k2',
  scorecard_url: 'https://bigsplash.video/front-door/?id=aud_7f3k2',
  walkthrough_url: 'https://bigsplash.video/walkthrough/?id=aud_7f3k2',
  church: { name: 'Grace Church', address: '100 Main St, Austin, TX 78701', city: 'Austin', website: 'https://gracechurch.org/' },
  contact: {
    name: 'Dana Pastor', role: 'Lead Pastor', email: 'dana@gracechurch.org', phone: '(512) 555-0142',
    sms_consent: true, attendance: '250 to 499', facebook_frequency: 'Once a week',
  },
  grades: { overall: 'B', google: 'A', reviews: 'C', website: null, social: 'D' },
  fixes: [
    { title: 'Add Sunday service times to Google', why: 'Families search "church near me" on Saturday night.' },
    { title: 'Answer your reviews', why: 'Nine reviews have no reply.' },
  ],
  households: 12400,
  review_reasons: [],
  possible_duplicates: [],
  utm: { source: 'facebook', medium: 'paid', campaign: 'fd-launch', content: 'video-a' },
  page_url: 'https://bigsplash.video/frontdoor/?utm_source=facebook',
  submitted_at: '2026-10-16T22:58:00.000Z',
};

const REVIEW = {
  ...LEAD,
  event: 'review',
  preview_url: 'https://bigsplash.video/front-door/?id=aud_7f3k2&preview=1',
  approve_url: 'https://bigsplash-front-door.chris-bc4.workers.dev/approve?id=aud_7f3k2&key=k1',
  review_reasons: ['Two Google listings match this name', 'Website did not load'],
  possible_duplicates: [{ name: 'Grace Church Austin', address: '102 Main St, Austin, TX', reviewCount: 3 }, { name: 'Grace Chapel', address: '9 Oak Ave', reviewCount: 1 }],
};

// Each destination answers 'ok', an HTTP status number, 'throw' or a function returning a Response.
// `lists` answers digest GETs: (call) => body or Response.
function stub({ clickup = 'ok', slack = 'ok', lists = null, task = { id: 'fd123', url: TASK_URL } } = {}) {
  const calls = [];
  logs.length = 0;
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url), method: init.method || 'GET', headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null, timed: init.signal instanceof AbortSignal,
    };
    calls.push(call);
    const reply = (mode, okBody) => {
      if (typeof mode === 'function') return mode(call);
      if (mode === 'throw') throw new Error(`connect failed for ${call.url} with ${TOKEN}`);
      if (mode === 'ok') return new Response(JSON.stringify(okBody), { status: 200 });
      return new Response('upstream said no', { status: mode });
    };
    if (call.url.startsWith(BASE)) {
      call.to = 'clickup';
      if (call.method === 'GET') {
        const answer = lists ? lists(call) : { tasks: [], last_page: true };
        return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200 });
      }
      return reply(clickup, call.url.endsWith('/comment') ? { id: '90001', hist_id: 'h1', date: 1 } : task);
    }
    if (call.url === SLACK) { call.to = 'slack'; return reply(slack, {}); }
    throw new Error('Test tried to reach a real address: ' + call.url);
  };
  globalThis.fetch = fetchImpl;
  return { calls, fetchImpl };
}
const to = (calls, name) => calls.filter((c) => c.to === name);
const slackText = (calls) => to(calls, 'slack')[0]?.body.text || '';
const description = (calls) => to(calls, 'clickup')[0]?.body.markdown_description || '';

async function run(lead, { env = ENV, ...options } = {}) {
  const { calls, fetchImpl } = stub(options);
  const result = await frontDoorLead(lead, env, fetchImpl);
  return { calls, result, slack: slackText(calls), desc: description(calls) };
}

beforeEach(() => { clock = FRIDAY_6PM; });

// ---------- ready ----------

test('ready opens one task in the Front Door list with the right fields', async () => {
  const { calls, result } = await run(LEAD);
  const posts = to(calls, 'clickup');
  assert.equal(posts.length, 1);
  const call = posts[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${BASE}/list/${LIST}/task`);
  assert.equal(call.headers.Authorization, TOKEN);
  assert.ok(call.timed);
  assert.equal(call.body.name, 'Grace Church, Austin');
  assert.deepEqual(call.body.tags, ['front-door', 'audit']);
  assert.equal(call.body.priority, 2);
  assert.deepEqual(call.body.assignees, [112365011]);
  assert.equal(call.body.due_date, MONDAY_5PM);
  assert.equal(call.body.due_date_time, true);
  assert.deepEqual(result, { clickup: { ok: true, id: 'fd123', url: TASK_URL }, slack: { ok: true } });
});

test('ready description carries the contact, church, grades, fixes, links and checklist', async () => {
  const { desc } = await run(LEAD);
  assert.equal(desc, [
    '**Contact:** Dana Pastor (Lead Pastor)',
    '**Email:** [dana@gracechurch.org](mailto:dana@gracechurch.org)',
    '**Cell:** [(512) 555-0142](tel:+15125550142)',
    '**Texts OK:** Yes',
    '**Sunday attendance:** 250 to 499',
    '**Posts on Facebook:** Once a week',
    '',
    '**Church:** Grace Church',
    '**Website:** https://gracechurch.org/',
    '**Address:** 100 Main St, Austin, TX 78701',
    '',
    '| Area | Grade |',
    '| --- | --- |',
    '| Overall | B |',
    '| Google listing | A |',
    '| Reviews | C |',
    '| Website on a phone | Not checked |',
    '| Social and sermons | D |',
    '',
    '**Top fixes:**',
    '1. Add Sunday service times to Google: Families search "church near me" on Saturday night.',
    '2. Answer your reviews: Nine reviews have no reply.',
    '',
    '**Households nearby:** 12,400',
    '**Scorecard:** https://bigsplash.video/front-door/?id=aud_7f3k2',
    '**Walkthrough:** https://bigsplash.video/walkthrough/?id=aud_7f3k2',
    '**Came from:** source facebook, campaign fd-launch, content video-a',
    '**Page:** https://bigsplash.video/frontdoor/?utm_source=facebook',
    '**Submitted:** Fri, Oct 16, 5:58 PM Central',
    '**Audit id:** aud_7f3k2',
    '',
    '---',
    '',
    '- [ ] Text or call within 24 hours',
    '- [ ] Walkthrough booked',
    '- [ ] Proposal sent',
    '- [ ] Won or lost',
  ].join('\n'));
  assert.deepEqual(FRONT_DOOR_CHECKLIST, ['Text or call within 24 hours', 'Walkthrough booked', 'Proposal sent', 'Won or lost']);
});

test('ready Slack alert is short and carries the task and scorecard links', async () => {
  const { calls, slack } = await run(LEAD);
  assert.equal(slack, [
    '*New Front Door lead*',
    '*Grace Church*, Austin · overall B',
    'From Dana Pastor, Lead Pastor · dana@gracechurch.org · (512) 555-0142 · texts OK',
    '250 to 499 on a Sunday',
    `ClickUp: <${TASK_URL}>`,
    'Scorecard: <https://bigsplash.video/front-door/?id=aud_7f3k2>',
    'Campaign: fd-launch',
  ].join('\n'));
  assert.deepEqual(to(calls, 'slack')[0].body, { text: slack, unfurl_links: false, unfurl_media: false });
  assert.ok(!/\p{Extended_Pictographic}/u.test(slack));
  assert.ok(!slack.includes('—'));
});

test('city falls back to the address; missing grades and answers read plainly', async () => {
  const lead = {
    ...LEAD, church: { ...LEAD.church, city: '' }, grades: { overall: null, google: 'Z', reviews: '', website: 'b+', social: undefined },
    contact: { ...LEAD.contact, sms_consent: 'yes', attendance: '', facebook_frequency: '' }, households: null, fixes: [], utm: {},
  };
  const { calls, desc, slack } = await run(lead);
  assert.equal(to(calls, 'clickup')[0].body.name, 'Grace Church, 100 Main St, Austin, TX 78701');
  assert.ok(desc.includes('| Overall | Not checked |\n| Google listing | Not checked |\n| Reviews | Not checked |\n| Website on a phone | B+ |\n| Social and sermons | Not checked |'));
  assert.ok(desc.includes('**Texts OK:** No'), 'sms_consent must be the boolean true');
  assert.ok(desc.includes('**Sunday attendance:** Not given') && desc.includes('**Posts on Facebook:** Not given'));
  assert.ok(desc.includes('**Households nearby:** Not counted') && desc.includes('**Came from:** No campaign tags'));
  assert.ok(!desc.includes('Top fixes'));
  assert.ok(slack.includes('· no overall grade') && slack.includes('no texts') && slack.includes('Sunday attendance not given'));
  assert.ok(!slack.includes('Campaign:'));
});

// ---------- review ----------

test('review task leads with the hold, reasons, duplicates, preview and approve link', async () => {
  const { desc, result } = await run(REVIEW);
  assert.ok(desc.startsWith([
    '**Held for your review.** The pastor has not seen the scorecard yet.',
    '',
    '**Reasons:**',
    '- Two Google listings match this name',
    '- Website did not load',
    '',
    '**Possible duplicate listings:**',
    '- Grace Church Austin, 102 Main St, Austin, TX (3 reviews)',
    '- Grace Chapel, 9 Oak Ave (1 review)',
    '',
    '**Preview:** https://bigsplash.video/front-door/?id=aud_7f3k2&preview=1',
    '**[Approve and send](https://bigsplash-front-door.chris-bc4.workers.dev/approve?id=aud_7f3k2&key=k1)**',
    '',
    '---',
    '',
    '**Contact:** Dana Pastor (Lead Pastor)',
  ].join('\n')), desc);
  assert.ok(desc.endsWith('- [ ] Won or lost'));
  assert.equal(result.clickup.ok, true);
});

test('review Slack alert shows preview and approve links in place of the scorecard', async () => {
  const { slack } = await run(REVIEW);
  assert.equal(slack, [
    '*Front Door audit needs your review*',
    '*Grace Church*, Austin · overall B',
    'From Dana Pastor, Lead Pastor · dana@gracechurch.org · (512) 555-0142 · texts OK',
    '250 to 499 on a Sunday',
    'Held because: Two Google listings match this name; Website did not load',
    'Possible duplicate listings: 2',
    `ClickUp: <${TASK_URL}>`,
    '<https://bigsplash.video/front-door/?id=aud_7f3k2&amp;preview=1>'.replace(/^/, 'Preview: '),
    'Approve and send: <https://bigsplash-front-door.chris-bc4.workers.dev/approve?id=aud_7f3k2&amp;key=k1>',
    'Campaign: fd-launch',
  ].join('\n'));
});

// ---------- failed ----------

test('failed task says to run the audit by hand, with the error', async () => {
  const lead = { ...LEAD, event: 'failed', scorecard_url: '', grades: {}, fixes: [], households: null, error: 'Places API 429: quota' };
  const { desc, slack, result } = await run(lead);
  assert.ok(desc.startsWith('**The audit failed. Run it by hand and email the pastor.**\n> Error: Places API 429: quota\n\n---\n\n**Contact:**'), desc);
  assert.equal(slack, [
    '*Front Door audit failed*',
    '*Grace Church*, Austin · no overall grade',
    'From Dana Pastor, Lead Pastor · dana@gracechurch.org · (512) 555-0142 · texts OK',
    '250 to 499 on a Sunday',
    'Error: Places API 429: quota',
    `ClickUp: <${TASK_URL}>`,
    'No scorecard: run the audit by hand',
    'Campaign: fd-launch',
  ].join('\n'));
  assert.equal(result.clickup.ok, true);
});

// ---------- approved ----------

test('approved with a task id comments on that task and opens no new one', async () => {
  const { calls, slack, result } = await run({ ...LEAD, event: 'approved', clickup_task_id: '86abc12' });
  const posts = to(calls, 'clickup');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `${BASE}/task/86abc12/comment`);
  assert.equal(posts[0].method, 'POST');
  assert.equal(posts[0].headers.Authorization, TOKEN);
  assert.deepEqual(posts[0].body, { comment_text: 'Approved. The scorecard went to the pastor.', notify_all: false });
  assert.deepEqual(result, { clickup: { ok: true, id: '86abc12', url: 'https://app.clickup.com/t/86abc12' }, slack: { ok: true } });
  assert.ok(slack.startsWith('*Front Door audit approved*\n'));
  assert.ok(slack.includes('ClickUp (comment added): <https://app.clickup.com/t/86abc12>'));
  assert.ok(slack.includes('Scorecard: <https://bigsplash.video/front-door/?id=aud_7f3k2>'));
});

test('approved without a task id opens a task as for ready', async () => {
  const { calls, result } = await run({ ...LEAD, event: 'approved' });
  assert.equal(to(calls, 'clickup')[0].url, `${BASE}/list/${LIST}/task`);
  assert.equal(result.clickup.id, 'fd123');
});

test('approved with a malformed task id opens a task instead of commenting', async () => {
  const { calls } = await run({ ...LEAD, event: 'approved', clickup_task_id: '../list/1/task' });
  assert.equal(to(calls, 'clickup')[0].url, `${BASE}/list/${LIST}/task`);
});

test('a failed comment says so in Slack', async () => {
  const { slack, result } = await run({ ...LEAD, event: 'approved', clickup_task_id: '86abc12' }, { clickup: 404 });
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: true } });
  assert.ok(slack.includes('ClickUp comment FAILED: mark the task approved by hand'));
});

// ---------- Due date ----------

test('due date: next business day at 5 PM Central', () => {
  const at = (iso) => nextBusinessDue(Date.parse(iso), ENV);
  assert.equal(at('2026-10-16T23:00:00Z'), MONDAY_5PM, 'Friday 6 PM -> Monday 5 PM');
  assert.equal(at('2026-10-16T14:00:00Z'), MONDAY_5PM, 'Friday 9 AM -> Monday 5 PM');
  assert.equal(at('2026-10-17T15:00:00Z'), MONDAY_5PM, 'Saturday -> Monday');
  assert.equal(at('2026-10-18T20:00:00Z'), MONDAY_5PM, 'Sunday -> Monday');
  assert.equal(at('2026-10-19T14:00:00Z'), Date.parse('2026-10-20T22:00:00Z'), 'Monday -> Tuesday');
  assert.equal(at('2026-10-15T04:30:00Z'), Date.parse('2026-10-15T22:00:00Z'), 'Wednesday 11:30 PM Central -> Thursday');
  assert.equal(at('2026-10-30T23:00:00Z'), Date.parse('2026-11-02T23:00:00Z'), 'across the clock change: Monday 5 PM CST');
  assert.equal(nextBusinessDue(Date.parse('2026-10-16T23:00:00Z'), { TIMEZONE: 'America/New_York' }), Date.parse('2026-10-19T21:00:00Z'));
  assert.equal(nextBusinessDue(Date.parse('2026-10-16T23:00:00Z'), { TIMEZONE: 'Not/AZone' }), MONDAY_5PM, 'a broken zone falls back to Central');
});

test('the task due date follows the clock', async () => {
  clock = Date.parse('2026-10-19T14:00:00Z');
  const { calls } = await run(LEAD);
  assert.equal(to(calls, 'clickup')[0].body.due_date, Date.parse('2026-10-20T22:00:00Z'));
});

// ---------- Escaping ----------

const HOSTILE = '*Grace* <!channel> [win](https://evil.test) | _x_ `y` ~z~ http://evil.test &amp;';

test('a hostile church name cannot add Slack markup, pings or links', async () => {
  const lead = {
    ...REVIEW,
    church: { ...LEAD.church, name: HOSTILE, city: '<https://evil.test|Austin>' },
    contact: { ...LEAD.contact, name: '<@U123> *Boss*', role: 'Pastor\n*New line*', email: 'a_b@evil.test', phone: '<tel:1>' },
    review_reasons: ['<!here> look'],
    utm: { campaign: '<!everyone>' },
  };
  const { slack } = await run(lead);
  assert.ok(!/<!(channel|here|everyone)>/.test(slack), slack);
  assert.ok(!slack.includes('<@U123>') && !slack.includes('<https://evil') && !slack.includes('<tel:'), slack);
  assert.ok(!slack.includes('http://evil'), 'a typed address cannot become a link');
  assert.ok(slack.includes('&lt;!channel&gt;'));
  assert.ok(slack.includes('a_b@evil.test'), 'email keeps its underscore');
  const lines = slack.split('\n');
  assert.ok(lines[1].startsWith('*Grace &lt;!channel&gt; [win](https: //evil .test) | x y z http: //evil .test &amp;amp;*'), lines[1]);
  assert.equal(lines.length, 10, 'a line break in a value cannot add a line');
  // The only links are the ones the desk built.
  const links = slack.match(/<[^&]/g) || [];
  assert.equal(links.length, 3, slack);
});

test('a hostile church name cannot add markdown links, tables or list items', async () => {
  const lead = {
    ...REVIEW,
    church: { ...LEAD.church, name: HOSTILE, address: '# Heading\n- [x] done' },
    contact: { ...LEAD.contact, name: '![img](https://evil.test/a.png)', email: 'x@y.test)(javascript:alert(1)', phone: 'call [me](https://evil.test)' },
    fixes: [{ title: '# Big', why: '- [x] ticked' }, { title: '1. Fake', why: '> quote' }],
    review_reasons: ['- [x] already approved', '## Approve'],
    possible_duplicates: [{ name: '[Approve and send](https://evil.test)', address: '', reviewCount: -4 }],
    error: '',
  };
  const { calls, desc } = await run(lead);
  assert.equal(to(calls, 'clickup')[0].body.name, `${HOSTILE}, Austin`, 'task names are plain text in ClickUp');
  assert.ok(desc.includes('**Church:** \\*Grace\\* \\<!channel\\> \\[win\\](https: //evil .test) \\| _x_ \\`y\\` \\~z\\~ http: //evil .test &amp;'), desc);
  assert.ok(desc.includes('**Address:** # Heading - \\[x\\] done'), 'line breaks fold into one line');
  assert.ok(desc.includes('**Contact:** !\\[img\\](https: //evil .test/a .png) (Lead Pastor)'));
  assert.ok(desc.includes('**Email:** x@y .test)(javascript:alert(1)'), 'an odd email stays plain text, not a mailto link');
  assert.ok(!desc.includes('mailto:'));
  assert.ok(desc.includes('**Cell:** call \\[me\\](https: //evil .test)'), 'a phone with no digits is plain text');
  assert.ok(desc.includes('1. \\# Big: - \\[x\\] ticked') && desc.includes('2. 1\\. Fake: \\> quote'), desc);
  assert.ok(desc.includes('- \\- \\[x\\] already approved') && desc.includes('- \\## Approve'), desc);
  assert.ok(desc.includes('- \\[Approve and send\\](https: //evil .test)\n'), 'a negative review count is dropped');
  assert.equal((desc.match(/(?<!\\)\]\(/g) || []).length, 1, 'only the real Approve and send link is a markdown link');
  assert.equal((desc.match(/- \[ \]/g) || []).length, 4, 'only the four checklist boxes');
  assert.equal((desc.match(/^\| /gm) || []).length, 7, 'only the grades table');
});

test('links: non-http and credential-bearing addresses are dropped; parentheses are encoded', async () => {
  const lead = {
    ...REVIEW,
    scorecard_url: 'javascript:alert(1)',
    church: { ...LEAD.church, website: 'https://user:pw@evil.test/' },
    approve_url: 'https://bigsplash-front-door.chris-bc4.workers.dev/approve?id=a)(b',
    page_url: 'ftp://x.test/',
  };
  const { desc } = await run(lead);
  assert.ok(desc.includes('**Website:** None found'));
  assert.ok(desc.includes('**[Approve and send](https://bigsplash-front-door.chris-bc4.workers.dev/approve?id=a%29%28b)**'), desc);
  assert.ok(!desc.includes('**Page:**') && !desc.includes('javascript'));
  const ready = await run({ ...LEAD, scorecard_url: 'javascript:alert(1)' });
  assert.ok(ready.desc.includes('**Scorecard:** No link') && !ready.slack.includes('Scorecard:'));
});

test('telHref handles US and international numbers', () => {
  assert.equal(telHref('512.555.0142'), '+15125550142');
  assert.equal(telHref('1 (512) 555-0142'), '+15125550142');
  assert.equal(telHref('+44 20 7946 0958'), '+442079460958');
  assert.equal(telHref('call me'), '');
});

test('cleanLead caps lists and lengths', () => {
  const lead = cleanLead({
    event: 'ready',
    church: { name: 'N'.repeat(500) },
    fixes: [1, 2, 3, 4].map((n) => ({ title: `Fix ${n}`, why: 'w' })),
    review_reasons: Array.from({ length: 20 }, (_, i) => `r${i}`),
    possible_duplicates: Array.from({ length: 9 }, (_, i) => ({ name: `d${i}` })),
    households: 'lots',
    submitted_at: 'not a date',
  }, 42);
  assert.equal(lead.church.name.length, 120);
  assert.equal(lead.fixes.length, 3);
  assert.equal(lead.review_reasons.length, 10);
  assert.equal(lead.possible_duplicates.length, 5);
  assert.equal(lead.households, null);
  assert.equal(lead.submitted_at, 42);
});

// ---------- One destination failing ----------

test('ClickUp failing still sends the Slack alert, and the alert says so', async () => {
  const { calls, result, slack } = await run(LEAD, { clickup: 500 });
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: true } });
  assert.equal(to(calls, 'slack').length, 1);
  assert.ok(slack.includes('ClickUp task FAILED: add it by hand'));
  assert.ok(logs.some((l) => l.startsWith('LeadDesk ClickUp failed: ClickUp 500')), logs);
});

test('ClickUp unreachable: the log carries no secret', async () => {
  const { result } = await run(LEAD, { clickup: 'throw' });
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: true } });
  assert.ok(logs.length > 0 && noSecrets(logs.join('\n')) && logs.join('\n').includes('[hidden]'), logs);
});

test('Slack failing still opens the task', async () => {
  const { calls, result } = await run(LEAD, { slack: 'throw' });
  assert.deepEqual(result, { clickup: { ok: true, id: 'fd123', url: TASK_URL }, slack: { ok: false } });
  assert.equal(to(calls, 'clickup').length, 1);
  assert.ok(noSecrets(logs.join('\n')), logs);
});

test('both failing returns the result and never throws', async () => {
  const { result } = await run(LEAD, { clickup: 503, slack: 500 });
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: false } });
});

test('ClickUp answering with no link is reported in Slack', async () => {
  const { result, slack } = await run(LEAD, { task: { id: 'x1', url: 'javascript:1' } });
  assert.deepEqual(result.clickup, { ok: true, id: 'x1' });
  assert.ok(slack.includes('ClickUp task created, but ClickUp sent back no link'));
});

test('without FRONT_DOOR_LIST_ID no task is opened and Slack says so', async () => {
  const { calls, result, slack } = await run(LEAD, { env: without(ENV, 'FRONT_DOOR_LIST_ID') });
  assert.equal(to(calls, 'clickup').length, 0);
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: true } });
  assert.ok(slack.includes('ClickUp is not connected: add the task by hand'));
});

test('without SLACK_WEBHOOK_URL the task still opens', async () => {
  const { calls, result } = await run(LEAD, { env: without(ENV, 'SLACK_WEBHOOK_URL') });
  assert.equal(to(calls, 'slack').length, 0);
  assert.deepEqual(result.slack, { ok: false });
  assert.equal(result.clickup.ok, true);
});

test('an unknown event opens no task and posts a short note', async () => {
  const { calls, result, slack } = await run({ ...LEAD, event: '<!channel>' });
  assert.equal(to(calls, 'clickup').length, 0);
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: true } });
  assert.ok(slack.startsWith('*Front Door sent a lead the desk could not read*') && slack.includes('&lt;!channel&gt;'), slack);
});

test('garbage input never throws', async () => {
  for (const junk of [null, undefined, 'text', 7, [], { event: 'ready', church: 'x', contact: [], grades: 5, fixes: 'no', utm: null }]) {
    const { result } = await run(junk);
    assert.equal(typeof result.clickup.ok, 'boolean');
    assert.equal(typeof result.slack.ok, 'boolean');
  }
  const { calls } = await run({ event: 'ready' });
  assert.equal(to(calls, 'clickup')[0].body.name, 'Unnamed church');
});

test('the description renders without a throw for every event', () => {
  for (const event of ['ready', 'review', 'approved', 'failed']) {
    assert.ok(leadDescription(cleanLead({ ...LEAD, event }, FRIDAY_6PM), ENV).endsWith('- [ ] Won or lost'));
  }
});

// ---------- Repeats (DESK_SEEN) ----------

// A KV stand-in: get(key, 'json') and put(key, value, { expirationTtl }).
function fakeKV({ failGet = false, failPut = false } = {}) {
  const store = new Map();
  const puts = [];
  return {
    store, puts,
    async get(key, type) {
      if (failGet) throw new Error(`kv read failed with ${TOKEN}`);
      const v = store.get(key);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, options) {
      if (failPut) throw new Error('kv write failed');
      puts.push({ key, options });
      store.set(key, value);
    },
  };
}

// Calls the desk twice with one stub, as a retried Workflow step would.
async function twice(lead, kv, options = {}, second = lead) {
  const { calls, fetchImpl } = stub(options);
  const env = { ...ENV, DESK_SEEN: kv };
  const first = await frontDoorLead(lead, env, fetchImpl);
  const again = await frontDoorLead(second, env, fetchImpl);
  return { calls, first, again };
}

test('a repeated ready call opens one task and posts one alert', async () => {
  const kv = fakeKV();
  const { calls, first, again } = await twice(LEAD, kv);
  assert.equal(to(calls, 'clickup').length, 1);
  assert.equal(to(calls, 'slack').length, 1);
  assert.deepEqual(first, { clickup: { ok: true, id: 'fd123', url: TASK_URL }, slack: { ok: true } });
  assert.deepEqual(again, first, 'the repeat gets the first result back');
  assert.deepEqual(kv.puts.map((p) => p.key), ['desk:ready:aud_7f3k2', 'desk:ready:aud_7f3k2:slack']);
  assert.ok(kv.puts.every((p) => p.options.expirationTtl === SEEN_TTL_SECONDS && SEEN_TTL_SECONDS === 345600));
});

test('the same audit id under another event still delivers', async () => {
  const { calls } = await twice(LEAD, fakeKV(), {}, { ...LEAD, event: 'failed', error: 'timeout' });
  assert.equal(to(calls, 'clickup').length, 2);
  assert.equal(to(calls, 'slack').length, 2);
});

test('a double click on approve posts one comment and one alert', async () => {
  const approved = { ...LEAD, event: 'approved', clickup_task_id: 'fd123' };
  const { calls, again } = await twice(approved, fakeKV());
  assert.equal(to(calls, 'clickup').filter((c) => c.url.endsWith('/comment')).length, 1);
  assert.equal(to(calls, 'slack').length, 1);
  assert.equal(again.clickup.ok, true);
});

test('a ClickUp failure is not remembered, so the repeat tries ClickUp again', async () => {
  let n = 0;
  const clickup = () => (++n === 1 ? new Response('busy', { status: 503 }) : new Response(JSON.stringify({ id: 'fd123', url: TASK_URL }), { status: 200 }));
  const kv = fakeKV();
  const { calls, first, again } = await twice(LEAD, kv, { clickup });
  assert.equal(first.clickup.ok, false);
  assert.equal(to(calls, 'clickup').length, 2);
  assert.deepEqual(again.clickup, { ok: true, id: 'fd123', url: TASK_URL });
  assert.equal(to(calls, 'slack').length, 1, 'Slack already took the first alert');
});

test('a Slack failure is retried on the repeat with the saved task link, and no second task opens', async () => {
  let n = 0;
  const slack = () => (++n === 1 ? new Response('no', { status: 500 }) : new Response('ok', { status: 200 }));
  const { calls, first, again } = await twice(LEAD, fakeKV(), { slack });
  assert.equal(first.slack.ok, false);
  assert.equal(to(calls, 'clickup').length, 1);
  assert.equal(to(calls, 'slack').length, 2);
  assert.ok(to(calls, 'slack')[1].body.text.includes(TASK_URL));
  assert.deepEqual(again, { clickup: { ok: true, id: 'fd123', url: TASK_URL }, slack: { ok: true } });
});

test('KV failing never stops a delivery and the log carries no secret', async () => {
  for (const kv of [fakeKV({ failGet: true }), fakeKV({ failPut: true })]) {
    const { calls, first } = await twice(LEAD, kv);
    assert.deepEqual(first, { clickup: { ok: true, id: 'fd123', url: TASK_URL }, slack: { ok: true } });
    assert.ok(to(calls, 'clickup').length >= 1);
    assert.ok(noSecrets(logs.join('\n')), logs);
  }
});

test('without DESK_SEEN or an audit id, every call delivers', async () => {
  const { calls, fetchImpl } = stub();
  await frontDoorLead(LEAD, ENV, fetchImpl);
  await frontDoorLead(LEAD, ENV, fetchImpl);
  assert.equal(to(calls, 'clickup').length, 2);
  assert.ok(logs.some((l) => l.includes('DESK_SEEN is not bound')), logs);
  const noId = await twice({ ...LEAD, id: '' }, fakeKV());
  assert.equal(to(noId.calls, 'clickup').length, 2);
});

// ---------- Typed domains ----------

test('a bare www. or bare domain cannot become a link in ClickUp or Slack', async () => {
  const lead = {
    ...LEAD,
    church: { ...LEAD.church, name: 'Grace www.evil.com', city: 'evil.com' },
    contact: { ...LEAD.contact, name: 'Dana evil.co.uk', email: 'www.evil.com' },
    fixes: [{ title: 'Fix', why: '**bold** www.evil.com' }],
  };
  const { slack, desc } = await run(lead);
  assert.ok(desc.includes('**Church:** Grace www .evil .com') && desc.includes('1. Fix: \\*\\*bold\\*\\* www .evil .com'), desc);
  assert.ok(desc.includes('**Email:** www .evil .com') && desc.includes('**Contact:** Dana evil .co .uk'), desc);
  assert.ok(slack.includes('*Grace www .evil .com*, evil .com') && slack.includes('From Dana evil .co .uk') && slack.includes(' · www .evil .com · '), slack);
  for (const text of [slack, desc]) assert.ok(!/www\.evil|evil\.com|evil\.co\b/.test(text), text);
  const ok = await run({ ...LEAD, fixes: [{ title: 'Add service times', why: 'St. Mary, e.g. 3.5 stars' }] });
  assert.ok(ok.desc.includes('St. Mary, e.g. 3.5 stars'), 'abbreviations and decimals stay');
  assert.ok(ok.slack.includes('dana@gracechurch.org'), 'a real email stays whole in Slack');
});

// ---------- Morning digest: Front Door section ----------

// 13:00 UTC on Monday, October 19, 2026 is 8:00 AM Central.
const MORNING = Date.parse('2026-10-19T13:00:00Z');
const fdTask = (id, name, createdAgoHours, status = 'to do', type = 'open') => ({
  id, name, url: `https://app.clickup.test/t/${id}`, status: { status, type },
  date_created: String(MORNING - createdAgoHours * HOUR), due_date: null, date_done: null, date_closed: null,
});
const isFrontDoor = (call) => new URL(call.url).pathname.endsWith(`/list/${LIST}/task`);
const isRecent = (call) => new URL(call.url).searchParams.has('date_created_gt');

async function digest({ snapshot = [], open = [], recent = [], env = ENV, lists } = {}) {
  const { calls } = stub({
    lists: lists || ((call) => {
      if (!isFrontDoor(call)) return { tasks: snapshot, last_page: true };
      return { tasks: isRecent(call) ? recent : open, last_page: true };
    }),
  });
  await worker.scheduled({ scheduledTime: MORNING, cron: '0 13 * * *' }, env, { waitUntil() {} });
  return { calls, posts: to(calls, 'slack'), text: slackText(calls) };
}

test('digest lists Front Door leads still in "to do" after a day, and counts new ones', async () => {
  const open = [
    fdTask('w2', 'Hope Chapel, Round Rock', 30),
    fdTask('w1', 'Grace Church, Austin', 80),
    fdTask('new1', 'New Church, Hutto', 5),
    fdTask('called', 'Called Church, Taylor', 50, 'contacted', 'custom'),
    fdTask('setup', 'SETUP Front Door test', 90),
  ];
  const recent = [fdTask('new1', 'New Church, Hutto', 5), fdTask('new2', 'Closed Fast, Kyle', 3, 'won', 'closed'), fdTask('setup2', 'SETUP x', 1)];
  const { calls, posts, text } = await digest({ open, recent });
  assert.equal(posts.length, 1);
  assert.equal(text, [
    '*Front Door leads waiting on a first touch*',
    'New leads in the last 24 hours: 2',
    'Waiting: Grace Church, Austin in "to do" since Fri, Oct 16, 12:00 AM (3 days) <https://app.clickup.test/t/w1>',
    'Waiting: Hope Chapel, Round Rock in "to do" since Sun, Oct 18, 2:00 AM (30 hours) <https://app.clickup.test/t/w2>',
  ].join('\n'));
  const reads = to(calls, 'clickup').filter(isFrontDoor);
  assert.equal(reads.length, 2);
  assert.equal(new URL(reads[0].url).search, '?page=0');
  assert.equal(new URL(reads[1].url).search, `?include_closed=true&date_created_gt=${MORNING - DAY}&page=0`);
  assert.ok(reads.every((c) => c.headers.Authorization === TOKEN && c.timed));
});

test('digest puts the Front Door section after the snapshots, in one message', async () => {
  const snapshot = [{ id: 's1', name: 'Snap Church, Austin', url: 'https://app.clickup.test/t/s1', status: { status: 'to do', type: 'open' }, due_date: String(MORNING + 6 * HOUR) }];
  const { posts, text } = await digest({ snapshot, open: [fdTask('w1', 'Grace Church, Austin', 30)] });
  assert.equal(posts.length, 1);
  const [snap, fd] = text.split('\n\n');
  assert.ok(snap.startsWith('*Snapshots this morning*\nDue in the next 24 hours: Snap Church, Austin'), snap);
  assert.ok(fd.startsWith('*Front Door leads waiting on a first touch*\nNew leads in the last 24 hours: 0\nWaiting: Grace Church, Austin'), fd);
});

test('digest with new leads and none waiting says so', async () => {
  const { text } = await digest({ open: [fdTask('n', 'New, Austin', 2)], recent: [fdTask('n', 'New, Austin', 2)] });
  assert.equal(text, '*Front Door leads waiting on a first touch*\nNew leads in the last 24 hours: 1\nNo lead has waited more than a day.');
});

test('digest still posts nothing when every section is empty', async () => {
  const { posts, calls } = await digest({ open: [fdTask('c', 'Contacted, Austin', 40, 'contacted', 'custom'), fdTask('t', 'TEMPLATE lead', 99)] });
  assert.equal(posts.length, 0);
  assert.equal(to(calls, 'clickup').length, 3, 'one snapshot read and two Front Door reads');
});

test('digest runs the Front Door section alone when CLICKUP_LIST_ID is unset', async () => {
  const { calls, text } = await digest({ env: without(ENV, 'CLICKUP_LIST_ID'), open: [fdTask('w1', 'Grace Church, Austin', 30)] });
  assert.ok(to(calls, 'clickup').every(isFrontDoor));
  assert.ok(text.startsWith('*Front Door leads waiting on a first touch*'));
});

test('digest without FRONT_DOOR_LIST_ID never reads the Front Door list', async () => {
  const { calls } = await digest({ env: without(ENV, 'FRONT_DOOR_LIST_ID'), open: [fdTask('w1', 'Grace Church, Austin', 30)] });
  assert.equal(to(calls, 'clickup').filter(isFrontDoor).length, 0);
});

test('digest reports a Front Door read failure and keeps the snapshot section', async () => {
  const snapshot = [{ id: 's1', name: 'Snap Church, Austin', url: 'https://app.clickup.test/t/s1', status: { status: 'to do', type: 'open' }, due_date: String(MORNING + 6 * HOUR) }];
  const { text } = await digest({
    lists: (call) => (isFrontDoor(call) ? new Response('no', { status: 500 }) : { tasks: snapshot, last_page: true }),
  });
  assert.ok(text.startsWith('*Snapshots this morning*\n'));
  assert.ok(text.endsWith('\n\n*Front Door leads waiting on a first touch*\nThe digest could not read the Front Door list (ClickUp 500). Check it by hand.'), text);
  assert.ok(logs.includes('Digest could not read the Front Door list: ClickUp 500'), logs);
});

test('digest escapes Front Door task names', async () => {
  const { text } = await digest({ open: [fdTask('h', '<!channel> *Evil* http://x.test', 30)] });
  assert.ok(text.includes('Waiting: &lt;!channel&gt; Evil http: //x .test in "to do"'), text);
});

test('digest caps the Front Door section at 15 lines and counts the rest', async () => {
  const open = Array.from({ length: 18 }, (_, i) => fdTask(`w${i}`, `Church ${i}, Austin`, 30 + i));
  const { text } = await digest({ open });
  const lines = text.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('Waiting: Church')).length, 15);
  assert.equal(lines.at(-1), 'Waiting: and 3 more, see ClickUp');
  assert.ok(lines[2].startsWith('Waiting: Church 17, Austin'), 'oldest first');
});

// ---------- The files that ship ----------

test('wrangler.toml points at entry.js and sets FRONT_DOOR_LIST_ID', () => {
  const toml = read('wrangler.toml');
  assert.match(toml, /^\[\[kv_namespaces\]\]\nbinding = "DESK_SEEN"$/m);
  assert.match(toml, /^main = "entry\.js"$/m);
  assert.match(toml, /^FRONT_DOOR_LIST_ID = "901422444894"$/m);
  assert.match(toml, /^CLICKUP_ASSIGNEE_IDS = "112365011"$/m);
});

test('entry.js re-exports the handler and exports LeadDesk', () => {
  const entry = read('entry.js');
  assert.match(entry, /^import \{ WorkerEntrypoint \} from 'cloudflare:workers';$/m);
  assert.match(entry, /^export default worker;$/m);
  assert.match(entry, /export class LeadDesk extends WorkerEntrypoint \{\n {2}async frontDoorLead\(lead\) \{\n {4}return frontDoorLead\(lead, this\.env\);/);
});

test('no new file holds a token or a webhook address', () => {
  const shipped = ['desk.js', 'entry.js', 'wrangler.toml', 'README.md'].map(read).join('\n');
  assert.ok(!/pk_\d+_[A-Z0-9]{16,}/.test(shipped));
  assert.ok(!/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B/.test(shipped));
  assert.ok(!/leadconnectorhq\.com\/hooks\/[A-Za-z0-9]{8,}/.test(shipped));
});

// ---------- emailed and texted ----------

test('ready says the pastor was emailed and texted when the Front Door worker says so', async () => {
  const { slack, desc } = await run({ ...LEAD, emailed: true, texted: true });
  assert.equal(slack.split('\n')[4], 'Pastor emailed and texted');
  assert.ok(desc.includes('**Texts OK:** Yes\n**Scorecard emailed:** Yes\n**Scorecard texted:** Yes\n**Sunday attendance:**'), desc);
});

test('ready with no email says to send the scorecard by hand', async () => {
  const { slack, desc } = await run({ ...LEAD, emailed: false, texted: false });
  assert.ok(slack.includes('\nPastor NOT emailed: send the scorecard by hand\n'), slack);
  assert.ok(desc.includes('**Scorecard emailed:** No, send it by hand\n**Scorecard texted:** No'));
  const emailedOnly = await run({ ...LEAD, emailed: true, texted: false });
  assert.ok(emailedOnly.slack.includes('\nPastor emailed, not texted\n'));
});

test('review and failed leads never print the emailed line', async () => {
  for (const lead of [{ ...REVIEW, emailed: false, texted: false }, { ...LEAD, event: 'failed', emailed: false, texted: false, error: 'x' }]) {
    const { slack, desc } = await run(lead);
    assert.ok(!/emailed/i.test(slack) && !desc.includes('Scorecard emailed'), slack);
  }
});

test('emailed must be a real boolean; anything else prints nothing', async () => {
  const { slack } = await run({ ...LEAD, emailed: 'yes', texted: 1 });
  assert.ok(!/emailed/i.test(slack));
  assert.equal(cleanLead({ ...LEAD, emailed: 'yes' }).emailed, null);
});

test('approved with no email comments that the scorecard did not go out', async () => {
  const { calls, slack } = await run({ ...LEAD, event: 'approved', clickup_task_id: '86abc12', emailed: false, texted: false });
  assert.equal(to(calls, 'clickup')[0].body.comment_text, 'Approved, but the scorecard email did not go out. Send it by hand.');
  assert.ok(slack.includes('Pastor NOT emailed: send the scorecard by hand'));
});
