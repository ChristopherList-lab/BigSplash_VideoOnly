// The emails and texts a pastor gets from Chris, ported from front-door-funnel/EMAILS-AND-TEXTS.md.
// Each email builder takes { firstName, church, grade, topFix, scorecardUrl, walkthroughUrl, videoLive,
// address } and returns { subject, html, text }; each text builder returns { message }.
// Emails are plain and personal: paragraphs and links only, no images, no tracking. Every value is
// escaped in the HTML. videoLive is false until Chris's walkthrough video is on the page, and the copy
// says nothing about a video until then.

export const BUSINESS_ADDRESS = "1119 Ascot St., Georgetown, TX 78626";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// One line of text: no line breaks or invisible characters from a form field.
const line = (s) => String(s ?? "").replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
const link = (href) => ({ href: /^https:\/\//.test(String(href || "")) ? String(href) : "" });

function vars(v = {}) {
  return {
    first: line(v.firstName) || "Pastor",
    church: line(v.church) || "your church",
    grade: line(v.grade),
    fix: line(v.topFix),
    scorecard: v.scorecardUrl,
    walk: v.walkthroughUrl,
    video: v.videoLive === true,
    address: line(v.address) || BUSINESS_ADDRESS,
  };
}

// paragraphs: arrays of lines; a line is a string, a {href}, or an array of both. Empty lines drop out.
function render(subject, paragraphs, address) {
  const all = [...paragraphs, ["Chris List / Big Splash"], [`${address}. Reply stop and I won't email you again.`]];
  const parts = (l) => (Array.isArray(l) ? l : [l]).filter((p) => p !== null && p !== undefined && p !== "" && !(typeof p === "object" && !p.href));
  const kept = all.map((p) => p.filter((l) => parts(l).length)).filter((p) => p.length);
  const text = kept.map((p) => p.map((l) => parts(l).map((x) => (typeof x === "string" ? x : x.href)).join("")).join("\n")).join("\n\n");
  const html = kept.map((p) => `<p>${p.map((l) => parts(l).map((x) => (typeof x === "string" ? esc(x) : `<a href="${esc(x.href)}">${esc(x.href)}</a>`)).join("")).join("<br>\n")}</p>`).join("\n");
  return { subject: line(subject), html, text };
}

const gradeLine = (v) => (v.grade ? `Overall grade: ${v.grade}` : "Your grades are ready, area by area.");
const fixLine = (v) => (v.fix ? `First fix on your list: ${v.fix}` : "");
// The one booking line every email ends its pitch with.
const bookLine = (v) => ["Book a call with our team: ", link(v.walk)];

// Email 1, right after the audit: the scorecard is ready.
export function scorecardEmail(input) {
  const v = vars(input);
  return render(`Front Door scorecard for ${v.church}`, [
    [`Hi ${v.first},`],
    [`Your Front Door Audit for ${v.church} is done:`, link(v.scorecard)],
    [gradeLine(v), fixLine(v)],
    ["The audit searched for you from about 4 miles out and opened your website on a phone, the way a family new to town would before their first Sunday. Every grade on the page shows the fact behind it, so you can check our work."],
    ["If you'd like a second set of eyes, our team will go through every grade with you on a free 30-minute call and show you what we'd do first.", bookLine(v)],
  ], v.address);
}

// Email 1 for an audit Chris approved by hand after review.
export function approvedEmail(input) {
  const v = vars(input);
  return render("Your Front Door scorecard (sorry for the wait)", [
    [`Hi ${v.first},`],
    [`Sorry for the wait on this one. Something in the audit for ${v.church} needed a human look, so I checked it myself before sending your scorecard. It's ready now:`, link(v.scorecard)],
    [gradeLine(v), fixLine(v)],
    ["If you'd like to go through it together, our team will cover every grade with you on a free 30-minute call.", bookLine(v)],
    ["Thanks for your patience."],
  ], v.address);
}

// Text 1, right after email 1, only with consent. The STOP line goes on this first text.
export function scorecardText(input) {
  const v = vars(input);
  return { message: `${v.first}, Chris at Big Splash. Your scorecard: ${v.scorecard} Reply STOP to opt out` };
}

// Email 2, +1 day: the fix to start with. Null without a top fix, since the whole email is that fix.
export function fixEmail(input) {
  const v = vars(input);
  if (!v.fix) return null;
  const close = v.video
    ? ["I also recorded a 3-minute video on the two gaps I'd check first on any church scorecard, and what Big Splash does about them. It plays at the top of the booking page linked below.", bookLine(v)]
    : ["If you want to talk it through, we offer a free 30-minute call.", bookLine(v)];
  return render(`The fix I'd start with at ${v.church}`, [
    [`Hi ${v.first},`],
    ["If I were on your staff, I'd start here:"],
    [v.fix],
    ["It sits at the top of the fix list on your scorecard. A staff member or a sharp volunteer can often handle it in-house. No agency needed."],
    close,
  ], v.address);
}

// Text 2, +2 days, only with consent and only after text 1 (with its STOP line) went out. Names the business.
// One wording with or without the video: the booking page carries the video once it is live.
export function nudgeText(input) {
  const v = vars(input);
  return { message: `${v.first}, Chris at Big Splash. Book a call with our team: ${v.walk}` };
}

// Email 3, +4 days: how the 30-minute call goes.
export function callEmail(input) {
  const v = vars(input);
  return render("Before you book: the 30-minute call with our team", [
    [`Hi ${v.first},`],
    ["Before you book, here's how the 30 minutes go."],
    ["We pull up your scorecard together. Our team spends the first 15 minutes going grade by grade and showing you the two fixes we'd make first, with enough detail that your staff could do them this month."],
    ["The second 15 minutes are yours. Ask anything. If you want to know how an invitation campaign works and what it costs, ask and we'll show you. You keep the fix list either way."],
    [bookLine(v)],
  ], v.address);
}

// Email 4, +7 days: the last note.
export function lastEmail(input) {
  const v = vars(input);
  return render("Last note on your scorecard", [
    [`Hi ${v.first},`],
    ["I'll stop filling your inbox after this one."],
    [["Your scorecard stays live here: ", link(v.scorecard)]],
    [bookLine(v)],
    ["If this season is full, reply with the month that works better and I'll reach out then."],
    ["Glad to be in your corner either way."],
  ], v.address);
}
