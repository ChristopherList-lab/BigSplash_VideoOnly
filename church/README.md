# /church: Church Growth Snapshot landing page + intake

Live URL once pushed: https://bigsplash.video/church/ (this repo deploys to GitHub Pages on push to main).

## What's here
- `index.html`: the landing page. Same Tailwind CDN config, fonts and nav pattern as `faq.html`. Reuses `../js/intake.js` for the "Talk to Chris" modal (config key `Church`).
- `../worker-churchsnapshot/`: Cloudflare Worker that takes the form POST, creates a ClickUp task in "Church Growth Snapshots" (list 901421191181) with a 48-hour due date, and forwards to GHL if a webhook is set.
- `../assets/videos/church/splash-light.mp4`: a light version of the main site's water drop video, playing behind the hero report card. `../assets/images/ocean-starburst.webp` stands in when a visitor asks for reduced motion.

## Go-live checklist (about 30 minutes)

### 1. Deploy the worker
```
cd worker-churchsnapshot
npx wrangler login
npx wrangler secret put CLICKUP_TOKEN      # ClickUp > Settings > Apps > API Token
npx wrangler secret put GHL_WEBHOOK_URL    # optional
npx wrangler secret put ALLOWED_ORIGIN     # https://bigsplash.video
npx wrangler deploy
```
Paste the printed workers.dev URL into `SNAPSHOT_API_URL` near the bottom of `church/index.html`. Until then the form falls back to a pre-filled email to chris@bigsplash.agency, so nothing is lost.

### 2. Dropbox upload portal
Dropbox > File requests > New request, "Send Big Splash your sermon", folder `/Big Splash/Church Snapshots/_inbox`. Paste the request link into the `href` of `#cs-upload-link` in `church/index.html`.

### 3. ClickUp list (manual, list settings)
Statuses: New, Sermon received, Editing, QC, Delivered, Call booked, Won, Lost.
Custom fields: Source, Church, City, Attendance, Role, Sermon source, Sermon link, Reach number, Delivery folder, Loom link, Level closed, MRR.
Automation: on task created, assign editor. The worker already sets due date = created + 48h and tags `snapshot`, `website-form`.

### 4. Domain
The live site is bigsplash.video (GitHub Pages, `CNAME` = bigsplash.video). No domain change needed. bigsplash.agency is the email domain only.

## Snapshot SOP per church (target 75 minutes)
Intake 5 min: confirm the sermon plays, make `/Church Snapshots/[Church]/` with `source`, `clips`, `delivery`. Pull logo and one brand color.
Clips 60 min: 3 moments (one emotional, one takeaway, one hook a stranger would stop for). 30 to 60s, 1080x1920, captions in the middle third, church lower third for 3s, 2s end card with church name. Audio -14 LUFS. No Big Splash branding on the church's clips.
QC 10 min, second person: captions match, church name spelled right, safe zones, levels.
Delivery, Chris: 2-minute Loom (reach number on screen, one clip, what a week looks like, price, Calendly), day-0 email, text the cell, log Reach number, Delivery folder and Loom link on the task.

## Reach number lookup (10 min)
Meta Ads Manager > Audiences > Create saved audience. Pin the church address, 10-mile radius (5 miles inside Austin, Dallas, Houston, San Antonio), ages 18+, no interests. The estimated audience size is the reach number. Then search the church page in the Meta Ad Library and note "no campaigns" or the date of the last one. Screenshot both for the Loom.
