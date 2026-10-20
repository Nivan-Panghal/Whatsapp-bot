# Kurso — WhatsApp Bot

Delivers Kurso course content to students over WhatsApp, using Meta's official WhatsApp Business API (not a third-party wrapper): lessons, quizzes, assignment prompts, and reminders.

Part of the [Kurso](https://github.com/Nivan-Panghal/course-web) platform — see that repo for the full product overview.

## What this service does

- Sends lesson content (video/PDF links, text) to enrolled students on request
- Runs quizzes and assignment submissions directly inside the chat
- Verifies every student against Kurso's Supabase database before sending anything, using signed enrollment tokens
- Generates time-limited, signed links back to the website for content that needs to be viewed there (e.g. watermarked video)
- Verifies incoming Meta webhook signatures for security

## Tech stack

Node.js, Express (webhook server), Supabase client, Meta WhatsApp Business API.



Requires a `.env` file with your own values for `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `KURSO_URL`, and `LESSON_LINK_SECRET` — this bot doesn't run standalone; it needs a live Kurso backend to fetch course data from.