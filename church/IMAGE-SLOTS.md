# /church image slots

Every placeholder on `church/index.html` is a `<div class="img-slot" data-slot="NAME">`. To fill one, save the file to `assets/images/church/` and replace the whole div with:

```html
<img src="../assets/images/church/NAME.jpg" alt="Describe the photo" class="slot-img" style="aspect-ratio: W/H" loading="lazy">
```

Export JPG or WebP at 80% quality, under 300 KB each. Warm grade, natural skin tones, real churches over stock wherever possible. Get written permission from any church or person shown.

| Slot | Section | Size | Shot direction | Priority |
|---|---|---|---|---|
| `hero-sunday` | Hero, right side | 1200 × 1500 (4:5) | Families being welcomed at a church door on Sunday morning. Real faces, warm light, kids in frame. The sample report card overlaps the bottom left, so keep faces in the top two thirds. | 1 |
| `step-1-sermon` | How it works | 1200 × 900 (4:3) | Hand holding a phone showing a captioned vertical sermon clip in a Facebook or Instagram feed. Mock up from a real clip you made. | 1 |
| `step-2-visit-page` | How it works | 1200 × 900 (4:3) | Phone showing a plan-your-visit page: church name, service times, "Plan my visit" button. Build the template page in GoHighLevel and screenshot it. | 1 |
| `step-3-welcome` | How it works | 1200 × 900 (4:3) | Greeter at a welcome desk checking in a new family on a tablet or phone. | 2 |
| `snapshot-reach-map` | Snapshot | 800 × 800 (1:1) | Map screenshot with a 10-minute drive ring around a church pin and the audience count. | 1 |
| `snapshot-clips` | Snapshot | 800 × 800 (1:1) | Three phones side by side, each with a captioned clip. | 2 |
| `snapshot-thumbnail` | Snapshot | 800 × 800 (1:1) | Before and after: a plain YouTube sermon thumbnail next to your redesign. | 2 |
| `snapshot-loom` | Snapshot | 800 × 800 (1:1) | Still from Chris's walkthrough video with the sample guest report on screen. | 3 |
| `proof-video` | Proof | 1920 × 1080 (16:9) | Best church video you've produced. Host on Vimeo and swap the div for an embed or a poster image with a play button. Candidate: `Desktop/Big Splash Website/EXAMPLES/Cit Reach Church.mp4`. | 1 |
| `testimonial-headshot` | Proof | 200 × 200 (1:1) | Headshot of the pastor or staff member quoted. Replace the bracketed quote, name and role at the same time. Delete the quote block until you have a real one. | 1 |
| `logo-1` to `logo-5` | Trust strip | 600 × 200 (3:1) | White or single-color logos of churches you've served, with permission. Remove unused slots. | 2 |
| `christmas-candlelight` | Christmas | 1200 × 900 (4:3) | Candlelight Christmas Eve service, full room, warm light. | 2 |

Already filled: `assets/images/chris-list-headshot.jpg` in the founder section.

## Fastest way to fill priority 1 slots

1. **hero-sunday, step-3-welcome, christmas-candlelight:** photograph a real Sunday at a church you already serve (Crossroads, Christian Assembly, Full Gospel). One hour before and after services covers all three.
2. **step-1-sermon, step-2-visit-page, snapshot-reach-map:** screenshots from your own demo snapshot, placed in a phone mockup.
3. **proof-video + testimonial:** ask your pilot church for a two-sentence quote once their first clips land.
