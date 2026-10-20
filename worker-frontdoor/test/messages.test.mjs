// The pastor's emails and texts: copy from EMAILS-AND-TEXTS.md, safe HTML, sensible fallbacks.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scorecardEmail, approvedEmail, scorecardText, fixEmail, nudgeText, callEmail, lastEmail } from "../src/messages.js";

const ID = "city-reach-church-1a2b3c4d";
const full = {
  firstName: "Pat", church: "City Reach Church", grade: "B", topFix: "Add Sunday service times to your Google listing",
  scorecardUrl: `https://bigsplash.video/front-door/?id=${ID}`, walkthroughUrl: `https://bigsplash.video/frontdoor/walkthrough/?id=${ID}`,
};
const bare = { ...full, firstName: "", topFix: "", grade: "" };
const EMAILS = { scorecardEmail, approvedEmail, fixEmail, callEmail, lastEmail };
const TEXTS = { scorecardText, nudgeText };
const FOOTER = "The Big Splash Team\n\n1119 Ascot St., Georgetown, TX 78626. Reply stop and we won't email you again.";

describe("every email", () => {
  for (const [name, build] of Object.entries(EMAILS)) {
    for (const videoLive of [false, true]) {
      test(`${name} (video ${videoLive ? "live" : "not live"}): signature, footer, links, plain HTML`, () => {
        const m = build({ ...full, videoLive });
        assert.ok(m.subject && m.html && m.text);
        assert.ok(m.text.startsWith("Hi Pat,\n\n"), m.text);
        assert.ok(m.text.endsWith(FOOTER), m.text);
        assert.ok(m.html.endsWith("<p>1119 Ascot St., Georgetown, TX 78626. Reply stop and we won&#39;t email you again.</p>"));
        assert.ok(m.text.includes(full.walkthroughUrl) || m.text.includes(full.scorecardUrl));
        const tags = [...m.html.matchAll(/<\/?([a-z]+)/g)].map((x) => x[1]);
        assert.deepEqual([...new Set(tags)].filter((t) => !["p", "br", "a"].includes(t)), [], "paragraphs and links only");
        assert.equal(/<img|style=|tracking|pixel/i.test(m.html), false);
        for (const [, href] of m.html.matchAll(/href="([^"]+)"/g)) assert.ok(href.startsWith("https://bigsplash.video/"), href);
        const all = `${m.subject}\n${m.text}`;
        assert.equal(/—|–/.test(all), false, "no dashes");
        assert.equal(/\b(really|just|actually|simply|truly|holy|honestly|literally)\b/i.test(all), false);
        assert.equal(/20[- ]minute|20 min/.test(all), false, "the call is 30 minutes");
        assert.equal(/Hi ,/.test(all), false);
      });
    }
  }

  test("the address comes from BUSINESS_ADDRESS when set", () => {
    const m = lastEmail({ ...full, address: "PO Box 1, Georgetown, TX 78627" });
    assert.ok(m.text.endsWith("PO Box 1, Georgetown, TX 78627. Reply stop and we won't email you again."));
  });

  test("the call is 30 minutes wherever the copy names it", () => {
    for (const b of [scorecardEmail, approvedEmail, callEmail]) assert.match(`${b(full).subject}\n${b(full).text}`, /30-minute/);
    assert.match(callEmail(full).text, /first 15 minutes/);
    for (const videoLive of [false, true]) assert.equal(/\d+ ?min/.test(nudgeText({ ...full, videoLive }).message), false, "the text names no other call length");
    assert.match(fixEmail(full).text, /we offer a free 30-minute call\./);
  });
});

describe("email 1 and the approved variant", () => {
  test("scorecard email carries the link, grade, first fix and the walkthrough link", () => {
    const m = scorecardEmail(full);
    assert.equal(m.subject, "Front Door scorecard for City Reach Church");
    assert.ok(m.text.includes(`Your Front Door Audit for City Reach Church is done:\n${full.scorecardUrl}`));
    assert.ok(m.text.includes("Overall grade: B\nFirst fix on your list: Add Sunday service times to your Google listing"));
    assert.ok(m.text.includes(`on a free 30-minute call and show you what we'd do first.\nBook a call with our team: ${full.walkthroughUrl}`));
    assert.equal(/Pick a time|with me|walkthrough call|Chris will/.test(m.text), false);
    assert.ok(m.html.includes(`<a href="${full.scorecardUrl}">${full.scorecardUrl}</a>`));
  });

  test("no first name reads Hi Pastor; no grade and no fix drop those lines", () => {
    const m = scorecardEmail(bare);
    assert.ok(m.text.startsWith("Hi Pastor,"));
    assert.ok(m.text.includes("Your grades are ready, area by area."));
    assert.equal(/First fix|Overall grade/.test(m.text), false);
    const a = approvedEmail(bare);
    assert.ok(a.text.startsWith("Hi Pastor,"));
    assert.equal(/First fix/.test(a.text), false);
  });

  test("approved variant apologizes for the wait without naming a cause the audit did not see", () => {
    const m = approvedEmail(full);
    assert.equal(m.subject, "Your Front Door scorecard (sorry for the wait)");
    assert.match(m.text, /Something in the audit for City Reach Church needed a human look/);
    assert.equal(/Google results/.test(m.text), false);
    assert.match(m.text, /Thanks for your patience\.\n\nThe Big Splash Team/);
    assert.ok(m.text.includes(`our team will cover every grade with you on a free 30-minute call.\nBook a call with our team: ${full.walkthroughUrl}`));
  });
});

describe("follow-up emails", () => {
  test("email 2 is about the top fix and returns null without one", () => {
    const m = fixEmail(full);
    assert.equal(m.subject, "The fix we'd start with at City Reach Church");
    assert.ok(m.text.includes("we'd start here:\n\nAdd Sunday service times to your Google listing\n\n"));
    assert.equal(fixEmail(bare), null);
  });

  test("no video is mentioned until videoLive", () => {
    // "bigsplash.video" in the links does not count.
    assert.equal(/(?<!\.)video/i.test(fixEmail(full).text), false);
    assert.equal(/(?<!\.)video/i.test(nudgeText(full).message), false);
    assert.match(fixEmail({ ...full, videoLive: true }).text, /3-minute video/);
    assert.match(fixEmail({ ...full, videoLive: true }).text, /It plays at the top of the booking page linked below\.\nBook a call with our team: /);
    assert.equal(nudgeText({ ...full, videoLive: true }).message, nudgeText(full).message, "text 2 reads the same once the video is live");
  });

  test("email 3 and email 4", () => {
    assert.equal(callEmail(full).subject, "Before you book: the 30-minute call with our team");
    assert.ok(callEmail(full).text.includes(`You keep the fix list either way.\n\nBook a call with our team: ${full.walkthroughUrl}`));
    assert.match(callEmail(full).text, /Our team spends the first 15 minutes/);
    assert.match(callEmail(full).text, /We pull up your scorecard together/);
    assert.equal(/the The /.test(callEmail({ ...full, church: "The Bridge Church" }).text), false);
    assert.match(callEmail(full).text, /If you want to know how an invitation campaign works and what it costs, ask and we'll show you\./);
    assert.equal(/video of your church's story/.test(callEmail(full).text), false);
    const last = lastEmail(full);
    assert.equal(last.subject, "Last note on your scorecard");
    assert.ok(last.text.includes(`Your scorecard stays live here: ${full.scorecardUrl}`));
    assert.ok(last.text.includes(`Book a call with our team: ${full.walkthroughUrl}`));
    for (const b of Object.values(EMAILS)) assert.equal(/walkthrough(?!\/)|with me\b|my calendar|Pick a time/i.test(b({ ...full, videoLive: true }).text.replaceAll(full.walkthroughUrl, "")), false, b.name);
    assert.match(callEmail({ ...full, church: "" }).text, /We pull up your scorecard together/);
  });
});

describe("texts", () => {
  test("text 1 names the church and Big Splash, sends the full link and ends with the STOP line", () => {
    const { message } = scorecardText(full);
    assert.equal(message, `Hi Pat, here's the Front Door Audit for City Reach Church. Check out your scorecard: ${full.scorecardUrl}\nThe team at Big Splash. Reply STOP to opt out`);
    assert.ok(message.endsWith("Reply STOP to opt out"));
    assert.equal(scorecardText(bare).message.startsWith("Hi Pastor, here's the Front Door Audit for City Reach Church."), true);
    assert.equal(/Chris/.test(message), false, "texts come from the team, not Chris");
  });

  test("text 2 names Big Splash, and email 2 claims no more than the fix's place on the list", () => {
    assert.equal(nudgeText(full).message, `Hi Pat, the team at Big Splash here. Want to go over City Reach Church's scorecard together? Book a call with our team: ${full.walkthroughUrl}`);
    assert.equal(nudgeText({ ...full, videoLive: true }).message, `Hi Pat, the team at Big Splash here. Want to go over City Reach Church's scorecard together? Book a call with our team: ${full.walkthroughUrl}`);
    const fix = fixEmail(full).text;
    assert.match(fix, /It sits at the top of the fix list on your scorecard\. A staff member or a sharp volunteer can often handle it in-house\./);
    assert.equal(/pulled your grade down|Most churches/.test(fix), false);
  });

  test("texts stay within two text segments with a 7-letter name, a long church name and the longest id", () => {
    const longId = `${"a".repeat(40)}-1a2b3c4d`;
    const v = { ...full, firstName: "Jessica", church: "First Baptist Church of Round Rock", scorecardUrl: `https://bigsplash.video/front-door/?id=${longId}`, walkthroughUrl: `https://bigsplash.video/frontdoor/walkthrough/?id=${longId}` };
    for (const [name, build] of Object.entries(TEXTS)) {
      for (const videoLive of [false, true]) {
        const { message } = build({ ...v, videoLive });
        assert.ok(message.length <= 306, `${name}: ${message.length}`);
        assert.equal(/[‘’“”]/.test(message), false, "straight quotes only");
        assert.equal(/bit\.ly|tinyurl|lnk/.test(message), false);
      }
    }
  });
});

describe("hostile values", () => {
  const evil = {
    ...full,
    firstName: '"><img src=x onerror=alert(1)>',
    church: "<script>alert('x')</script> & Co",
    topFix: "<a href=\"https://evil.example\">click</a>",
    grade: "<b>A</b>",
  };
  for (const [name, build] of Object.entries(EMAILS)) {
    test(`${name} escapes every value in the HTML`, () => {
      const m = build(evil);
      if (!m) return;
      assert.equal(/<img|<script|<b>|evil\.example">/.test(m.html), false, m.html);
      assert.ok(m.html.includes("&lt;") || m.html.includes("&amp;"));
      for (const [, href] of m.html.matchAll(/href="([^"]+)"/g)) assert.ok(href.startsWith("https://bigsplash.video/"), href);
    });
  }

  test("line breaks and invisible characters in a name cannot add lines to a text or subject", () => {
    const m = scorecardText({ ...full, firstName: "Pat\nSTOP‮" });
    // The only line break is the one before the sign-off.
    assert.equal(m.message.split("\n").length, 2);
    assert.ok(m.message.split("\n")[1].startsWith("The team at Big Splash."));
    const e = scorecardEmail({ ...full, church: "Grace\r\nBcc: x@y.z" });
    assert.equal(/[\r\n]/.test(e.subject), false);
  });

  test("a link that is not https is dropped, never linked", () => {
    const m = lastEmail({ ...full, scorecardUrl: "javascript:alert(1)" });
    assert.equal(/javascript:/.test(m.html), false);
  });
});
