# HUNNU Tattoo Studio — Project Handoff

This document gives a new ChatGPT/Codex session enough context to continue the project safely. Never add passwords, API tokens, merchant credentials, Telegram bot tokens, or the admin login code to this repository.

## Project links

- Production domain: `https://hunnutattoo.com`
- GitHub Pages fallback: `https://gamu666.github.io/hunnu-tattoo/`
- Repository: `https://github.com/gamu666/hunnu-tattoo`
- Admin page: `https://hunnutattoo.com/admin.html`
- Cloudflare Worker: `https://hunnu-booking.ulamsainmunkhjargal.workers.dev`
- Cloudflare account: customer-owned account; use the account already connected in the desktop browser

## Local folders

- Working repository: `C:\Users\HP\OneDrive\Desktop\HTS\github-sync`
- Original local mirror: `C:\Users\HP\OneDrive\Desktop\HTS\index (1).html`

The `github-sync` repository is the source of truth. The parent folder is already inside OneDrive, but GitHub should remain the primary version-control and recovery mechanism for website code.

## Frontend

- The website is a static HTML/CSS/JavaScript project in `index.html`.
- Artist profiles and gallery images are stored directly in the repository.
- `admin.html` is the private booking-management interface.
- Booking dates are generated automatically for the next 31 days.
- Booking times run hourly from `10:00` through `22:00` every day.
- Availability is artist-specific and is fetched from the Cloudflare Worker.
- Desktop shows the time choices in a seven-column grid; mobile uses four columns so every time is visible without hidden horizontal scrolling.
- Deposits are configured as 20,000 MNT for tattoo and laser removal, and 5,000 MNT for piercing.
- Zulka's displayed hourly rate is 150,000 MNT.

## Backend architecture

Backend source files are in `booking-backend/`:

- `worker.js` — Cloudflare Worker API, admin API, Telegram notification relay, reminder logic, and QPay scaffolding.
- `schema.sql` — Cloudflare D1 schema.
- `wrangler.toml.example` — non-secret deployment example.
- `README.md` — short deployment notes.

Cloudflare resources:

- Worker name: `hunnu-booking`
- D1 database name: `hunnu-booking`
- D1 binding: `DB`
- Cron trigger: every 15 minutes

The D1 database stores bookings and prevents two active bookings for the same artist, date, and time. Admin-created in-person or phone bookings also occupy the slot on the public website.

## Admin workflow

The studio owner opens `/admin.html` and signs in with the admin code stored only as the encrypted Cloudflare `ADMIN_TOKEN` secret.

The admin can:

- view bookings by date range;
- manually add a booking received in person, by phone, or by chat;
- edit artist, service, date, time, customer details, and notes;
- cancel a booking and release the slot.

Do not put the admin code in this file, GitHub, screenshots, or source code. If it must be changed, update the encrypted `ADMIN_TOKEN` secret in Cloudflare Worker settings.

## Telegram notifications

The current Worker can relay messages to the pre-existing Telegram booking Worker through `LEGACY_BOOKING_URL`. That legacy Worker sends to the studio's shared Telegram group.

Intended reminder behavior:

- at approximately 20:00 Ulaanbaatar time, send the next day's schedule to the shared group;
- send one reminder for each booking approximately 30 minutes before its start time;
- use `reminder_log` to prevent duplicate reminders.

Important deployment note: the repository source now contains the 30-minute reminder rule. Confirm that the latest `booking-backend/worker.js` has also been deployed to the live Cloudflare Worker. The previously deployed live version used a two-hour reminder window.

## QPay status

QPay flow and merchant routing are scaffolded but not production-ready until merchant API credentials are received.

Two merchant routes are planned:

- tattoo and laser removal → tattoo merchant;
- piercing → piercing merchant.

Required encrypted Cloudflare secrets include each merchant's client ID, client secret, and invoice code. Never commit these values. After credentials arrive, verify invoice creation, callback validation, payment-status polling, expiration behavior, and both merchant destinations before enabling the payment UI for customers.

## Telegram/QPay/Cloudflare secrets

Expected secret or runtime variable names may include:

- `ADMIN_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `LEGACY_BOOKING_URL`
- `PUBLIC_WORKER_URL`
- QPay merchant credentials using the `QPAY_TATTOO_` and `QPAY_PIERCING_` prefixes

Only non-secret URLs belong in GitHub. Store all credentials as encrypted Cloudflare secrets.

## Domain and HTTPS

The Namecheap DNS records were configured for GitHub Pages:

- apex domain uses GitHub Pages A records;
- `www` is a CNAME to `gamu666.github.io`.

GitHub Pages previously showed `DNS Check in Progress` while waiting to issue the TLS certificate. Verify the current state under repository **Settings → Pages**. Enable **Enforce HTTPS** as soon as GitHub makes the option available.

## Highest-priority next tasks

1. Deploy the latest `booking-backend/worker.js` to Cloudflare and verify the 30-minute Telegram reminder in the shared group.
2. Confirm the daily next-day reminder format and Ulaanbaatar timezone behavior.
3. Check GitHub Pages certificate status and enable Enforce HTTPS.
4. Add and test both QPay merchant credential sets when the client receives them.
5. Run end-to-end tests for public booking, double-booking prevention, admin manual booking, edit/cancel, Telegram notification, reminder deduplication, and QPay payment confirmation.

## Starting a new ChatGPT.com project

Create a new ChatGPT Project, upload this file, and provide the GitHub repository URL. Ask the new chat to read `PROJECT_HANDOFF.md` before proposing or making changes. For code changes, always work from the GitHub repository rather than an isolated uploaded copy, and never paste secrets into chat.
