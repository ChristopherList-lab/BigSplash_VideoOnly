// LeadDesk: turns a Front Door audit into a ClickUp task and a Slack alert.
// The Front Door worker calls frontDoorLead(lead) over a service binding to the
// LeadDesk entrypoint in entry.js. Email and texts to the pastor go through
// GoHighLevel, never through here.
//
// The lead carries what a stranger typed into a public form and what Google
// says about a church, so every value is cleaned, capped and escaped before it
// reaches ClickUp or Slack.
//
// Founding partners (the Front Door worker's Stripe checkout) come through the
// same call with two more events. "won" opens the onboarding task in the
// Church Clients list (CHURCH_CLIENTS_LIST_ID). "billing" comments on that
// task when the call names it, and posts Slack either way.

import {
  md, httpUrl, plainHref, slackText, slackEmail, slackLink, defuseDomains, scrub, tidy,
  assigneeIds, clickUpBase, formatDate, zoneLabel, dateParts,
  UPSTREAM_TIMEOUT_MS, DAY,
} from './index.js';

export const EVENTS = ['ready', 'review', 'approved', 'failed'];

export const HEADLINES = {
  ready: 'New Front Door lead',
  review: 'Front Door audit needs your review',
  failed: 'Front Door audit failed',
  approved: 'Front Door audit approved',
};

export const FRONT_DOOR_CHECKLIST = [
  'Text or call within 24 hours',
  'Walkthrough booked',
  'Proposal sent',
  'Won or lost',
];

export const APPROVED_COMMENT = 'Approved. The scorecard went to the pastor.';
export const APPROVED_NOT_SENT_COMMENT = 'Approved, but the scorecard email did not go out. Send it by hand.';

const AREAS = [
  ['overall', 'Overall'],
  ['google', 'Google listing'],
  ['reviews', 'Reviews'],
  ['website', 'Website on a phone'],
  ['social', 'Social and sermons'],
];

const GRADE = /^[A-F][+-]?$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
// Stricter than the intake's email check: only these addresses become mailto links.
const MAILTO_SAFE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const DUE_HOUR = 17;
// A Workflow step can call the desk twice for one audit. The first result is kept
// this long under desk:<event>:<audit id>, and a repeat gets it back.
export const SEEN_TTL_SECONDS = 4 * 24 * 3600;
const TASK_APP = 'https://app.clickup.com/t/';

// ---------- Cleaning ----------

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const obj = (v) => (isObj(v) ? v : {});
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

// One line of text, invisible characters gone, capped by characters.
function text(value, max) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return Array.from(tidy(raw, false)).slice(0, max).join('').trim();
}

function grade(value) {
  const g = String(value ?? '').trim().toUpperCase();
  return GRADE.test(g) ? g : null;
}

function link(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length <= 2000 ? httpUrl(s) || '' : '';
}

function when(value, now) {
  const ms = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(ms) ? ms : now;
}

export function cleanLead(raw, now = Date.now()) {
  const l = obj(raw);
  const church = obj(l.church);
  const contact = obj(l.contact);
  const grades = obj(l.grades);
  const utm = obj(l.utm);
  const taskId = String(l.clickup_task_id ?? '').trim();
  return {
    event: EVENTS.includes(l.event) ? l.event : null,
    raw_event: text(l.event, 40),
    id: text(l.id, 80),
    scorecard_url: link(l.scorecard_url),
    walkthrough_url: link(l.walkthrough_url),
    preview_url: link(l.preview_url),
    approve_url: link(l.approve_url),
    clickup_task_id: TASK_ID.test(taskId) ? taskId : '',
    church: {
      name: text(church.name, 120),
      address: text(church.address, 200),
      city: text(church.city, 120),
      website: link(church.website),
    },
    contact: {
      name: text(contact.name, 120),
      role: text(contact.role, 120),
      email: text(contact.email, 200),
      phone: text(contact.phone, 40),
      sms_consent: contact.sms_consent === true,
      attendance: text(contact.attendance, 40),
      facebook_frequency: text(contact.facebook_frequency, 80),
    },
    grades: Object.fromEntries(AREAS.map(([key]) => [key, grade(grades[key])])),
    fixes: list(l.fixes, 3).filter(isObj)
      .map((f) => ({ title: text(f.title, 120), why: text(f.why, 400) }))
      .filter((f) => f.title || f.why),
    households: count(l.households),
    review_reasons: list(l.review_reasons, 10).map((r) => text(r, 200)).filter(Boolean),
    possible_duplicates: list(l.possible_duplicates, 5).filter(isObj)
      .map((d) => ({ name: text(d.name, 120), address: text(d.address, 200), reviewCount: count(d.reviewCount) }))
      .filter((d) => d.name || d.address),
    utm: {
      source: text(utm.source, 100),
      medium: text(utm.medium, 100),
      campaign: text(utm.campaign, 100),
      content: text(utm.content, 100),
    },
    page_url: link(l.page_url),
    submitted_at: when(l.submitted_at, now),
    error: text(l.error, 300),
    // Whether the Front Door worker emailed and texted the pastor. null when the lead did not say.
    emailed: typeof l.emailed === 'boolean' ? l.emailed : null,
    texted: typeof l.texted === 'boolean' ? l.texted : null,
    // True when the text waits for texting hours (10 AM to 7 PM Central) in the follow-up run.
    text_later: l.text_later === true,
  };
}

// ---------- Due date ----------

// 5 PM on the next weekday in TIMEZONE. Friday evening and the whole weekend land on Monday.
export function nextBusinessDue(now, env) {
  return businessDue(now, env, 1);
}

// 5 PM, `days` weekdays after today in TIMEZONE.
export function businessDue(now, env, days) {
  const p = dateParts(now, env, { year: 'numeric', month: 'numeric', day: 'numeric' });
  let day = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  for (let n = 0; n < days; n++) {
    do { day += DAY; } while ([0, 6].includes(new Date(day).getUTCDay()));
  }
  const d = new Date(day);
  return zonedTime(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DUE_HOUR, env);
}

// The instant the wall clock in TIMEZONE reads y-m-d h:00. Two passes settle a clock change.
function zonedTime(y, m, d, h, env) {
  const wall = Date.UTC(y, m, d, h);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = dateParts(guess, env, {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    });
    const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    guess += wall - seen;
  }
  return guess;
}

// ---------- ClickUp text ----------

// Markdown text: escaped, "://" broken and each domain dot spaced ("www .evil .com"),
// so a typed address cannot become a link.
function mdText(value) {
  return defuseDomains(md(value).replace(/:\/\//g, ': //'));
}

// For text that starts a line or a list item: the first character cannot start
// a heading, a rule, a quote or a nested list.
function mdItem(value) {
  return mdText(value).replace(/^[-+#=_>]/, '\\$&').replace(/^(\d+)([.)])/, '$1\\$2');
}

// An address from httpUrl, safe inside markdown link parentheses.
function mdHref(url) {
  return plainHref(url).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function mailLink(email) {
  if (!email) return 'Not given';
  return MAILTO_SAFE.test(email) ? `[${md(email)}](mailto:${email})` : mdText(email);
}

// A US number becomes +1 and ten digits. Anything else keeps its digits.
export function telHref(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length >= 7 && digits.length <= 15) return (String(phone).trim().startsWith('+') ? '+' : '') + digits;
  return '';
}

function telLink(phone) {
  if (!phone) return 'Not given';
  const href = telHref(phone);
  return href ? `[${mdText(phone)}](tel:${href})` : mdText(phone);
}

// Ready and approved leads say whether the pastor got the scorecard. Other events message nobody.
// The ClickUp line for the scorecard text: sent, waiting for texting hours, not wanted, or not sent.
function textStatus(lead, c) {
  if (lead.texted) return 'Yes';
  if (lead.text_later) return 'Queued for texting hours (10 AM to 7 PM Central)';
  return c.sms_consent ? 'No' : 'No, they did not ask for texts';
}

function saysSent(lead) {
  return (lead.event === 'ready' || lead.event === 'approved') && lead.emailed !== null;
}

function place(church) {
  return church.city || church.address;
}

export function taskName(lead) {
  const name = lead.church.name || 'Unnamed church';
  return place(lead.church) ? `${name}, ${place(lead.church)}` : name;
}

function utmParts(utm) {
  return [['source', utm.source], ['campaign', utm.campaign], ['content', utm.content]]
    .filter(([, value]) => value).map(([label, value]) => `${label} ${value}`);
}

function reviewBlock(lead) {
  const lines = ['**Held for your review.** The pastor has not seen the scorecard yet.'];
  if (lead.review_reasons.length) {
    lines.push('', '**Reasons:**', ...lead.review_reasons.map((r) => `- ${mdItem(r)}`));
  }
  if (lead.possible_duplicates.length) {
    lines.push('', '**Possible duplicate listings:**', ...lead.possible_duplicates.map((d) => {
      const reviews = d.reviewCount === null ? '' : ` (${d.reviewCount} ${d.reviewCount === 1 ? 'review' : 'reviews'})`;
      return `- ${mdItem([d.name, d.address].filter(Boolean).join(', '))}${reviews}`;
    }));
  }
  lines.push('', `**Preview:** ${lead.preview_url ? plainHref(lead.preview_url) : 'No link'}`);
  lines.push(lead.approve_url ? `**[Approve and send](${mdHref(lead.approve_url)})**` : '**Approve and send:** no link came with the audit');
  return lines;
}

function failedBlock(lead) {
  return [
    '**The audit failed. Run it by hand and email the pastor.**',
    `> Error: ${lead.error ? mdText(lead.error) : 'none given'}`,
  ];
}

export function leadDescription(lead, env) {
  const c = lead.contact;
  const ch = lead.church;
  const out = [];
  if (lead.event === 'review') out.push(...reviewBlock(lead), '', '---', '');
  if (lead.event === 'failed') out.push(...failedBlock(lead), '', '---', '');

  out.push(
    `**Contact:** ${c.name ? mdText(c.name) : 'No name given'}${c.role ? ` (${mdText(c.role)})` : ''}`,
    `**Email:** ${mailLink(c.email)}`,
    `**Cell:** ${telLink(c.phone)}`,
    `**Texts OK:** ${c.sms_consent ? 'Yes' : 'No'}`,
    ...(saysSent(lead) ? [
      `**Scorecard emailed:** ${lead.emailed ? 'Yes' : 'No, send it by hand'}`,
      `**Scorecard texted:** ${textStatus(lead, c)}`,
    ] : []),
    `**Sunday attendance:** ${c.attendance ? mdText(c.attendance) : 'Not given'}`,
    `**Posts on Facebook:** ${c.facebook_frequency ? mdText(c.facebook_frequency) : 'Not given'}`,
    '',
    `**Church:** ${ch.name ? mdText(ch.name) : 'No name given'}`,
    `**Website:** ${ch.website ? plainHref(ch.website) : 'None found'}`,
    `**Address:** ${ch.address ? mdText(ch.address) : 'Not found'}`,
    '',
    '| Area | Grade |',
    '| --- | --- |',
    ...AREAS.map(([key, label]) => `| ${label} | ${lead.grades[key] || 'Not checked'} |`),
    '',
  );
  if (lead.fixes.length) {
    out.push('**Top fixes:**', ...lead.fixes.map((f, i) => `${i + 1}. ${[f.title && mdItem(f.title), f.why && mdText(f.why)].filter(Boolean).join(': ')}`), '');
  }
  out.push(
    `**Households nearby:** ${lead.households === null ? 'Not counted' : lead.households.toLocaleString('en-US')}`,
    `**Scorecard:** ${lead.scorecard_url ? plainHref(lead.scorecard_url) : 'No link'}`,
    `**Walkthrough:** ${lead.walkthrough_url ? plainHref(lead.walkthrough_url) : 'No link'}`,
    `**Came from:** ${utmParts(lead.utm).length ? mdText(utmParts(lead.utm).join(', ')) : 'No campaign tags'}`,
  );
  if (lead.page_url) out.push(`**Page:** ${plainHref(lead.page_url)}`);
  out.push(`**Submitted:** ${formatDate(lead.submitted_at, env)} ${zoneLabel(env)}`);
  if (lead.id) out.push(`**Audit id:** ${mdText(lead.id)}`);
  out.push('', '---', '', ...FRONT_DOOR_CHECKLIST.map((step) => `- [ ] ${step}`));
  return out.join('\n');
}

// ---------- Slack text ----------

function clickUpLine(lead, clickup) {
  const comment = lead.event === 'approved' && lead.clickup_task_id;
  if (clickup === null) return 'ClickUp is not connected: add the task by hand';
  if (!clickup) return comment ? 'ClickUp comment FAILED: mark the task approved by hand' : 'ClickUp task FAILED: add it by hand';
  if (!clickup.url) return 'ClickUp task created, but ClickUp sent back no link';
  return `ClickUp${comment ? ' (comment added)' : ''}: ${slackLink(clickup.url)}`;
}

export function leadSlackText(lead, clickup) {
  const c = lead.contact;
  const ch = lead.church;
  const where = place(ch);
  const contact = [
    c.name ? `From ${slackText(c.name)}${c.role ? `, ${slackText(c.role)}` : ''}` : 'From an unnamed contact',
    c.email && (MAILTO_SAFE.test(c.email) ? slackEmail(c.email) : slackText(c.email)),
    c.phone && slackText(c.phone),
    c.sms_consent ? 'texts OK' : 'no texts',
  ].filter(Boolean).join(' · ');
  const lines = [
    `*${HEADLINES[lead.event]}*`,
    `*${slackText(ch.name || 'Unnamed church')}*` + (where ? `, ${slackText(where)}` : '')
      + (lead.grades.overall ? ` · overall ${lead.grades.overall}` : ' · no overall grade'),
    contact,
    c.attendance ? `${slackText(c.attendance)} on a Sunday` : 'Sunday attendance not given',
  ];
  if (lead.event === 'review') {
    if (lead.review_reasons.length) lines.push(`Held because: ${lead.review_reasons.map(slackText).join('; ')}`);
    if (lead.possible_duplicates.length) lines.push(`Possible duplicate listings: ${lead.possible_duplicates.length}`);
  }
  if (lead.event === 'failed') lines.push(`Error: ${lead.error ? slackText(lead.error) : 'none given'}`);
  if (saysSent(lead)) {
    const textLine = lead.texted ? ' and texted'
      : lead.text_later ? '. The text goes out when texting hours open (10 AM to 7 PM Central)'
      : lead.contact.sms_consent ? ', not texted' : ', no text (they did not ask for one)';
    lines.push(lead.emailed
      ? `Pastor emailed${textLine}`
      : `Pastor NOT emailed${lead.texted ? ' (texted)' : ''}: send the scorecard by hand`);
  }
  lines.push(clickUpLine(lead, clickup));
  if (lead.event === 'review') {
    lines.push(`Preview: ${lead.preview_url ? slackLink(lead.preview_url) : 'no link'}`);
    lines.push(`Approve and send: ${lead.approve_url ? slackLink(lead.approve_url) : 'no link'}`);
  } else if (lead.scorecard_url) {
    lines.push(`Scorecard: ${slackLink(lead.scorecard_url)}`);
  } else if (lead.event === 'failed') {
    lines.push('No scorecard: run the audit by hand');
  }
  if (lead.utm.campaign) lines.push(`Campaign: ${slackText(lead.utm.campaign)}`);
  return lines.join('\n');
}

// ---------- Sending ----------

async function attempt(name, send, env) {
  try {
    return await send();
  } catch (err) {
    console.error(`LeadDesk ${name} failed:`, scrub(err?.message, env));
    return false;
  }
}

async function createLeadTask(lead, env, fetchImpl, now) {
  const res = await fetchImpl(`${clickUpBase(env)}/list/${encodeURIComponent(env.FRONT_DOOR_LIST_ID)}/task`, {
    method: 'POST',
    headers: { 'Authorization': env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: taskName(lead),
      markdown_description: leadDescription(lead, env),
      priority: 2,
      due_date: nextBusinessDue(now, env),
      due_date_time: true,
      tags: ['front-door', 'audit'],
      ...(assigneeIds(env).length ? { assignees: assigneeIds(env) } : {}),
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const task = await res.json();
  return { id: String(task?.id || '').slice(0, 40), url: httpUrl(task?.url) || '' };
}

async function commentOnTask(lead, env, fetchImpl) {
  const id = lead.clickup_task_id;
  const res = await fetchImpl(`${clickUpBase(env)}/task/${encodeURIComponent(id)}/comment`, {
    method: 'POST',
    headers: { 'Authorization': env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment_text: lead.emailed === false ? APPROVED_NOT_SENT_COMMENT : APPROVED_COMMENT, notify_all: false }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ClickUp comment ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { id, url: TASK_APP + encodeURIComponent(id) };
}

async function postSlack(env, text, fetchImpl) {
  const res = await fetchImpl(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return true;
}

// ---------- Repeats ----------

// The Front Door worker sends each event from a Workflow step, and a step can run
// again after the desk already did its work. DESK_SEEN (KV) remembers each
// destination that took a delivery, under desk:<event>:<audit id> for ClickUp and
// desk:<event>:<audit id>:slack for Slack, so a repeat opens no second task and
// posts no second alert. A destination that failed gets tried again on a repeat.
function seenKeys(lead) {
  if (!lead.event || !lead.id) return null;
  const base = `desk:${lead.event}:${lead.id}`;
  return { clickup: base, slack: base + ':slack' };
}

async function recall(key, env) {
  try {
    const saved = await env.DESK_SEEN.get(key, 'json');
    return isObj(saved) && saved.ok === true ? saved : null;
  } catch (err) {
    console.error('LeadDesk could not read DESK_SEEN:', scrub(err?.message, env));
    return null;
  }
}

async function remember(key, value, env) {
  try {
    await env.DESK_SEEN.put(key, JSON.stringify(value), { expirationTtl: SEEN_TTL_SECONDS });
  } catch (err) {
    console.error('LeadDesk could not write DESK_SEEN:', scrub(err?.message, env));
  }
}

// Returns { clickup: { ok, id?, url? }, slack: { ok } } and never throws.
// ClickUp goes first so Slack can carry the task link. One failing never stops the other.
// A repeat of an event and audit id gets the first result back and sends nothing twice.
export async function frontDoorLead(raw, env = {}, fetchImpl = (...args) => fetch(...args)) {
  if (isObj(raw) && CLIENT_EVENTS.includes(raw.event)) return clientEvent(raw, env, fetchImpl);
  const result = { clickup: { ok: false }, slack: { ok: false } };
  try {
    const now = Date.now();
    const lead = cleanLead(raw, now);
    const slackOn = Boolean(env.SLACK_WEBHOOK_URL);

    if (!lead.event) {
      console.error('LeadDesk got an unknown event:', lead.raw_event || '(none)');
      if (slackOn) {
        const note = `*Front Door sent a lead the desk could not read*\nEvent: ${slackText(lead.raw_event || 'none')} · church: ${slackText(lead.church.name || 'none')}\nCheck the Front Door worker log.`;
        result.slack.ok = Boolean(await attempt('Slack', () => postSlack(env, note, fetchImpl), env));
      }
      return result;
    }

    const keys = env.DESK_SEEN ? seenKeys(lead) : null;
    if (!env.DESK_SEEN) console.error('LeadDesk: DESK_SEEN is not bound, so a repeated call opens a second task');
    const seen = keys
      ? { clickup: await recall(keys.clickup, env), slack: await recall(keys.slack, env) }
      : { clickup: null, slack: null };
    if (seen.clickup && seen.slack) {
      console.error(`LeadDesk: ${keys.clickup} was already delivered, so nothing went out again`);
      return { clickup: seen.clickup, slack: seen.slack };
    }

    let clickup = null;
    if (seen.clickup) {
      clickup = seen.clickup;
    } else if (env.CLICKUP_TOKEN && env.FRONT_DOOR_LIST_ID) {
      const comment = lead.event === 'approved' && lead.clickup_task_id;
      clickup = await attempt('ClickUp', () => (comment ? commentOnTask(lead, env, fetchImpl) : createLeadTask(lead, env, fetchImpl, now)), env);
    } else {
      console.error('LeadDesk: ClickUp is not configured (CLICKUP_TOKEN or FRONT_DOOR_LIST_ID missing)');
    }
    if (clickup) result.clickup = { ok: true, ...(clickup.id ? { id: clickup.id } : {}), ...(clickup.url ? { url: clickup.url } : {}) };
    // Saved before Slack goes out, so a run cut off between the two never opens a second task.
    if (keys && result.clickup.ok && !seen.clickup) await remember(keys.clickup, result.clickup, env);

    if (seen.slack) {
      result.slack = seen.slack;
    } else if (slackOn) {
      result.slack.ok = Boolean(await attempt('Slack', () => postSlack(env, leadSlackText(lead, clickup), fetchImpl), env));
      if (keys && result.slack.ok) await remember(keys.slack, result.slack, env);
    } else {
      console.error('LeadDesk: Slack is not configured (SLACK_WEBHOOK_URL missing)');
    }
  } catch (err) {
    console.error('LeadDesk failed:', scrub(err?.message, env));
  }
  return result;
}

// ---------- Founding partners: won and billing ----------

export const CLIENT_EVENTS = ['won', 'billing'];

export const ONBOARDING_CHECKLIST = [
  'Book the kickoff call',
  'Schedule the filming day',
  'Collect logos, service times and kids info',
  'Build the plan-your-visit page',
  'Load follow-up texts and emails',
  'Launch the campaign',
  'Start monthly billing from the link above',
];

export const BILLING_HEADLINES = {
  started: 'Monthly billing set',
  invoice_paid: 'Monthly payment received',
  invoice_failed: 'Monthly payment FAILED',
  canceled: 'Monthly billing ended',
  bank_processing: 'Founding bank payment processing',
  bank_failed: 'Founding bank payment FAILED',
  // Two churches paid for the last founding spot. The Front Door sends nothing to the church until Chris decides.
  oversold: 'OVERSOLD: refund or honor this church',
};

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{4,100}$/;
const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);
const dollars = (n) => (n === null ? 'an unknown amount' : '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

export function cleanClient(raw, now = Date.now()) {
  const l = obj(raw);
  const church = obj(l.church);
  const contact = obj(l.contact);
  const utm = obj(l.utm);
  const taskId = String(l.clickup_task_id ?? '').trim();
  const sid = String(l.session_id ?? '').trim();
  const customer = String(l.stripe_customer ?? '').trim();
  return {
    event: CLIENT_EVENTS.includes(l.event) ? l.event : null,
    id: text(l.id, 100),
    kind: Object.hasOwn(BILLING_HEADLINES, l.kind) ? l.kind : '',
    session_id: SESSION_ID.test(sid) ? sid : '',
    church: { name: text(church.name, 120), website: link(church.website) },
    contact: {
      name: text(contact.name, 120),
      role: text(contact.role, 120),
      email: text(contact.email, 200),
      phone: text(contact.phone, 40),
    },
    term: ['12', '6'].includes(String(l.term)) ? String(l.term) : '',
    monthly_amount: money(l.monthly_amount),
    amount_paid: money(l.amount_paid),
    paid_by: l.paid_by === 'bank' ? 'bank' : 'card',
    stripe_customer: CUSTOMER_ID.test(customer) ? customer : '',
    agreement_summary: text(l.agreement_summary, 600),
    start_monthly_url: link(l.start_monthly_url),
    audit_id: text(l.audit_id, 80),
    utm: { source: text(utm.source, 100), medium: text(utm.medium, 100), campaign: text(utm.campaign, 100), content: text(utm.content, 100) },
    spots_left: count(l.spots_left),
    spots_total: count(l.spots_total),
    emailed: typeof l.emailed === 'boolean' ? l.emailed : null,
    paid_at: when(l.paid_at, now),
    clickup_task_id: TASK_ID.test(taskId) ? taskId : '',
    message: text(l.message, 500),
    link: link(l.link),
  };
}

export function clientTaskName(c) {
  return `Onboard ${c.church.name || 'Unnamed church'}: founding partner`;
}

function termText(c) {
  const months = c.term === '6' ? 6 : 12;
  return `${months} months at ${dollars(c.monthly_amount)}/month. Billing starts 30 days after launch (month 1 is included).`;
}

// The Stripe dashboard page for the customer, test or live to match the checkout.
function customerLink(c) {
  if (!c.stripe_customer) return 'Not given';
  const test = c.session_id.startsWith('cs_test_') ? 'test/' : '';
  return `[${c.stripe_customer}](https://dashboard.stripe.com/${test}customers/${c.stripe_customer})`;
}

export function clientDescription(c, env) {
  const ct = c.contact;
  const out = [
    `**Founding partner.** Paid ${dollars(c.amount_paid)} by ${c.paid_by} on ${formatDate(c.paid_at, env)} ${zoneLabel(env)}. Month 1 of the term is included.`,
    '',
    `**Contact:** ${ct.name ? mdText(ct.name) : 'No name given'}${ct.role ? ` (${mdText(ct.role)})` : ''}`,
    `**Email:** ${mailLink(ct.email)}`,
    `**Cell:** ${telLink(ct.phone)}`,
    `**Church:** ${c.church.name ? mdText(c.church.name) : 'No name given'}`,
    `**Website:** ${c.church.website ? plainHref(c.church.website) : 'None given'}`,
    `**Term:** ${termText(c)}`,
    `**Stripe customer:** ${customerLink(c)}`,
    `**Checkout session:** ${c.session_id || 'Not given'}`,
    `**Agreement:** ${c.agreement_summary ? mdText(c.agreement_summary) : 'No agreement summary came with the payment'}`,
  ];
  if (c.emailed !== null) out.push(`**Welcome email:** ${c.emailed ? 'Sent' : 'Not sent, send it by hand'}`);
  if (c.audit_id) out.push(`**Front Door audit:** ${mdText(c.audit_id)}`);
  out.push(`**Came from:** ${utmParts(c.utm).length ? mdText(utmParts(c.utm).join(', ')) : 'No campaign tags'}`);
  if (c.spots_left !== null) out.push(`**Founding spots left:** ${c.spots_left}${c.spots_total !== null ? ` of ${c.spots_total}` : ''}`);
  out.push(
    '',
    c.start_monthly_url
      ? `**[Start monthly billing](${mdHref(c.start_monthly_url)})** once the campaign launches.`
      : '**Start monthly billing:** no link came with the payment. Set up the subscription in Stripe.',
    '',
    '---',
    '',
    ...ONBOARDING_CHECKLIST.map((step) => `- [ ] ${step}`),
  );
  return out.join('\n');
}

export function billingComment(c) {
  return [`${BILLING_HEADLINES[c.kind] || 'Billing'}: ${c.message || 'no details'}`, c.link ? `Payment page: ${plainHref(c.link)}` : ''].filter(Boolean).join('\n');
}

function clientClickUpLine(c, clickup) {
  if (c.event === 'billing') {
    if (!c.clickup_task_id) return '';
    if (clickup === null) return 'ClickUp is not connected: note this on the client task by hand';
    if (!clickup) return 'ClickUp comment FAILED: note this on the client task by hand';
    return `ClickUp (comment added): ${slackLink(clickup.url)}`;
  }
  if (clickup === null) return 'ClickUp is not connected: add the onboarding task by hand';
  if (!clickup) return 'ClickUp task FAILED: add the onboarding task by hand';
  if (!clickup.url) return 'ClickUp task created, but ClickUp sent back no link';
  return `ClickUp: ${slackLink(clickup.url)}`;
}

export function clientSlackText(c, clickup) {
  const name = `*${slackText(c.church.name || 'Unnamed church')}*`;
  if (c.event === 'billing') {
    return [
      `*${BILLING_HEADLINES[c.kind] || 'Founding billing'}*`,
      name,
      c.message ? slackText(c.message) : '',
      c.link ? `Payment page: ${slackLink(c.link)}` : '',
      clientClickUpLine(c, clickup),
    ].filter(Boolean).join('\n');
  }
  const ct = c.contact;
  return [
    '*New founding partner*',
    `${name} · paid ${dollars(c.amount_paid)} by ${c.paid_by}`,
    [ct.name ? `From ${slackText(ct.name)}${ct.role ? `, ${slackText(ct.role)}` : ''}` : 'From an unnamed contact',
      ct.email && (MAILTO_SAFE.test(ct.email) ? slackEmail(ct.email) : slackText(ct.email)), ct.phone && slackText(ct.phone)].filter(Boolean).join(' · '),
    termText(c),
    c.emailed === null ? '' : c.emailed ? 'Welcome email sent' : 'Welcome email NOT sent: send it by hand',
    clientClickUpLine(c, clickup),
    c.start_monthly_url ? `Start monthly billing after launch: ${slackLink(c.start_monthly_url)}` : 'No start-billing link: set up the subscription in Stripe',
    c.spots_left !== null ? `Founding spots left: ${c.spots_left}${c.spots_total !== null ? ` of ${c.spots_total}` : ''}` : '',
  ].filter(Boolean).join('\n');
}

async function createClientTask(c, env, fetchImpl, now) {
  const res = await fetchImpl(`${clickUpBase(env)}/list/${encodeURIComponent(env.CHURCH_CLIENTS_LIST_ID)}/task`, {
    method: 'POST',
    headers: { 'Authorization': env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: clientTaskName(c),
      markdown_description: clientDescription(c, env),
      priority: 1,
      due_date: businessDue(now, env, 2),
      due_date_time: true,
      tags: ['founding-partner', 'onboarding'],
      ...(assigneeIds(env).length ? { assignees: assigneeIds(env) } : {}),
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const task = await res.json();
  return { id: String(task?.id || '').slice(0, 40), url: httpUrl(task?.url) || '' };
}

async function commentOnClient(c, env, fetchImpl) {
  const id = c.clickup_task_id;
  const res = await fetchImpl(`${clickUpBase(env)}/task/${encodeURIComponent(id)}/comment`, {
    method: 'POST',
    headers: { 'Authorization': env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment_text: billingComment(c), notify_all: false }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ClickUp comment ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { id, url: TASK_APP + encodeURIComponent(id) };
}

// Same contract and repeat protection as frontDoorLead: { clickup: { ok, id?, url? }, slack: { ok } },
// never throws, and desk:<event>:<id> in DESK_SEEN stops a second task, comment or alert.
// "billing" with no clickup_task_id posts Slack only, and reports clickup { ok: false }.
export async function clientEvent(raw, env = {}, fetchImpl = (...args) => fetch(...args)) {
  const result = { clickup: { ok: false }, slack: { ok: false } };
  try {
    const now = Date.now();
    const c = cleanClient(raw, now);
    if (!c.event || !c.id || (c.event === 'billing' && !c.kind)) {
      console.error('LeadDesk got a founding event it could not read:', c.event || '(none)', c.kind || '');
      return result;
    }
    const keys = env.DESK_SEEN ? seenKeys(c) : null;
    if (!env.DESK_SEEN) console.error('LeadDesk: DESK_SEEN is not bound, so a repeated call can post twice');
    const seen = keys ? { clickup: await recall(keys.clickup, env), slack: await recall(keys.slack, env) } : { clickup: null, slack: null };
    const wantsClickUp = c.event === 'won' || Boolean(c.clickup_task_id);
    if ((seen.clickup || !wantsClickUp) && seen.slack) {
      console.error(`LeadDesk: ${keys.clickup} was already delivered, so nothing went out again`);
      return { clickup: seen.clickup || result.clickup, slack: seen.slack };
    }

    let clickup = null;
    if (seen.clickup) {
      clickup = seen.clickup;
    } else if (!wantsClickUp) {
      clickup = undefined;
    } else if (env.CLICKUP_TOKEN && (c.event === 'billing' || env.CHURCH_CLIENTS_LIST_ID)) {
      clickup = await attempt('ClickUp', () => (c.event === 'won' ? createClientTask(c, env, fetchImpl, now) : commentOnClient(c, env, fetchImpl)), env);
    } else {
      console.error('LeadDesk: ClickUp is not configured (CLICKUP_TOKEN or CHURCH_CLIENTS_LIST_ID missing)');
    }
    if (clickup) result.clickup = { ok: true, ...(clickup.id ? { id: clickup.id } : {}), ...(clickup.url ? { url: clickup.url } : {}) };
    if (keys && result.clickup.ok && !seen.clickup) await remember(keys.clickup, result.clickup, env);

    if (seen.slack) {
      result.slack = seen.slack;
    } else if (env.SLACK_WEBHOOK_URL) {
      result.slack.ok = Boolean(await attempt('Slack', () => postSlack(env, clientSlackText(c, clickup === undefined ? null : clickup), fetchImpl), env));
      if (keys && result.slack.ok) await remember(keys.slack, result.slack, env);
    } else {
      console.error('LeadDesk: Slack is not configured (SLACK_WEBHOOK_URL missing)');
    }
  } catch (err) {
    console.error('LeadDesk failed:', scrub(err?.message, env));
  }
  return result;
}
