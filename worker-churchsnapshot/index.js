// Big Splash Church Snapshot intake Worker
// POST JSON from church/index.html -> ClickUp task (+ optional GHL forward).

const REQUIRED = ['church', 'city', 'name', 'role', 'email', 'phone', 'source'];

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

    const missing = REQUIRED.filter((k) => !String(body[k] || '').trim());
    if (missing.length) return json({ error: 'Missing: ' + missing.join(', ') }, 400, cors);
    if (body.source !== 'Upload' && !/^https?:\/\//i.test(String(body.sermon_link || ''))) {
      return json({ error: 'Sermon link must be a URL' }, 400, cors);
    }
    // Honeypot: real form never sets this.
    if (body.website) return json({ ok: true }, 200, cors);

    const results = { clickup: null, ghl: null };

    // With no destination configured the request would vanish while the page
    // says "sent". Fail loudly so the form shows its email fallback.
    if (!(env.CLICKUP_TOKEN && env.CLICKUP_LIST_ID) && !env.GHL_WEBHOOK_URL) {
      return json({ ok: false, error: 'Intake has no destination configured' }, 500, cors);
    }

    if (env.CLICKUP_TOKEN && env.CLICKUP_LIST_ID) {
      try { results.clickup = await createClickUpTask(body, env); }
      catch (err) { results.clickup = { error: err.message }; }
    }
    if (env.GHL_WEBHOOK_URL) {
      try {
        const r = await fetch(env.GHL_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, clickup_task: results.clickup?.url || null }),
        });
        results.ghl = { status: r.status };
      } catch (err) { results.ghl = { error: err.message }; }
    }

    // Success means at least one destination took the request.
    const clickupOk = Boolean(results.clickup && !results.clickup.error);
    const ghlOk = Boolean(results.ghl && !results.ghl.error && results.ghl.status < 400);
    const ok = clickupOk || ghlOk;
    return json({ ok, results }, ok ? 200 : 502, cors);
  },
};

async function createClickUpTask(b, env) {
  const due = Date.now() + 48 * 60 * 60 * 1000;
  const source = b.source === 'Upload' ? 'Upload (Dropbox file request)' : b.source;
  const description = [
    `**Church:** ${b.church}`,
    `**City:** ${b.city}`,
    b.attendance ? `**Sunday attendance:** ${b.attendance}` : '',
    `**Contact:** ${b.name} (${b.role})`,
    `**Email:** ${b.email}`,
    `**Cell:** ${b.phone}`,
    b.cc_email ? `**Also copy:** ${b.cc_email}` : '',
    `**Sermon source:** ${source}`,
    b.sermon_link ? `**Sermon link:** ${b.sermon_link}` : `**Upload portal opened:** ${b.upload_confirmed || 'not confirmed, check Dropbox _inbox'}`,
    b.notes ? `**Notes:** ${b.notes}` : '',
    `**Submitted:** ${b.submitted_at || new Date().toISOString()}`,
    `**Page:** ${b.page_url || ''}`,
    b.utm ? `**Came from:** ${b.utm}` : '',
    '',
    '---',
    '**48-hour clock started.** Duplicate the TEMPLATE task checklist or follow church/README.md.',
  ].filter(Boolean).join('\n');

  const res = await fetch(`https://api.clickup.com/api/v2/list/${env.CLICKUP_LIST_ID}/task`, {
    method: 'POST',
    headers: { 'Authorization': env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${b.church}, ${b.city}`,
      markdown_description: description,
      priority: 2,
      due_date: due,
      due_date_time: true,
      tags: ['snapshot', 'website-form'],
    }),
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const task = await res.json();
  return { id: task.id, url: task.url };
}

function corsHeaders(env, request) {
  // ALLOWED_ORIGIN may hold several origins separated by commas, for example
  // "https://bigsplash.church,https://bigsplash.video". Unset allows any origin.
  const list = String(env.ALLOWED_ORIGIN || '*').split(',').map((o) => o.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const allowed = list.includes('*') ? '*' : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
