// Tests for LeadDesk's founding partner events, "won" and "billing" (desk.js clientEvent).
// Run from the worker folder: node --test test/desk-founding.test.mjs
// Every outbound call goes to a stub. Nothing here reaches ClickUp or Slack.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frontDoorLead, businessDue, nextBusinessDue, cleanClient, clientDescription, ONBOARDING_CHECKLIST } from '../desk.js';

const HOUR = 3600 * 1000;
// Tuesday, October 20, 2026, 11:00 AM Central (CDT).
const TUESDAY_11AM = Date.parse('2026-10-20T16:00:00Z');
// Thursday, October 22, 2026, 5:00 PM Central.
const THURSDAY_5PM = Date.parse('2026-10-22T22:00:00Z');
// Friday, October 30, 2026, 4:00 PM Central, and Tuesday Nov 3 at 5 PM CST (after the clocks fall back).
const FRIDAY_4PM = Date.parse('2026-10-30T21:00:00Z');
const TUESDAY_NOV3_5PM = Date.parse('2026-11-03T23:00:00Z');

const realNow = Date.now;
let clock = TUESDAY_11AM;
Date.now = () => clock;
const logs = [];
const realError = console.error;
console.error = (...parts) => logs.push(parts.join(' '));
after(() => { Date.now = realNow; console.error = realError; });
beforeEach(() => { clock = TUESDAY_11AM; logs.length = 0; });

const BASE = 'https://clickup.test/api/v2';
const SLACK = 'https://hooks.slack.test/services/T000/B000/not-a-real-webhook';
const TOKEN = 'test-token-not-real-0123456789';
const CLIENTS = '901421227438';
const TASK_URL = 'https://app.clickup.test/t/cl123';

const ENV = {
  CLICKUP_TOKEN: TOKEN, CLICKUP_LIST_ID: '901421191181', FRONT_DOOR_LIST_ID: '901422444894', CHURCH_CLIENTS_LIST_ID: CLIENTS,
  CLICKUP_ASSIGNEE_IDS: '112365011', SLACK_WEBHOOK_URL: SLACK, TIMEZONE: 'America/Chicago', CLICKUP_API_BASE: BASE,
};

const WON = {
  event: 'won',
  id: 'cs_test_a1B2c3D4e5F6g7H8',
  session_id: 'cs_test_a1B2c3D4e5F6g7H8',
  church: { name: 'City Reach Church', website: 'https://cityreachchurch.com/' },
  contact: { name: 'Pat Rivera', role: 'Lead Pastor', email: 'pat@cityreach.example', phone: '+15125550142' },
  term: '12',
  monthly_amount: 1497,
  amount_paid: 3500,
  paid_by: 'card',
  stripe_customer: 'cus_Test123abc',
  agreement_summary: 'Checked "I agree to the Founding Partnership Terms" and "I\'m authorized to sign for City Reach Church" on the founding form. Terms version 2026-10-20, agreed 2026-10-20T15:58:00.000Z, IP hash 0123456789abcdef.',
  start_monthly_url: 'https://bigsplash-front-door.chris-bc4.workers.dev/founding/start?session=cs_test_a1B2c3D4e5F6g7H8&t=abc123',
  audit_id: 'city-reach-church-1a2b3c4d',
  utm: { source: 'facebook', medium: 'paid', campaign: 'founding', content: '' },
  spots_left: 3,
  spots_total: 5,
  emailed: true,
  paid_at: '2026-10-20T16:00:00.000Z',
};

const billing = (x = {}) => ({ event: 'billing', id: 'started-cs_test_a1B2c3D4e5F6g7H8', kind: 'started', session_id: WON.session_id, church: { name: 'City Reach Church' },
  clickup_task_id: 'cl123', message: 'Monthly billing starts November 19, 2026 at $1,497', link: '', ...x });

function kv() {
  const m = new Map();
  return { m, async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } };
}

function stub({ clickup = 'ok', slack = 'ok' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null, timed: init.signal instanceof AbortSignal };
    calls.push(call);
    const reply = (mode, okBody) => {
      if (mode === 'throw') throw new Error(`connect failed with ${TOKEN}`);
      if (mode === 'ok') return new Response(JSON.stringify(okBody), { status: 200 });
      return new Response('no', { status: mode });
    };
    if (call.url.startsWith(BASE)) { call.to = 'clickup'; return reply(clickup, call.url.endsWith('/comment') ? { id: '9' } : { id: 'cl123', url: TASK_URL }); }
    if (call.url === SLACK) { call.to = 'slack'; return reply(slack, {}); }
    throw new Error('Test tried to reach a real address: ' + call.url);
  };
  return { calls, fetchImpl };
}
const to = (calls, name) => calls.filter((c) => c.to === name);

async function run(payload, { env = ENV, ...opts } = {}) {
  const { calls, fetchImpl } = stub(opts);
  const result = await frontDoorLead(payload, env, fetchImpl);
  return { calls, result, slack: to(calls, 'slack')[0]?.body.text || '', task: to(calls, 'clickup')[0] };
}

// ---------- won ----------

test('won opens one urgent onboarding task in Church Clients, due in 2 business days', async () => {
  const { calls, result, task } = await run(WON);
  assert.equal(to(calls, 'clickup').length, 1);
  assert.equal(task.method, 'POST');
  assert.equal(task.url, `${BASE}/list/${CLIENTS}/task`);
  assert.equal(task.headers.Authorization, TOKEN);
  assert.ok(task.timed);
  assert.equal(task.body.name, 'Onboard City Reach Church: founding partner');
  assert.equal(task.body.priority, 1);
  assert.equal(task.body.due_date, THURSDAY_5PM);
  assert.equal(task.body.due_date_time, true);
  assert.deepEqual(task.body.assignees, [112365011]);
  assert.deepEqual(task.body.tags, ['founding-partner', 'onboarding']);
  assert.deepEqual(result, { clickup: { ok: true, id: 'cl123', url: TASK_URL }, slack: { ok: true } });
});

test('won description carries contact, term, amounts, Stripe customer, agreement, start link and checklist', async () => {
  const { task } = await run(WON);
  const d = task.body.markdown_description;
  assert.equal(d, [
    '**Founding partner.** Paid $3,500 by card on Tue, Oct 20, 11:00 AM Central. Month 1 of the term is included.',
    '',
    '**Contact:** Pat Rivera (Lead Pastor)',
    '**Email:** [pat@cityreach.example](mailto:pat@cityreach.example)',
    '**Cell:** [+15125550142](tel:+15125550142)',
    '**Church:** City Reach Church',
    '**Website:** https://cityreachchurch.com/',
    '**Term:** 12 months at $1,497/month. Billing starts 30 days after launch (month 1 is included).',
    '**Stripe customer:** [cus_Test123abc](https://dashboard.stripe.com/test/customers/cus_Test123abc)',
    '**Checkout session:** cs_test_a1B2c3D4e5F6g7H8',
    `**Agreement:** Checked "I agree to the Founding Partnership Terms" and "I'm authorized to sign for City Reach Church" on the founding form. Terms version 2026-10-20, agreed 2026-10-20T15:58:00.000Z, IP hash 0123456789abcdef.`,
    '**Welcome email:** Sent',
    '**Front Door audit:** city-reach-church-1a2b3c4d',
    '**Came from:** source facebook, campaign founding',
    '**Founding spots left:** 3 of 5',
    '',
    '**[Start monthly billing](https://bigsplash-front-door.chris-bc4.workers.dev/founding/start?session=cs_test_a1B2c3D4e5F6g7H8&t=abc123)** once the campaign launches.',
    '',
    '---',
    '',
    '- [ ] Book the kickoff call',
    '- [ ] Schedule the filming day',
    '- [ ] Collect logos, service times and kids info',
    '- [ ] Build the plan-your-visit page',
    '- [ ] Load follow-up texts and emails',
    '- [ ] Launch the campaign',
    '- [ ] Start monthly billing from the link above',
  ].join('\n'));
  assert.equal(ONBOARDING_CHECKLIST.length, 7);
});

test('won Slack alert names the church, payment, term, ClickUp and start link', async () => {
  const { slack } = await run(WON);
  assert.equal(slack, [
    '*New founding partner*',
    '*City Reach Church* · paid $3,500 by card',
    'From Pat Rivera, Lead Pastor · pat@cityreach.example · +15125550142',
    '12 months at $1,497/month. Billing starts 30 days after launch (month 1 is included).',
    'Welcome email sent',
    `ClickUp: <${TASK_URL}>`,
    '<https://bigsplash-front-door.chris-bc4.workers.dev/founding/start?session=cs_test_a1B2c3D4e5F6g7H8&amp;t=abc123>'.replace(/^/, 'Start monthly billing after launch: '),
    'Founding spots left: 3 of 5',
  ].join('\n'));
});

test('won: a live session links the live Stripe dashboard, a 6 month term shows $1,697, a bank payment says bank', () => {
  const c = cleanClient({ ...WON, session_id: 'cs_live_Z9y8X7w6V5u4', term: '6', monthly_amount: 1697, paid_by: 'bank', emailed: false }, TUESDAY_11AM);
  const d = clientDescription(c, ENV);
  assert.ok(d.includes('(https://dashboard.stripe.com/customers/cus_Test123abc)'));
  assert.ok(d.includes('**Term:** 6 months at $1,697/month.'));
  assert.ok(d.includes('Paid $3,500 by bank'));
  assert.ok(d.includes('**Welcome email:** Not sent, send it by hand'));
});

test('won: typed values cannot become links or markdown, and bad ids drop out', async () => {
  const { task, slack } = await run({ ...WON, church: { name: '[click](https://evil.example) <!channel>', website: 'javascript:alert(1)' }, stripe_customer: 'cus_x](evil', session_id: 'nope', start_monthly_url: 'javascript:alert(1)' });
  const d = task.body.markdown_description;
  assert.ok(!d.includes('](https://evil'), d);
  assert.ok(d.includes('**Website:** None given'));
  assert.ok(d.includes('**Stripe customer:** Not given'));
  assert.ok(d.includes('**Start monthly billing:** no link came with the payment'));
  assert.ok(!slack.includes('<!channel>'));
  assert.ok(slack.includes('No start-billing link'));
});

test('won: a ClickUp failure still posts Slack, which says to add the task by hand', async () => {
  const { result, slack } = await run(WON, { clickup: 500 });
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: true } });
  assert.ok(slack.includes('ClickUp task FAILED: add the onboarding task by hand'));
  assert.ok(logs.every((l) => !l.includes(TOKEN)));
});

test('won without CHURCH_CLIENTS_LIST_ID opens no task and says so', async () => {
  const env = { ...ENV };
  delete env.CHURCH_CLIENTS_LIST_ID;
  const { calls, slack } = await run(WON, { env });
  assert.equal(to(calls, 'clickup').length, 0);
  assert.ok(slack.includes('ClickUp is not connected: add the onboarding task by hand'));
});

test('won twice (a retried Workflow step) opens one task and posts one alert', async () => {
  const env = { ...ENV, DESK_SEEN: kv() };
  const first = await run(WON, { env });
  const second = await run(WON, { env });
  assert.equal(to(first.calls, 'clickup').length, 1);
  assert.equal(second.calls.length, 0);
  assert.deepEqual(second.result, first.result);
  assert.ok(env.DESK_SEEN.m.has(`desk:won:${WON.id}`));
  assert.ok(env.DESK_SEEN.m.has(`desk:won:${WON.id}:slack`));
});

// ---------- billing ----------

test('billing with a task id comments on the client task and posts Slack', async () => {
  const { calls, result, slack } = await run(billing());
  const c = to(calls, 'clickup');
  assert.equal(c.length, 1);
  assert.equal(c[0].url, `${BASE}/task/cl123/comment`);
  assert.deepEqual(c[0].body, { comment_text: 'Monthly billing set: Monthly billing starts November 19, 2026 at $1,497', notify_all: false });
  assert.deepEqual(result, { clickup: { ok: true, id: 'cl123', url: 'https://app.clickup.com/t/cl123' }, slack: { ok: true } });
  assert.equal(slack, ['*Monthly billing set*', '*City Reach Church*', 'Monthly billing starts November 19, 2026 at $1,497', 'ClickUp (comment added): <https://app.clickup.com/t/cl123>'].join('\n'));
});

test('billing with no task id posts Slack only', async () => {
  const { calls, result, slack } = await run(billing({ kind: 'bank_processing', id: 'bank_processing-cs_test_a1B2c3D4e5F6g7H8', clickup_task_id: '', message: 'City Reach Church chose to pay by bank. The payment is processing.' }));
  assert.equal(to(calls, 'clickup').length, 0);
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: true } });
  assert.equal(slack, '*Founding bank payment processing*\n*City Reach Church*\nCity Reach Church chose to pay by bank. The payment is processing.');
});

test('a failed monthly payment carries the payment page link', async () => {
  const { calls, slack } = await run(billing({ kind: 'invoice_failed', id: 'invoice_failed-in_1', message: 'The $1,497 monthly payment from City Reach Church failed.', link: 'https://invoice.stripe.com/i/acct_1/test_x' }));
  assert.ok(to(calls, 'clickup')[0].body.comment_text.endsWith('Payment page: https://invoice.stripe.com/i/acct_1/test_x'));
  assert.ok(slack.startsWith('*Monthly payment FAILED*'));
  assert.ok(slack.includes('Payment page: <https://invoice.stripe.com/i/acct_1/test_x>'));
});

test('each billing kind has its headline', async () => {
  const want = { invoice_paid: 'Monthly payment received', canceled: 'Monthly billing ended', bank_failed: 'Founding bank payment FAILED', started: 'Monthly billing set' };
  for (const [kind, head] of Object.entries(want)) {
    const { slack } = await run(billing({ kind, id: `${kind}-x` }));
    assert.ok(slack.startsWith(`*${head}*`), slack);
  }
});

test('an oversold founding payment posts a distinct Slack alert and opens no task', async () => {
  const { calls, result, slack } = await run(billing({ kind: 'oversold', id: 'oversold-won-cs_test_a1B2c3D4e5F6g7H8', clickup_task_id: '', message: 'City Reach Church paid $3,500 by card after all 5 founding spots were taken.' }));
  assert.equal(to(calls, 'clickup').length, 0);
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: true } });
  assert.ok(slack.startsWith('*OVERSOLD: refund or honor this church*\n*City Reach Church*'), slack);
});

test('billing with an unknown kind sends nothing', async () => {
  const { calls, result } = await run(billing({ kind: '<!channel>' }));
  assert.equal(calls.length, 0);
  assert.deepEqual(result, { clickup: { ok: false }, slack: { ok: false } });
});

test('billing repeated posts one comment and one alert', async () => {
  const env = { ...ENV, DESK_SEEN: kv() };
  await run(billing(), { env });
  const second = await run(billing(), { env });
  assert.equal(second.calls.length, 0);
  const slackOnly = billing({ clickup_task_id: '', id: 'invoice_paid-in_9', kind: 'invoice_paid' });
  await run(slackOnly, { env });
  const again = await run(slackOnly, { env });
  assert.equal(again.calls.length, 0);
});

test('billing comment failure says to note it by hand', async () => {
  const { slack, result } = await run(billing(), { clickup: 'throw' });
  assert.equal(result.clickup.ok, false);
  assert.ok(slack.includes('ClickUp comment FAILED: note this on the client task by hand'));
  assert.ok(logs.every((l) => !l.includes(TOKEN)));
});

// ---------- due dates and config ----------

test('2 business days skips the weekend and holds 5 PM across the clock change', () => {
  assert.equal(businessDue(TUESDAY_11AM, ENV, 2), THURSDAY_5PM);
  assert.equal(businessDue(FRIDAY_4PM, ENV, 2), TUESDAY_NOV3_5PM);
  assert.equal(nextBusinessDue(TUESDAY_11AM, ENV), Date.parse('2026-10-21T22:00:00Z'));
  assert.equal(THURSDAY_5PM - TUESDAY_11AM, 2 * 24 * HOUR + 6 * HOUR);
});

test('wrangler.toml sets the Church Clients list', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /^CHURCH_CLIENTS_LIST_ID = "901421227438"$/m);
});
