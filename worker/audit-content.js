/**
 * Big Splash — Free Content Strategy Audit Worker
 * ================================================
 *
 * Receives strategy-form submissions from the public site, runs a Claude-powered
 * audit on the submitted website URL, floors the score at 58, and forwards the
 * full payload (form fields + audit result) to the GHL webhook.
 *
 * DEPLOY:
 *   cd worker
 *   npx wrangler login
 *   npx wrangler secret put ANTHROPIC_API_KEY      # paste your Anthropic key
 *   npx wrangler secret put GHL_WEBHOOK_URL        # paste your GHL inbound webhook URL (optional)
 *   npx wrangler secret put ALLOWED_ORIGIN         # e.g. https://bigsplash.video  (optional — defaults to *)
 *   npx wrangler deploy
 *
 * After deploy, paste the resulting https://<name>.<account>.workers.dev URL
 * into AUDIT_API_URL in ../js/intake.js.
 *
 * ENV VARS (set via wrangler secret):
 *   ANTHROPIC_API_KEY   required
 *   GHL_WEBHOOK_URL     optional — if set, successful audits are forwarded here
 *   ALLOWED_ORIGIN      optional — CORS allow-list; defaults to '*' for dev
 */

const MODEL = 'claude-haiku-4-5';
const SCORE_FLOOR = 58;
const MAX_SITE_CHARS = 6000;

const SYSTEM_PROMPT = `You audit websites for service-business owners — roofers, chiropractors, contractors, clinics, consultants.

Given a business type and extracted homepage content, produce a conversion-readiness audit.

Return JSON matching the schema exactly. No extra keys, no prose outside the JSON.

Scoring anchors:
- 90-100: clear value prop above the fold, obvious primary CTA, real social proof, freshness signals, mobile-ready
- 75-89: solid foundation with fixable gaps in positioning, proof, or CTA clarity
- 60-74: multiple gaps — unclear positioning, buried CTA, thin proof, or stale content
- Below 60: major issues — generic copy, no clear action, missing trust signals

Findings: pick 3 specific observations. Each one covers a distinct category (value_prop, conversion, proof, or content). Mix of strong and weak is fine. Notes are 1-2 sentences, specific to what you saw. No generic advice, no em dashes, no adverbs like "really" or "simply".

Style: plain, specific, actionable. Write like a strategist texting a colleague.`;

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    headline: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['value_prop', 'conversion', 'proof', 'content'] },
          status: { type: 'string', enum: ['strong', 'weak'] },
          note: { type: 'string' },
        },
        required: ['category', 'status', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['score', 'headline', 'findings'],
  additionalProperties: false,
};

export default {
  async fetch(request, env, ctx) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, corsHeaders);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const { name, email, business, website_url } = payload;
    if (!name || !email || !business || !website_url) {
      return json({ error: 'Missing required fields: name, email, business, website_url' }, 400, corsHeaders);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Worker missing ANTHROPIC_API_KEY' }, 500, corsHeaders);
    }

    let audit;
    try {
      const siteText = await extractSiteText(website_url);
      audit = await runClaudeAudit(env.ANTHROPIC_API_KEY, { business, website_url, siteText });
    } catch (err) {
      console.error('[audit] failed:', err.message);
      return json({ error: 'Audit failed. Try again or contact us directly.' }, 502, corsHeaders);
    }

    audit.score = Math.max(SCORE_FLOOR, Math.min(100, Math.round(audit.score || SCORE_FLOOR)));

    if (env.GHL_WEBHOOK_URL) {
      ctx.waitUntil(
        fetch(env.GHL_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, audit }),
        }).catch((err) => console.error('[ghl] forward failed:', err.message)),
      );
    }

    return json(audit, 200, corsHeaders);
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function extractSiteText(url) {
  const normalized = url.startsWith('http') ? url : `https://${url}`;
  const resp = await fetch(normalized, {
    headers: { 'User-Agent': 'BigSplashAuditBot/1.0 (+https://bigsplash.video)' },
    cf: { cacheTtl: 300, cacheEverything: false },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`Site fetch ${resp.status}`);
  const html = await resp.text();

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [, ''])[1].trim();
  const ogDescription = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [, ''])[1].trim();

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  const combined = [
    title && `TITLE: ${title}`,
    description && `META: ${description}`,
    ogDescription && ogDescription !== description && `OG: ${ogDescription}`,
    body && `BODY: ${body}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return combined.slice(0, MAX_SITE_CHARS);
}

async function runClaudeAudit(apiKey, { business, website_url, siteText }) {
  const userPrompt = `Business type: ${business}
Website: ${website_url}

Extracted content:
${siteText || '(no content extracted — site may be JS-rendered or unreachable)'}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: { type: 'json_schema', schema: AUDIT_SCHEMA },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');

  let audit;
  try {
    audit = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`Failed to parse audit JSON: ${err.message}`);
  }
  return audit;
}
