/**
 * whatsapp-bot/workshopNudger.js
 *
 * Pre-purchase nurture: a WhatsApp reminder to people who registered for a
 * PAID workshop but haven't paid. Two nudges per registration, ever:
 *   step 1 — 2 hours after registering
 *   step 2 — 24 hours after registering (and at least 12h after step 1)
 *
 * Runs on the bot's own timer (same pattern as pollWorkshopReminders), so it
 * does not depend on Vercel's once-a-day cron.
 *
 * Who gets nudged (ALL must be true):
 *   - the creator switched "Payment reminders" on (creators.nudge_enabled)
 *     and the registration was created AFTER they switched it on
 *   - payment_status = 'pending_confirmation' AND utr_reference IS NULL
 *     (if a UTR is filled in, the student HAS paid and is waiting on the
 *      creator's "Mark Paid" — nagging them to pay again would be wrong)
 *   - the workshop is published and starts more than 2 hours from now
 *   - nobody is mid-checkout right now (no gateway attempt in the last hour)
 *   - it is between 9:00 and 21:00 IST (no messages at night)
 *
 * Safety: each (registration, step) is claimed by inserting a row into
 * workshop_nudges (unique key) BEFORE sending, so a step can never be sent
 * twice. A failed send is retried up to 3 times, 15+ minutes apart.
 */

let _supabase, _sendTemplate, _config

const STEP_1_DELAY_MS = 2 * 60 * 60 * 1000
const STEP_2_DELAY_MS = 24 * 60 * 60 * 1000
const MIN_GAP_BETWEEN_STEPS_MS = 12 * 60 * 60 * 1000
const MIN_TIME_BEFORE_WORKSHOP_MS = 2 * 60 * 60 * 1000
const RECENT_CHECKOUT_MS = 60 * 60 * 1000
const RETRY_AFTER_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 3
const MAX_SENDS_PER_RUN = 25
const SEND_HOUR_START_IST = 9
const SEND_HOUR_END_IST = 21
const DEFAULT_NOTE = 'Please complete the payment to secure your seat.'

function initWorkshopNudger({ supabase, sendWhatsAppTemplate, config }) {
  _supabase = supabase
  _sendTemplate = sendWhatsAppTemplate
  _config = config
}

function istHourNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours()
}

// Meta named template parameters can't contain newlines, tabs, or long runs
// of spaces — and a creator-typed note must never break the send.
function cleanParam(value, maxLen) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, maxLen)
}

function formatDateTimeIst(iso) {
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  })
}

// Claims (registrationId, step) so it can be sent by exactly one run.
// Returns the attempt number (1-3) if claimed, or null if not claimable.
async function claimNudge(registrationId, step, existing) {
  if (!existing) {
    const { error } = await _supabase
      .from('workshop_nudges')
      .insert({ registration_id: registrationId, step, status: 'pending', attempts: 1 })
    if (!error) return 1
    if (error.code !== '23505') {
      console.error('[workshopNudger] claim insert failed:', error.message)
    }
    return null
  }

  // Retry path: only a FAILED row, under the attempt cap, not touched recently.
  if (existing.status !== 'failed' || existing.attempts >= MAX_ATTEMPTS) return null
  if (Date.now() - new Date(existing.updated_at).getTime() < RETRY_AFTER_MS) return null

  const nextAttempt = existing.attempts + 1
  const { data, error } = await _supabase
    .from('workshop_nudges')
    .update({ status: 'pending', attempts: nextAttempt, updated_at: new Date().toISOString() })
    .eq('registration_id', registrationId)
    .eq('step', step)
    .eq('status', 'failed')
    .select('id')
  if (error || !data || data.length === 0) return null
  return nextAttempt
}

async function finishNudge(registrationId, step, ok, errorText) {
  const now = new Date().toISOString()
  const { error } = await _supabase
    .from('workshop_nudges')
    .update(
      ok
        ? { status: 'sent', sent_at: now, updated_at: now, last_error: null }
        : { status: 'failed', updated_at: now, last_error: errorText || 'send failed' },
    )
    .eq('registration_id', registrationId)
    .eq('step', step)
  if (error) console.error('[workshopNudger] finish update failed:', error.message)
}

async function pollWorkshopNudges() {
  if (!_supabase || !_sendTemplate) return
  try {
    const hour = istHourNow()
    if (hour < SEND_HOUR_START_IST || hour >= SEND_HOUR_END_IST) return

    const now = Date.now()

    // 1. Creators who switched reminders on.
    const { data: creators, error: creatorsError } = await _supabase
      .from('creators')
      .select('id, name, creator_slug, nudge_note, nudge_enabled_at')
      .eq('nudge_enabled', true)
    if (creatorsError) {
      console.error('[workshopNudger] creators query failed:', creatorsError.message)
      return
    }
    if (!creators || creators.length === 0) return
    const creatorById = new Map(creators.map((c) => [c.id, c]))

    // 2. Their upcoming published workshops (starting > 2h from now).
    const { data: workshops, error: workshopsError } = await _supabase
      .from('workshops')
      .select('id, creator_id, title, slug, date_time')
      .eq('status', 'published')
      .in('creator_id', [...creatorById.keys()])
      .gt('date_time', new Date(now + MIN_TIME_BEFORE_WORKSHOP_MS).toISOString())
    if (workshopsError) {
      console.error('[workshopNudger] workshops query failed:', workshopsError.message)
      return
    }
    if (!workshops || workshops.length === 0) return
    const workshopById = new Map(workshops.map((w) => [w.id, w]))

    // 3. Registrations that registered 2h+ ago, still unpaid, no UTR submitted.
    const { data: regs, error: regsError } = await _supabase
      .from('workshop_registrations')
      .select('id, workshop_id, name, phone, created_at, payment_attempted_at')
      .in('workshop_id', [...workshopById.keys()])
      .eq('payment_status', 'pending_confirmation')
      .is('utr_reference', null)
      .lte('created_at', new Date(now - STEP_1_DELAY_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(500)
    if (regsError) {
      console.error('[workshopNudger] registrations query failed:', regsError.message)
      return
    }
    if (!regs || regs.length === 0) return

    // 4. What has already been sent / claimed for them.
    const { data: nudgeRows, error: nudgesError } = await _supabase
      .from('workshop_nudges')
      .select('registration_id, step, status, attempts, sent_at, updated_at')
      .in('registration_id', regs.map((r) => r.id))
    if (nudgesError) {
      console.error('[workshopNudger] nudges query failed:', nudgesError.message)
      return
    }
    const nudgeByKey = new Map((nudgeRows || []).map((n) => [`${n.registration_id}:${n.step}`, n]))

    let sends = 0
    for (const reg of regs) {
      if (sends >= MAX_SENDS_PER_RUN) break
      if (!reg.phone) continue

      const workshop = workshopById.get(reg.workshop_id)
      const creator = workshop && creatorById.get(workshop.creator_id)
      if (!workshop || !creator || !creator.creator_slug) continue

      const createdAt = new Date(reg.created_at).getTime()

      // Only registrations made AFTER the creator turned reminders on —
      // switching it on must never blast their older backlog.
      if (creator.nudge_enabled_at && createdAt < new Date(creator.nudge_enabled_at).getTime()) continue

      // Someone actively paying right now — leave them alone.
      if (reg.payment_attempted_at && now - new Date(reg.payment_attempted_at).getTime() < RECENT_CHECKOUT_MS) continue

      const step1 = nudgeByKey.get(`${reg.id}:1`)
      const step2 = nudgeByKey.get(`${reg.id}:2`)

      let step = null
      let existing = null
      if (!step1 || step1.status !== 'sent') {
        // Step 1 not done yet (never tried, or failed and eligible to retry).
        if (createdAt + STEP_1_DELAY_MS <= now) { step = 1; existing = step1 || null }
      } else {
        const step1SentAt = step1.sent_at ? new Date(step1.sent_at).getTime() : now
        const step2DueAt = Math.max(createdAt + STEP_2_DELAY_MS, step1SentAt + MIN_GAP_BETWEEN_STEPS_MS)
        if (step2DueAt <= now) { step = 2; existing = step2 || null }
      }
      if (!step) continue

      const attempt = await claimNudge(reg.id, step, existing)
      if (!attempt) continue

      const firstName = cleanParam(String(reg.name || '').split(/\s+/)[0], 40) || 'there'
      const registerLink = `${_config.KURSO_URL}/w/${creator.creator_slug}/${workshop.slug}`

      const ok = await _sendTemplate(reg.phone, _config.TEMPLATE_NAME, [
        { name: 'student_name', value: firstName },
        { name: 'workshop_title', value: cleanParam(workshop.title, 120) },
        { name: 'datetime_label', value: formatDateTimeIst(workshop.date_time) },
        { name: 'host_note', value: cleanParam(creator.nudge_note, 120) || DEFAULT_NOTE },
        { name: 'register_link', value: registerLink },
      ])
      await finishNudge(reg.id, step, ok, ok ? null : 'Meta rejected the template send')
      sends++
      console.log(
        `[workshopNudger] step ${step} (attempt ${attempt}) to ${reg.phone} for workshop ${workshop.id}: ${ok ? 'sent' : 'FAILED'}`,
      )
    }
  } catch (err) {
    console.error('[workshopNudger] unhandled error:', err.message)
  }
}

module.exports = { initWorkshopNudger, pollWorkshopNudges }