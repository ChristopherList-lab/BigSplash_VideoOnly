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
const FOOTER = "Chris List / Big Splash\n\n1119 Ascot St., Georgetown, TX 78626. Reply stop and I won't email you again.";

describe("every email", () => {
  for (const [name, build] of Object.entries(EMAILS)) {
    for (const videoLive of [false, true]) {
      test(`${name} (video ${videoLive ? "live" : "not live"}): signature, footer, links, plain HTML`, () => {
        const m = build({ ...full, videoLive });
        assert.ok(m.subject && m.html && m.text);
        assert.ok(m.text.startsWith("Hi Pat,\n\n"), m.text);
        assert.ok(m.text.endsWith(FOOTER), m.text);
        assert.ok(m.html.endsWith("<p>1119 Ascot St., Georgetown, TX 78626. Reply stop and I won&#39;t email you again.</p>"));
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
    assert.ok(m.text.endsWith("PO Box 1, Georgetown, TX 78627. Reply stop and I won't email you again."));
  });

  test("the call is 30 minutes wherever the copy names it", () => {
    for (const b of [scorecardEmail, approvedEmail, callEmail]) assert.match(`${b(full).subject}\n${b(full).text}`, /30-minute/);
    assert.match(callEmail(full).text, /first 15 minutes/);
    assert.match(nudgeText(full).message, /30 min with me/);
  });
});

describe("email 1 and the approved variant", () => {
  test("scorecard email carries the link, grade, first fix and the walkthrough link", () => {
    const m = scorecardEmail(full);
    assert.equal(m.subject, "Front Door scorecard for City Reach Church");
    assert.ok(m.text.includes(`Your Front Door Audit for City Reach Church is done:\n${full.scorecardUrl}`));
    assert.ok(m.text.includes("Overall grade: B\nFirst fix on your list: Add Sunday service times to your Google listing"));
    assert.ok(m.text.includes(`Pick a time here:\n${full.walkthroughUrl}`));
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
    assert.match(m.text, /Thanks for your patience\.\n\nChris List \/ Big Splash/);
  });
});

describe("follow-up emails", () => {
  test("email 2 is about the top fix and returns null without one", () => {
    const m = fixEmail(full);
    assert.equal(m.subject, "The fix I'd start with at City Reach Church");
    assert.ok(m.text.includes("I'd start here:\n\nAdd Sunday service times to your Google listing\n\n"));
    assert.equal(fixEmail(bare), null);
  });

  test("no video is mentioned until videoLive", () => {
    // "bigsplash.video" in the links does not count.
    assert.equal(/(?<!\.)video/i.test(fixEmail(full).text), false);
    assert.equal(/(?<!\.)video/i.test(nudgeText(full).message), false);
    assert.match(fixEmail({ ...full, videoLive: true }).text, /3-minute video/);
    assert.match(nudgeText({ ...full, videoLive: true }).message, /Video and my calendar/);
  });

  test("email 3 and email 4", () => {
    assert.equal(callEmail(full).subject, "Before you book: the 30-minute walkthrough");
    assert.match(callEmail(full).text, /We pull up your scorecard together/);
    assert.equal(/the The /.test(callEmail({ ...full, church: "The Bridge Church" }).text), false);
    assert.match(callEmail(full).text, /If you want to know how an invitation campaign works and what it costs, ask and I'll show you\./);
    assert.equal(/video of your church's story/.test(callEmail(full).text), false);
    const last = lastEmail(full);
    assert.equal(last.subject, "Last note on your scorecard");
    assert.ok(last.text.includes(`Your scorecard stays live here: ${full.scorecardUrl}`));
    assert.ok(last.text.includes(`You can book the walkthrough anytime: ${full.walkthroughUrl}`));
    assert.match(callEmail({ ...full, church: "" }).text, /We pull up your scorecard together/);
  });
});

describe("texts", () => {
  test("text 1 names Big Splash, sends the full link and ends with the STOP line", () => {
    const { message } = scorecardText(full);
    assert.equal(message, `Pat, Chris at Big Splash. Your scorecard: ${full.scorecardUrl} Reply STOP to opt out`);
    assert.ok(message.endsWith("Reply STOP to opt out"));
    assert.equal(scorecardText(bare).message.startsWith("Pastor, Chris at Big Splash."), true);
  });

  test("text 2 names Big Splash, and email 2 claims no more than the fix's place on the list", () => {
    assert.match(nudgeText(full).message, /^Pat, Chris at Big Splash\. Questions\? 30 min with me: /);
    assert.match(nudgeText({ ...full, videoLive: true }).message, /^Pat, Chris at Big Splash\. Video and my calendar: /);
    const fix = fixEmail(full).text;
    assert.match(fix, /It sits at the top of the fix list on your scorecard\. A staff member or a sharp volunteer can often handle it in-house\./);
    assert.equal(/pulled your grade down|Most churches/.test(fix), false);
  });

  test("texts stay within one 160-character segment with a 7-letter name and the longest id", () => {
    const longId = `${"a".repeat(40)}-1a2b3c4d`;
    const v = { ...full, firstName: "Jessica", scorecardUrl: `https://bigsplash.video/front-door/?id=${longId}`, walkthroughUrl: `https://bigsplash.video/frontdoor/walkthrough/?id=${longId}` };
    for (const [name, build] of Object.entries(TEXTS)) {
      for (const videoLive of [false, true]) {
        const { message } = build({ ...v, videoLive });
        assert.ok(message.length <= 160, `${name}: ${message.length}`);
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
    assert.equal(m.message.includes("\n"), false);
    const e = scorecardEmail({ ...full, church: "Grace\r\nBcc: x@y.z" });
    assert.equal(/[\r\n]/.test(e.subject), false);
  });

  test("a link that is not https is dropped, never linked", () => {
    const m = lastEmail({ ...full, scorecardUrl: "javascript:alert(1)" });
    assert.equal(/javascript:/.test(m.html), false);
  });
});
