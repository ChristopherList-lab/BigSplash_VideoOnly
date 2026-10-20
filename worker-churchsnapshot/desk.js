// LeadDesk: turns a Front Door audit into a ClickUp task and a Slack alert.
// The Front Door worker calls frontDoorLead(lead) over a service binding to the
// LeadDesk entrypoint in entry.js. Email and texts to the pastor go through
// GoHighLevel, never through here.
//
// The lead carries what a stranger typed into a public form and what Google
// says about a church, so every value is cleaned, capped and escaped before it
// reaches ClickUp or Slack.

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
  };
}

// ---------- Due date ----------

// 5 PM on the next weekday in TIMEZONE. Friday evening and the whole weekend land on Monday.
export function nextBusinessDue(now, env) {
  const p = dateParts(now, env, { year: 'numeric', month: 'numeric', day: 'numeric' });
  let day = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  do { day += DAY; } while ([0, 6].includes(new Date(day).getUTCDay()));
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
      `**Scorecard texted:** ${lead.texted ? 'Yes' : 'No'}`,
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
    lines.push(lead.emailed
      ? `Pastor emailed${lead.texted ? ' and texted' : ', not texted'}`
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
