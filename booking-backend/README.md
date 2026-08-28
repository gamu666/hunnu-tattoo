# HUNNU booking Worker

Admin, artist-specific availability, QPay and Telegram reminder backend.

## First deployment

1. Copy `wrangler.toml.example` to `wrangler.toml` and set the D1 database id.
2. Apply `schema.sql` to the D1 database.
3. Add encrypted secrets: `ADMIN_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and the QPay merchant credentials.
4. Set `PUBLIC_WORKER_URL` to the deployed Worker URL.
5. Deploy the Worker. The cron trigger runs every 15 minutes.

Never commit secret values to GitHub. The admin page sends the session-only token in the `Authorization` header; every admin API operation validates it inside the Worker.
