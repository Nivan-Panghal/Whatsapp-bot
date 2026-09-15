/**
 * whatsapp-bot/lessonSender.js
 *
 * Changes from original:
 *  - Updated to use phone numbers instead of chat IDs
 *  - Updated to use WhatsApp-specific lesson link secret
 */

const crypto = require('crypto')
const axios = require('axios')
const { checkRateLimit, logLessonAccess } = require('./watermark')
const { getRequiredAssignmentBlock } = require('./assignmentSender')
const { getAvailabilityMessage, getNoteMessage } = require('./lessonMessages')

let _supabase, _sendMessage, _config, _buildLessonMenuKeyboard, _sendCtaUrlButton

// buildLessonMenuKeyboard is injected from index.js so both files share the
// exact same Next/Previous/Activities-or-MyCourses button logic — no
// duplicated layout code to drift out of sync.
function init({ supabase, sendMessage, config, buildLessonMenuKeyboard, sendCtaUrlButton }) {
  _supabase = supabase
  _sendMessage = sendMessage
  _config = config
  _buildLessonMenuKeyboard = buildLessonMenuKeyboard
  _sendCtaUrlButton = sendCtaUrlButton
}

// See phone.js — DB stores bare 10-digit numbers (no country code); Meta
// sends `phone` with the country code prefixed, so it must be stripped
// here before it's used to look anything up.
const { normalizePhone } = require('./phone')

// ── Signing (mirrors lib/signer.ts) ───────────────────────────────────────
function signLessonPageUrl(courseId, lessonId, lessonNum, phone) {
  const TTL = 2 * 60 * 60 * 1000 // 2 hours
  const exp = Date.now() + TTL
  const payload = `lesson.${courseId}.${lessonId}.${lessonNum}.${phone}.${exp}`
  const sig = crypto
    .createHmac('sha256', _config.WHATSAPP_LINK_SECRET || _config.LESSON_LINK_SECRET)
    .update(payload)
    .digest('hex')

  const params = new URLSearchParams({
    courseId,
    lessonId,
    lesson: String(lessonNum),
    identity: phone,
    exp: String(exp),
    sig,
  })

  return `${_config.ACADEMYKIT_URL}/api/whatsapp/lesson?${params.toString()}`
}

async function createWebBootstrapUrl({ course, enrollment, channel }) {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto
    .createHash('sha256')
    .update(rawToken)
    .digest('hex')

  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString()

  const { error } = await _supabase
    .from('web_bootstrap_tokens')
    .insert({
      token_hash: tokenHash,
      course_id: course.id,
      enrollment_id: enrollment.id,
      student_id: enrollment.student_id || null,
      channel,
      expires_at: expiresAt,
    })

  if (error) {
    throw new Error(`Could not create web access token: ${error.message}`)
  }

  return `${_config.ACADEMYKIT_URL}/api/web-access/bootstrap?t=${encodeURIComponent(rawToken)}`
}

// ── Zero-width fingerprint (mirrors lib/signer.ts) ─────────────────────────
const ZWS = '\u200B'  // bit 0
const ZWNJ = '\u200C' // bit 1

function encodeFingerprint(text, maxChars = 12) {
  let result = ''
  for (let i = 0; i < Math.min(text.length, maxChars); i++) {
    const code = text.charCodeAt(i)
    for (let bit = 7; bit >= 0; bit--) {
      result += (code >> bit) & 1 ? ZWNJ : ZWS
    }
  }
  return result
}

// ── Markdown escaper (for WhatsApp) ─────────────────────────────────────────
function escMd(text) {
  return String(text || '')
    .replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

// ── Main sendLesson ─────────────────────────────────────────────────────────
async function sendLesson(phone) {
  // 1. Rate limit
  const { limited, retryAfterSeconds } = await checkRateLimit(phone)
  if (limited) {
    const mins = Math.ceil(retryAfterSeconds / 60)
    await _sendMessage(
      phone,
      `⏳ *Slow down!*\n\nYou're requesting lessons too quickly. Please wait *${mins} minute${mins > 1 ? 's' : ''}* before requesting the next lesson.`
    )
    return
  }

  // 2. Get enrollment (most recent for this phone)
  const { data: enrollments, error: enrollErr } = await _supabase
    .from('enrollments')
    .select('*, courses:course_uuid(*)')
    .eq('phone', normalizePhone(phone) || String(phone))
    .order('enrolled_at', { ascending: false })
    .limit(1)

  if (enrollErr || !enrollments?.length || !enrollments[0].courses) {
    await _sendMessage(phone, 'ℹ️ No course connected yet. Open your course page and tap *Start on WhatsApp* first.')
    return
  }

  const enrollment = enrollments[0]
  const course = enrollment.courses
  const lessonNum = enrollment.current_lesson || 1

  // Draft courses: only paid students retain access.
  // Free preview users are blocked — they haven't paid.
  if (course.is_published === false && enrollment.payment_status !== 'paid') {
    await _sendMessage(
      phone,
      '⏸ This course is temporarily unavailable. Please check back later or contact your instructor.'
    )
    return
  }

  // Required assignment on previous lesson must be submitted first
  const assignmentBlock = await getRequiredAssignmentBlock(enrollment, lessonNum)
  if (assignmentBlock) {
    await _sendMessage(
      phone,
      `🔒 *Assignment required*\n\nComplete the assignment for Lesson ${assignmentBlock.prevLessonNum} before continuing.\n\n${escMd(String(assignmentBlock.prompt).slice(0, 400))}`,
      {
        inline_keyboard: [
          [{ text: '📝 Submit HW', callback_data: `assign:${assignmentBlock.prevLessonNum}` }],
        ],
      },
    )
    return
  }

  // 3. Fetch lesson (must happen before the free-preview check — a lesson's
  // free/paid status is now a per-lesson flag, not derivable from order alone)
  const { data: lessons, error: lessonErr } = await _supabase
    .from('lessons')
    .select('*')
    .eq('course_id', course.id)
    .eq('order_num', lessonNum)
    .eq('is_published', true)
    .limit(1)

   

    if (lessonErr || !lessons?.length) {
    // If this student already has a certificate for this course, that means
    // they finished it — show the certificate instead of a generic "not
    // published yet" message, which is what they'd otherwise land on right
    // after completing the creator's marked last lesson.
    const { data: existingCert } = await _supabase
      .from('certificates')
      .select('pdf_url')
      .eq('enrollment_id', enrollment.id)
      .maybeSingle()
    if (existingCert?.pdf_url) {
      await _sendCtaUrlButton(
        phone,
        `🎉 You've completed this course!\n\nYour certificate is ready.`,
        '🎓 View Certificate',
        existingCert.pdf_url,
      )
      if (lessonNum > 1) {
        await _sendMessage(phone, 'Want to revisit anything?', {
          inline_keyboard: [[{ text: '⬅ Previous Lesson', callback_data: `goto:${lessonNum - 1}` }]],
        })
      }
      return
    }

    // Creator-set availability message (per-lesson, from the broadcast
    // widget) takes priority over the generic fallback below.
        const customAvailabilityMessage = await getAvailabilityMessage(_supabase, course.id, lessonNum)
    if (customAvailabilityMessage) {
      const lockedKeyboard = lessonNum > 1
        ? { inline_keyboard: [[{ text: '⬅ Previous Lesson', callback_data: `goto:${lessonNum - 1}` }]] }
        : undefined
      await _sendMessage(phone, escMd(customAvailabilityMessage), lockedKeyboard)
      return
    }

    const { count: publishedCount } = await _supabase
      .from('lessons')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', course.id)
      .eq('is_published', true)

    const nextDate = course.next_lesson_date
      ? new Date(course.next_lesson_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null
    const endDate = course.course_end_date
      ? new Date(course.course_end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null
    const total = course.total_lessons || publishedCount || 0
    const infoMessage = course.student_update_message
      ? escMd(String(course.student_update_message).slice(0, 500))
      : null

    await _sendMessage(
      phone,
      [
        `You are caught up. Lesson ${lessonNum} is not published yet.`,
        `Progress: ${Math.min(lessonNum - 1, publishedCount || 0)}/${total} lessons watched.`,
        nextDate ? `Next lesson is planned for *${escMd(nextDate)}*.` : `The creator has not announced the next lesson date yet.`,
        endDate ? `Course planned end date: *${escMd(endDate)}*.` : '',
        infoMessage ? `\nCreator note: ${infoMessage}` : '',
      ].filter(Boolean).join('\n')
    )
    return
  }

  const lesson = lessons[0]

  // 4. Free preview check
  const allowed = isLessonAllowed(enrollment, lesson)
  if (!allowed) {
    const courseUrl = `${_config.ACADEMYKIT_URL}/about-course/${slugify(course.host_name || 'creator')}/${slugify(course.name || course.slug || 'course')}/${course.id}`
    await _sendMessage(
      phone,
      `🔒 *Free preview complete.*\n\nYou'll need to pay to continue this course.`,
      { inline_keyboard: [[{ text: 'Pay Now', url: courseUrl }]] }
    )
    return
  }

    // 4.5 Creator "note" for an already-available lesson — sent first, as its own message.
  const noteMessage = await getNoteMessage(_supabase, lesson.id)
  if (noteMessage) {
    await _sendMessage(phone, escMd(noteMessage))
  }

  // 5. Generate signed lesson page URL
  const lessonUrl = await createWebBootstrapUrl({
  course,
  enrollment,
  channel: 'whatsapp',
})

  // 6. Build watermarked message
  const fp = encodeFingerprint(String(phone))
  const durationLine = lesson.duration ? `⏱ ${lesson.duration}\n` : ''

  const linkBodyText = [
    `📖 *Lesson ${lesson.order_num}: ${escMd(lesson.title)}*`,
    durationLine,
    'Open this link within 2 minutes. After opening it, you can continue learning on the website.',
    ``,
    `🔒 _This link is personal. Sharing it violates your license agreement._`,
    fp,
  ].join('\n')

  // Two messages: a clean single-button "Open Lesson" link (WhatsApp's
  // cta_url type hides the raw URL entirely — no ugly link text), then a
  // normal follow-up with the Next/Previous/Activities-or-MyCourses menu.
  // These can't be combined into one message — WhatsApp doesn't allow a
  // cta_url button alongside reply buttons in the same interactive message.
  await _sendCtaUrlButton(phone, linkBodyText, '▶ Open Lesson', lessonUrl)

  const menu = await _buildLessonMenuKeyboard(_supabase, enrollment, lesson)
  await _sendMessage(phone, `What's next?`, menu)

  // Update last_accessed (non-blocking)
  _supabase
    .from('enrollments')
    .update({ last_accessed: new Date().toISOString() })
    .eq('id', enrollment.id)
    .then(() => {}).catch(() => {})

  // Log access (non-blocking)
  logLessonAccess(String(phone), lesson.id, course.id).catch(() => {})
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// KEEP IN SYNC WITH src/lib/freeLesson.ts in course-web
function isLessonAllowed(enrollment, lesson) {
  if (enrollment.payment_status === 'paid') return true
  return enrollment.courses?.is_free_course === true || lesson.is_free === true
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

module.exports = {
  init,
  sendLesson,
  createWebBootstrapUrl,
  encodeFingerprint,
  escMd,
}