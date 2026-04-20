/* ========================================
   BIG SPLASH - Intake Modal
   ========================================
   Self-contained modal that handles all
   "Start Project" buttons across the site.

   Triggers: any element with [data-open-intake].
   Service tag: [data-intake-service="<name>"]
   The service tag selects which form config loads
   (questions + accent color).
   ======================================== */

(() => {
  // ========================================
  // !! PASTE YOUR GHL INBOUND WEBHOOK URL BELOW !!
  // GHL: Settings > Integrations > Inbound Webhooks
  // (or your GHL workflow's "Webhook Trigger" URL).
  // One URL handles the intake modal form;
  // the strategy form goes through the audit worker,
  // which forwards to GHL server-side with the same
  // payload shape + audit result attached.
  // ========================================
  const GHL_WEBHOOK_URL = '';

  // ========================================
  // !! PASTE YOUR AUDIT WORKER URL BELOW !!
  // Deploy worker/audit-content.js to Cloudflare Workers
  // (see comments at top of that file), then paste the
  // resulting https://...workers.dev URL below.
  // The worker runs the Claude-powered audit, floors the
  // score at 58, and forwards the submission to GHL.
  // ========================================
  const AUDIT_API_URL = '';

  // ========================================
  // Shared submit helper — exposed on window so other
  // forms on the site (e.g. strategy form) can POST
  // to the same webhook with consistent error handling.
  // ========================================
  async function submitToGHL(payload) {
    if (!GHL_WEBHOOK_URL) {
      console.warn('[ghl] GHL_WEBHOOK_URL is empty. Payload would be:', payload);
      throw new Error('Webhook not configured yet.');
    }
    const response = await fetch(GHL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }

  // ========================================
  // Audit pipeline helper — POSTs to the worker,
  // which calls Claude, scores the site, floors at 58,
  // forwards to GHL, and returns { score, headline, findings }.
  // ========================================
  async function runAudit(payload) {
    if (!AUDIT_API_URL) {
      console.warn('[audit] AUDIT_API_URL is empty. Payload would be:', payload);
      throw new Error('Audit worker not configured yet.');
    }
    const response = await fetch(AUDIT_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }

  window.BigSplashIntake = { submit: submitToGHL, audit: runAudit };

  // ========================================
  // Per-service form configurations
  // Add a new entry to customize the form for another vertical.
  // ========================================
  const CONFIGS = {
    default: {
      variant: 'lime',
      eyebrow: 'Start Project',
      headline: "Let's make<br/>a splash.",
      sub: "Tell us a bit about the project. We'll reach back within one business day.",
      submitText: 'Send It',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Your name' },
        { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'you@company.com' },
        { name: 'phone', label: 'Phone (optional)', type: 'tel', required: false, placeholder: '555-555-5555' },
        { name: 'service', label: 'What are you looking for?', type: 'select', required: true, options: ['Video Ads', 'Brand Story / Commercial', 'Short-Form Content', 'Content Strategy', 'One-off project', 'Not sure yet'] },
        { name: 'notes', label: 'Tell us more about the project', type: 'textarea', required: true, placeholder: 'What does your business do, and what are you trying to make happen?' },
      ],
    },
  };

  // ========================================
  // Styles (injected at runtime so file stays self-contained)
  // ========================================
  const modalCSS = `
#intake-modal.open { opacity: 1 !important; visibility: visible !important; pointer-events: auto !important; }
#intake-modal { -webkit-overflow-scrolling: touch; }
body.intake-locked { overflow: hidden; }
#intake-modal { --intake-accent: #eff88b; --intake-accent-text: #131318; --intake-accent-glow: rgba(239, 248, 139, 0.35); }
#intake-modal .ia-eyebrow { color: var(--intake-accent); }
#intake-modal .ia-input { background: transparent; border: none; border-bottom: 1px solid rgba(255,255,255,0.15); color: #e7e5e4; padding: 0.75rem 0; width: 100%; transition: border-color 0.3s; font-family: inherit; font-size: 1rem; }
#intake-modal .ia-input:focus { outline: none; border-color: var(--intake-accent); }
#intake-modal .ia-input::placeholder { color: #57534e; }
#intake-modal .ia-input.ia-select { appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 1.5rem; background-image: linear-gradient(45deg, transparent 50%, rgba(255,255,255,0.4) 50%), linear-gradient(-45deg, transparent 50%, rgba(255,255,255,0.4) 50%); background-position: calc(100% - 12px) 50%, calc(100% - 6px) 50%; background-size: 6px 6px, 6px 6px; background-repeat: no-repeat; }
#intake-modal .ia-input.ia-select option { background: #1a1a20; color: #e7e5e4; }
#intake-modal textarea.ia-input { resize: none; }
#intake-modal .ia-submit { background: var(--intake-accent); color: var(--intake-accent-text); transition: transform 0.3s, box-shadow 0.3s; }
#intake-modal .ia-submit:hover:not(:disabled) { transform: scale(0.98); box-shadow: 0 0 40px var(--intake-accent-glow); }
#intake-modal .ia-submit:disabled { opacity: 0.5; cursor: not-allowed; }
#intake-modal .ia-close:hover { color: var(--intake-accent); }
#intake-modal .ia-success-icon { color: var(--intake-accent); }
#intake-modal .ia-success-close:hover { opacity: 0.7; }
#intake-modal .ia-success-close { color: var(--intake-accent); }
`;

  // ========================================
  // Modal shell (form body is built dynamically per open)
  // ========================================
  const modalHTML = `
<div id="intake-modal" class="fixed inset-0 z-[100] opacity-0 invisible pointer-events-none transition-all duration-300 overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="intake-title">
  <div data-intake-backdrop class="fixed inset-0 bg-background/90 backdrop-blur-md"></div>
  <div class="relative z-10 min-h-screen flex items-center justify-center p-4 md:p-8">
    <div class="w-full max-w-xl bg-surface-container-low border border-white/10 shadow-2xl shadow-black/80 p-8 md:p-12 relative my-auto">
      <button type="button" data-intake-close aria-label="Close" class="ia-close absolute top-4 right-4 text-stone-400 transition-colors p-2">
        <span class="material-symbols-outlined">close</span>
      </button>

      <div data-intake-form-wrap></div>

      <div data-intake-success class="hidden text-center py-8">
        <span class="material-symbols-outlined ia-success-icon text-6xl mb-4 block">check_circle</span>
        <h2 class="font-anton text-4xl uppercase text-on-surface mb-3">Got it.</h2>
        <p class="text-stone-400 mb-8">We'll be in touch within one business day.</p>
        <button type="button" data-intake-close class="ia-success-close font-label text-xs tracking-widest uppercase transition-opacity">Close</button>
      </div>
    </div>
  </div>
</div>`;

  // ========================================
  // Build form HTML from a config
  // ========================================
  function buildFormHTML(config, service) {
    const fieldsHTML = config.fields.map(f => {
      if (f.type === 'textarea') {
        return `
          <div class="mb-5">
            <label class="font-label text-xs tracking-widest uppercase text-stone-500 mb-2 block" for="ia-${f.name}">${f.label}</label>
            <textarea id="ia-${f.name}" name="${f.name}" rows="3" class="ia-input" placeholder="${f.placeholder || ''}"${f.required ? ' required' : ''}></textarea>
          </div>`;
      }
      if (f.type === 'select') {
        const optionsHTML = f.options.map(o => `<option value="${o}">${o}</option>`).join('');
        return `
          <div class="mb-5">
            <label class="font-label text-xs tracking-widest uppercase text-stone-500 mb-2 block" for="ia-${f.name}">${f.label}</label>
            <select id="ia-${f.name}" name="${f.name}" class="ia-input ia-select"${f.required ? ' required' : ''}>
              <option value="" disabled selected>Select one...</option>
              ${optionsHTML}
            </select>
          </div>`;
      }
      return `
        <div class="mb-5">
          <label class="font-label text-xs tracking-widest uppercase text-stone-500 mb-2 block" for="ia-${f.name}">${f.label}</label>
          <input id="ia-${f.name}" name="${f.name}" type="${f.type}" class="ia-input" placeholder="${f.placeholder || ''}"${f.required ? ' required' : ''}>
        </div>`;
    }).join('');

    return `
      <p class="ia-eyebrow font-label text-xs tracking-[0.3em] uppercase mb-4">${config.eyebrow}</p>
      <h2 id="intake-title" class="font-anton text-4xl md:text-5xl uppercase text-on-surface mb-2 leading-none">${config.headline}</h2>
      <p class="text-stone-400 mb-8 mt-4">${config.sub}</p>

      <form novalidate>
        <input type="hidden" name="service_tag" value="${service}">
        <input type="hidden" name="page_url" value="">
        ${fieldsHTML}
        <div data-intake-error class="hidden mb-4 text-sm text-red-400 font-label"></div>
        <button type="submit" data-intake-submit class="ia-submit w-full font-label text-sm tracking-widest uppercase font-bold py-4">${config.submitText}</button>
      </form>

      <div class="mt-6 pt-6 border-t border-white/10 text-center">
        <button type="button" data-intake-toggle-cal class="font-label text-xs tracking-widest uppercase text-stone-500 hover:text-primary transition-colors cursor-pointer">
          Or book a discovery call instead
        </button>
      </div>

      <div data-intake-cal class="hidden mt-6">
        <div class="bg-surface-dim rounded overflow-hidden" style="min-height: 550px;">
          <iframe src="https://api.leadconnectorhq.com/widget/booking/YcBm4L2c5a0DNBZyessz" class="ghl-cal-dark" style="width: 100%; height: 650px; border: none; overflow: hidden;" scrolling="no"></iframe>
        </div>
        <div class="mt-4 text-center">
          <button type="button" data-intake-toggle-form class="font-label text-xs tracking-widest uppercase text-stone-500 hover:text-primary transition-colors cursor-pointer">
            Back to form
          </button>
        </div>
      </div>`;
  }

  // ========================================
  // Mount + wire up
  // ========================================
  document.addEventListener('DOMContentLoaded', () => {
    const styleTag = document.createElement('style');
    styleTag.textContent = modalCSS;
    document.head.appendChild(styleTag);
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const modal = document.getElementById('intake-modal');
    const backdrop = modal.querySelector('[data-intake-backdrop]');
    const formWrap = modal.querySelector('[data-intake-form-wrap]');
    const successWrap = modal.querySelector('[data-intake-success]');

    const open = (service) => {
      const svc = service || 'General';
      const config = CONFIGS[svc] || CONFIGS.default;

      // Build + inject form
      formWrap.innerHTML = buildFormHTML(config, svc);
      formWrap.classList.remove('hidden');
      successWrap.classList.add('hidden');

      // Set page_url
      const pageInput = formWrap.querySelector('input[name="page_url"]');
      if (pageInput) pageInput.value = window.location.href;

      // Wire up the freshly built form
      const form = formWrap.querySelector('form');
      const errorWrap = formWrap.querySelector('[data-intake-error]');
      const submitBtn = formWrap.querySelector('[data-intake-submit]');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorWrap.classList.add('hidden');
        errorWrap.textContent = '';

        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }

        submitBtn.disabled = true;
        const originalBtnText = submitBtn.textContent;
        submitBtn.textContent = 'Sending...';

        const payload = Object.fromEntries(new FormData(form).entries());
        payload.form_type = 'intake';
        payload.submitted_at = new Date().toISOString();

        try {
          await submitToGHL(payload);
          formWrap.classList.add('hidden');
          successWrap.classList.remove('hidden');
        } catch (err) {
          console.error('[intake] submit failed:', err);
          errorWrap.textContent = 'Something went sideways. Try again, or email chris@bigsplash.agency.';
          errorWrap.classList.remove('hidden');
          submitBtn.disabled = false;
          submitBtn.textContent = originalBtnText;
        }
      });

      modal.classList.add('open');
      document.body.classList.add('intake-locked');

      // Close mobile menu if open
      const mobileMenu = document.getElementById('mobile-menu');
      if (mobileMenu) {
        mobileMenu.classList.remove('open');
        document.body.classList.remove('menu-open');
      }

      // Wire up calendar toggle inside intake
      const toggleCal = formWrap.querySelector('[data-intake-toggle-cal]');
      const toggleForm = formWrap.querySelector('[data-intake-toggle-form]');
      const calWrap = formWrap.querySelector('[data-intake-cal]');
      const formEl = formWrap.querySelector('form');
      const calToggleLink = formWrap.querySelector('.mt-6.pt-6');

      if (toggleCal && calWrap && formEl) {
        toggleCal.addEventListener('click', () => {
          formEl.classList.add('hidden');
          calToggleLink.classList.add('hidden');
          calWrap.classList.remove('hidden');
        });
      }
      if (toggleForm && calWrap && formEl) {
        toggleForm.addEventListener('click', () => {
          calWrap.classList.add('hidden');
          formEl.classList.remove('hidden');
          calToggleLink.classList.remove('hidden');
        });
      }

      setTimeout(() => formWrap.querySelector('input, select, textarea')?.focus(), 200);
    };

    const close = () => {
      modal.classList.remove('open');
      document.body.classList.remove('intake-locked');
    };

    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-open-intake]');
      if (trigger) {
        e.preventDefault();
        open(trigger.dataset.intakeService);
      }
      const closer = e.target.closest('[data-intake-close]');
      if (closer) close();
    });
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });
  });
})();
