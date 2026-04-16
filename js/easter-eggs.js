/* ========================================
   BIG SPLASH - Easter Eggs
   ========================================
   Three delights for the curious.
     1. Konami code -> splash ripple
     2. Console signature on every page load
     3. Logo rapid-click -> water drip
     (4. Custom 404 page lives in /404.html)
   ======================================== */

(() => {
  // ========================================
  // Console signature (runs immediately)
  // ========================================
  const sig = [
    '',
    '        .    .    .    .    .',
    '      __~__~__~_ BIG SPLASH _~__~__~__',
    '     ~   ~    ~   Georgetown, TX   ~    ~   ~',
    '        .    .    .    .    .',
    '',
    '  You found us. We hire people who look here.',
    '  -> hello@bigsplashvideo.com',
    '',
  ].join('\n');
  try {
    console.log('%c' + sig, 'color:#eff88b;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5;');
  } catch (_) { /* no-op */ }

  // ========================================
  // Injected CSS for the visual eggs
  // ========================================
  const eggCSS = `
@keyframes bs-ripple {
  0%   { transform: translate(-50%, -50%) scale(0);   opacity: 0.55; }
  100% { transform: translate(-50%, -50%) scale(12);  opacity: 0;    }
}
.bs-ripple {
  position: fixed;
  top: 50%; left: 50%;
  width: 160px; height: 160px;
  border-radius: 50%;
  pointer-events: none;
  z-index: 9999;
  will-change: transform, opacity;
}
.bs-ripple.bs-lime {
  background: radial-gradient(circle, rgba(239,248,139,0.7) 0%, rgba(239,248,139,0.15) 50%, rgba(239,248,139,0) 72%);
  animation: bs-ripple 1.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes bs-drip-fall {
  0%   { transform: translateY(0)    scaleY(0.8); opacity: 0;   }
  15%  { transform: translateY(4px)  scaleY(1.1); opacity: 1;   }
  100% { transform: translateY(70px) scaleY(0.5); opacity: 0;   }
}
.bs-drip {
  position: fixed;
  width: 8px; height: 12px;
  background: #eff88b;
  border-radius: 50% 50% 50% 50% / 65% 65% 40% 40%;
  pointer-events: none;
  z-index: 9998;
  box-shadow: 0 0 10px rgba(239,248,139,0.6);
  animation: bs-drip-fall 0.95s cubic-bezier(0.55, 0, 0.75, 0) forwards;
}

@keyframes bs-wobble {
  0%, 100% { transform: rotate(0deg);  }
  18%      { transform: rotate(-4deg); }
  36%      { transform: rotate(3.5deg);}
  54%      { transform: rotate(-2.5deg);}
  72%      { transform: rotate(1.5deg);}
  90%      { transform: rotate(-0.5deg);}
}
.bs-wobble { animation: bs-wobble 0.55s ease-in-out; transform-origin: center; }
`;

  document.addEventListener('DOMContentLoaded', () => {
    const styleTag = document.createElement('style');
    styleTag.textContent = eggCSS;
    document.head.appendChild(styleTag);

    const path = window.location.pathname;
    const isHome = path === '/' || path.endsWith('/index.html') || path.endsWith('/');

    // ========================================
    // #1 Konami code -> splash ripple
    // ========================================
    const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
    let buffer = [];
    document.addEventListener('keydown', (e) => {
      const key = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
      buffer.push(key);
      if (buffer.length > KONAMI.length) buffer.shift();
      if (buffer.length === KONAMI.length && buffer.every((k, i) => k === KONAMI[i])) {
        triggerSplash();
        buffer = [];
      }
    });

    function triggerSplash() {
      const lime = document.createElement('div');
      lime.className = 'bs-ripple bs-lime';
      document.body.appendChild(lime);
      setTimeout(() => lime.remove(), 1800);
    }

    // ========================================
    // #3 Logo rapid-click -> water drip
    // ========================================
    const logo = document.querySelector('nav a[aria-label*="Home" i]')
             || document.querySelector('header a[aria-label*="Home" i]')
             || document.querySelector('nav a[href="index.html"]');
    if (logo) {
      let count = 0;
      let last = 0;
      const WINDOW_MS = 420;

      logo.addEventListener('click', (e) => {
        const now = Date.now();
        const rapid = now - last < WINDOW_MS;
        last = now;
        count = rapid ? count + 1 : 1;

        // On home, hijack all logo clicks (they'd reload anyway)
        if (isHome) {
          e.preventDefault();
          if (count >= 5) {
            playDrip(logo);
            count = 0;
          } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
          return;
        }

        // Off home: let the 1st click navigate; if they're fast enough
        // to reach count 5 before navigation starts, play drip on that page.
        if (count >= 5) {
          e.preventDefault();
          playDrip(logo);
          count = 0;
        }
      });
    }

    function playDrip(el) {
      const svg = el.querySelector('svg') || el;
      svg.classList.remove('bs-wobble');
      void svg.offsetWidth;
      svg.classList.add('bs-wobble');

      const rect = svg.getBoundingClientRect();
      const drip = document.createElement('span');
      drip.className = 'bs-drip';
      drip.style.left = Math.round(rect.left + rect.width * 0.18) + 'px';
      drip.style.top  = Math.round(rect.top  + rect.height * 0.85) + 'px';
      document.body.appendChild(drip);
      setTimeout(() => drip.remove(), 1000);
    }
  });
})();
