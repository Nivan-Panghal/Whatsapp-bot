/**
 * whatsapp-bot/ratingSender.js
 * Post-certificate 1–5 star rating collection via WhatsApp, two steps:
 *   1) reply with a number 1–5 (WhatsApp reply-buttons cap at 3, so a
 *      tappable 1–5 UI isn't practical here — plain text reply instead)
 *   2) optional follow-up written feedback (or "skip")
 *
 * Mirrors assignmentSender.js's pending-state pattern: a row keyed to the
 * student's enrollment tracks where they are in the flow, checked before
 * general text routing in index.js, and cleared once the rating is saved
 * (or the flow is cancelled).
 */

const { normalizePhone } = require('./phone')

let _supabase, _sendMessage

function initRatingSender({ supabase, sendMessage }) {
  _supabase = supabase
  _sendMessage = sendMessage
}

async function getEnrollmentIdentity(phone) {
  const { data } = await _supabase
    .from('enrollments')
    .select('id, course_uuid, student_id')
    .eq('phone', normalizePhone(phone) || String(phone))
    .order('enrolled_at', { ascending: false })
    .limit(1)
  return data?.[0] || null
}

async function getPendingRating(phone) {
  const enrollment = await getEnrollmentIdentity(phone)
  if (!enrollment) return null
  const { data } = await _supabase
    .from('pending_ratings')
    .select('*')
    .eq('enrollment_id', enrollment.id)
    .maybeSingle()
  return data || null
}

async function hasPendingRating(phone) {
  return !!(await getPendingRating(phone))
}

async function clearPendingRating(pending) {
  await _supabase.from('pending_ratings').delete().eq('id', pending.id)
}

async function cancelPendingRating(phone) {
  const pending = await getPendingRating(phone)
  if (!pending) return
  await clearPendingRating(pending)
  await _sendMessage(phone, '🚫 Rating cancelled.')
}

/**
 * Called right after the certificate CTA is sent in markDone(). Starts the
 * rating flow only if a certificate actually exists for this enrollment
 * and the student hasn't already rated the course.
 */
async function maybePromptForRating(phone, enrollment) {
  if (!enrollment?.id) return

  const { data: cert } = await _supabase
    .from('certificates')
    .select('student_name')
    .eq('enrollment_id', enrollment.id)
    .maybeSingle()
  if (!cert) return

  const { data: existingRating } = await _supabase
    .from('course_ratings')
    .select('id')
    .eq('enrollment_id', enrollment.id)
    .maybeSingle()
  if (existingRating) return

  const { error: upsertError } = await _supabase
    .from('pending_ratings')
    .upsert({
      student_id: enrollment.student_id || null,
      enrollment_id: enrollment.id,
      course_id: enrollment.course_uuid,
      student_name: cert.student_name,
      stage: 'awaiting_rating',
      rating: null,
    }, { onConflict: 'enrollment_id' })

  if (upsertError) {
    console.error('[ratingSender] upsert error:', upsertError.message)
    return
  }

  await _sendMessage(
    phone,
    `⭐ How would you rate this course?\n\nReply with a number from *1* to *5*.`,
  )
}

async function handleRatingReply(phone, text) {
  const pending = await getPendingRating(phone)
  if (!pending) return false

  const trimmed = String(text || '').trim()

  if (pending.stage === 'awaiting_rating') {
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      await _sendMessage(phone, '⚠️ Please reply with a number from *1* to *5*.')
      return true
    }
    await _supabase
      .from('pending_ratings')
      .update({ rating: n, stage: 'awaiting_review' })
      .eq('id', pending.id)
    await _sendMessage(
      phone,
      `Thanks! Want to add a short review? Reply with your feedback, or reply *skip*.`,
    )
    return true
  }

  // pending.stage === 'awaiting_review'
  const reviewText = trimmed.toLowerCase() === 'skip' ? null : (trimmed.slice(0, 1000) || null)

  const { error } = await _supabase.from('course_ratings').insert({
    course_id: pending.course_id,
    enrollment_id: pending.enrollment_id,
    student_name: pending.student_name,
    rating: pending.rating,
    review_text: reviewText,
  })

  await clearPendingRating(pending)

  if (error) {
    if (error.code === '23505') {
      await _sendMessage(phone, 'ℹ️ You already rated this course. Thank you!')
    } else {
      console.error('[ratingSender] insert error:', error.message)
      await _sendMessage(phone, '⚠️ Could not save your rating. Please try again later.')
    }
    return true
  }

  await _sendMessage(phone, '🙏 Thanks for rating this course!')
  return true
}

module.exports = {
  initRatingSender,
  maybePromptForRating,
  hasPendingRating,
  handleRatingReply,
  cancelPendingRating,
}