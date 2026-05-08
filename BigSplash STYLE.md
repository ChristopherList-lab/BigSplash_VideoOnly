# Big Splash — Style Guide

The visual and verbal system for the Big Splash site, brand assets, and marketing copy. Pull from this file before writing new copy or shipping new pages.

## Brand in one line

Video production for service businesses in Georgetown, TX. The site sells outcomes (booked calls, paid-back ad spend), not hours.

## Voice

Write like a confident operator texting a smart client. Short. Direct. No fluff.

### Always
- Active voice. Name the actor.
- Specific over vague. "50+ projects shipped" beats "lots of work."
- Mix sentence length. Two sentences are usually enough.
- State the benefit. Trust the reader.
- Lead with what the client gets.

### Never
- Filler openers: "Here's the thing," "It turns out," "The truth is."
- Emphasis crutches: "Full stop," "Let that sink in."
- Binary contrasts: "Not X, but Y." State Y.
- Adverbs: really, just, literally, genuinely, simply, truly.
- Business jargon: navigate, unpack, lean into, double down, deep dive.
- Vague stakes: "The implications are significant."
- Em dashes (use periods or commas).
- Three-item lists. Two beats three.
- Sentences starting with What/When/Why/How. Rewrite.
- Meta-commentary: "Let me walk you through..."

### Sample copy that ships

> Video ads and brand films for service businesses that need their content to pay for itself.

> Performance creative for Meta, Instagram, TikTok, and Reels. Built to drive calls, leads, and sales for service businesses who need the spend to pay back.

> Drop your site and your business type. You'll get an on-screen conversion-readiness score and a strategy roadmap within 48 hours.

## Color

Dark Material 3 surface system with a single lime accent. The lime carries every interactive state — buttons, hovers, focus, selection, scrollbars, link dots.

| Token | Hex | Use |
|---|---|---|
| `primary` | `#eff88b` | Accent. CTAs, active states, glows, focus rings. |
| `on-primary` | `#2f3300` | Text on lime fills (dark olive for contrast). |
| `secondary` | `#ddd8ce` | Warm off-white. Body copy on dark surfaces. |
| `on-surface` | `#e4e1e9` | Default text on dark surfaces. |
| `background` / `surface` | `#131318` | Page background. |
| `surface-dim` | `#0e0e13` | Recessed sections. |
| `surface-container-low` | `#1b1b20` | Subtle elevation. |
| `surface-container` | `#1f1f25` | Cards, modals. |
| `surface-container-high` | `#2a292f` | Hover/raised state. |
| `surface-container-highest` | `#35343a` | Top-most elevation. |
| `outline` | `#92927f` | Borders on dividers. |
| `outline-variant` | `#474838` | Subtle dividers. |

### Lime accent rules

- Always at low opacity for ambient effects: `rgba(239,248,139,0.08–0.4)`.
- Glow shadows: `0 0 40px rgba(239,248,139,0.4)` for headlines, `0 0 50px rgba(239,248,139,0.25)` for hover bloom.
- Selection background: `rgba(239,248,139,0.3)`.
- Solid `#eff88b` only on small surfaces — pills, dots, the close-button hover, primary CTAs. Big lime fills feel cheap.

## Type

Three fonts. Each owns a job. Don't mix the jobs.

| Family | Tailwind | Job |
|---|---|---|
| **Anton** | `font-anton` / `font-headline` | Display headlines. Always uppercase, tight tracking, heavy. |
| **Inter** | default / `font-body` | Body, UI, paragraphs. Weights 300–700. |
| **JetBrains Mono** | `font-label` | Eyebrow labels, tags, small UI. Uppercase, wide tracking. |

### Headline rules

- Always uppercase.
- Tight tracking: `tracking-tighter` or tighter.
- Sizes: `text-2xl` (cards) → `text-5xl md:text-7xl` (section headers) → hero `text-7xl md:text-9xl`.
- Two-line max. Break with intent — split line so the punchword lands at start of line two.
- One word per line gets a glow: `text-glow-lime`.

```html
<h2 class="font-anton text-5xl md:text-7xl uppercase leading-none tracking-tighter">
  ADS THAT <span class="text-primary">SELL.</span><br>
  STORIES THAT <span class="text-primary">STICK.</span>
</h2>
```

### Eyebrow labels

JetBrains Mono, 10–12px, uppercase, `tracking-widest` or `tracking-[0.4em]`, lime or muted. Always above a headline, never as a standalone sentence.

```html
<p class="font-label text-[10px] tracking-[0.4em] uppercase text-primary/80">
  Video Production · Georgetown, TX
</p>
```

### Body

Inter 400–500. Default `text-secondary` on dark. Line height generous (`leading-relaxed`). Paragraphs short — three sentences ceiling.

## Motion

Every transition uses one of two easings. No bounces. No overshoot.

- **Smooth ease-out** for entrances and reveals: `cubic-bezier(0.16, 1, 0.3, 1)` over 600–900ms.
- **Default ease** for hovers and small state changes: 200–500ms.

### Standard patterns

```css
.reveal { transition: opacity 0.9s cubic-bezier(0.16, 1, 0.3, 1), transform 0.9s cubic-bezier(0.16, 1, 0.3, 1); }
.filter-pill { transition: all 0.3s cubic-bezier(0.16,1,0.3,1); }
.faq-chevron { transition: transform 0.4s cubic-bezier(0.16,1,0.3,1); }
```

### Reveal on scroll

Elements with `.reveal` start at `opacity:0; translateY(40px)` and animate to `opacity:1; translateY(0)` when they enter the viewport.

### Hover scaling

Portfolio cards and ad thumbs: image zooms `scale(1.03)` and saturates by ~10% over 700ms. The card itself doesn't move — only the image inside.

### Marquee

The industries band scrolls left at `45s linear infinite`. Pauses on hover.

## Layout

- 12-column grid implied. Use Tailwind's `grid-cols-1 md:grid-cols-3` patterns.
- Generous gutters: `gap-4 md:gap-6` on grids.
- Section padding: `py-20 md:py-32`. Hero stretches to viewport.
- Max content width: container utility, but full-width hero/marquee/footer.
- Mobile breakpoint: 768px (`md:`).

### Bento grids

The portfolio uses asymmetric tiles — 1×1 alongside 2×1 and 2.39:1 cinematic strips. Two in a row on mobile only when both are vertical 9:16 ad thumbs; everything else spans full width on mobile via:

```css
@media (max-width: 767px) {
  #portfolio-grid > .portfolio-card:not([data-categories~="ads"]) {
    grid-column: span 2 / span 2;
  }
}
```

## Components

### Filter pill

```html
<button class="filter-pill px-4 py-2 border border-white/10 text-stone-400
               hover:border-primary/60 hover:text-primary
               font-label text-[10px] md:text-xs tracking-widest uppercase"
        data-filter="ads">Ads</button>
```

Active state: solid lime fill, dark olive text, lime border.

### Portfolio card

```html
<div class="portfolio-card group relative overflow-hidden aspect-[16/9]
            bg-surface-container cursor-pointer reveal"
     data-video="path/to/file.mp4" data-categories="commercial">
  <img src="poster.webp" class="absolute inset-0 w-full h-full object-cover" loading="lazy">
  <div class="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent opacity-80"></div>
  <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-500">
    <div class="w-14 h-14 rounded-full bg-primary/90 flex items-center justify-center">
      <span class="material-symbols-outlined text-on-primary text-xl ml-0.5">play_arrow</span>
    </div>
  </div>
  <div class="absolute bottom-6 left-6">
    <p class="font-label text-[10px] text-primary mb-2 uppercase tracking-widest">Eyebrow</p>
    <h3 class="font-anton text-2xl uppercase text-white">CARD TITLE</h3>
  </div>
</div>
```

Every card needs a poster image, a gradient scrim from background to transparent, and a hover play-button overlay.

### Video sources

Two options, never mix on one card:
- `data-video="path/to/file.mp4"` — local MP4 (under 100 MB, ideally under 10 MB for portfolio).
- `data-vimeo="<id>" data-vimeo-hash="<hash>"` — Vimeo embed for adaptive 4K playback.

The click handler in `js/animations.js` opens a fullscreen modal player for either.

### Video player modal

Scales in from 0.97 to 1.0 with opacity 0 to 1 over 800ms. The close button (`#video-player .vp-close`) is fixed top-right, lime border, dark fill, 44×44px.

### Eyebrow + headline pattern

Always paired:

```html
<p class="font-label text-[10px] text-primary mb-2 uppercase tracking-widest">
  Brand Narration
</p>
<h3 class="font-anton text-2xl uppercase text-white">
  TORCHYS TACOS
</h3>
```

## Imagery

- Posters: WebP. Cinematic crops. Slight contrast/saturation boost on hover.
- Logos: SVG with a lime drop shadow: `drop-shadow-[0_0_10px_rgba(239,248,139,0.35)]`.
- Photos: warm grade. No cool tints. Skin tones stay natural.
- Avoid stock. Show real client work or behind-the-scenes.

## Iconography

Material Symbols Outlined. Variable weight, 100–700. Match the surrounding font weight. Default to `text-on-primary` on lime fills, `text-primary` on dark.

```html
<span class="material-symbols-outlined text-on-primary text-xl">play_arrow</span>
```

## Names and casing

- Brand: **Big Splash**. Two words, both capitalized.
- Old name **Big Splash Media** appears in legacy reviews; don't introduce it in new copy.
- Service names in headlines: ALL CAPS (`VIDEO ADS`, `BRAND STORY`, `SHORT-FORM`).
- Service names in body: Title Case (`Video Ads`, `Brand Story`, `Short-Form`).
- Industries in body: lowercase plural (`chiropractors, roofers, contractors, consultants`).

## File and asset conventions

- Videos: `assets/videos/<section>/<kebab-name>.mp4`
- Posters: `assets/images/portfolio/<kebab-name>.webp`
- Match poster basename to video basename whenever possible (`warlock.mp4` → `warlock.webp`).
- New large videos go to Vimeo, not the repo. GitHub rejects files over 100 MB.

## Quick checklist before shipping a section

- [ ] Eyebrow label in JetBrains Mono, lime or muted, uppercase wide-tracked.
- [ ] Headline in Anton, uppercase, tight tracking, two lines max.
- [ ] Body copy passes voice rules (no jargon, no filler, no em dashes).
- [ ] Lime accent only on interactive elements or one punchword per headline.
- [ ] Reveal animation on entrance (`class="reveal"`).
- [ ] Hover state on every clickable card.
- [ ] Mobile layout tested at 375px width.
- [ ] All videos either under 100 MB local or hosted on Vimeo.
