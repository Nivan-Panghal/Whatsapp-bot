/**
 * whatsapp-bot/quizSender.js
 *
 * WhatsApp cannot run a real multi-question quiz natively (no form-style
 * message type, no scoring). The quiz always lives on the website —
 * this module's only job is to resolve the lesson's quiz and send a
 * signed, watermark-style link to it, the same way lessonSender does
 * for the main lesson content.
 */

const crypto = require('crypto')

let _supabase, _sendMessage, _config

function initQuizSender({ supabase, sendMessage, config }) {
  _supabase = supabase
  _sendMessage = sendMessage
  _config = config
}

function escMd(text) {
  return String(text || '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

const { normalizePhone } = require('./phone')

// Mirrors index.js's signResourceUrl / course-web's signLessonResourceUrl —
// same secret, same payload shape, so /resource/[lessonId] can verify it.
function signQuizUrl(lessonId, phone) {
  const exp = Date.now() + 2 * 60 * 60 * 1000
  const payload = `resource.${lessonId}.quiz.${phone}.${exp}`
  const secret = _config.WHATSAPP_LINK_SECRET || _config.LESSON_LINK_SECRET
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  const params = new URLSearchParams({ type: 'quiz', identity: String(phone), exp: String(exp), sig })
  return `${_config.KURSO_URL}/resource/${lessonId}?${params.toString()}`
}

async function getEnrollment(phone) {
  const { data: enrollments, error } = await _supabase
    .from('enrollments')
    .select('*, courses:course_uuid(*)')
    .eq('phone', normalizePhone(phone) || String(phone))
    .order('enrolled_at', { ascending: false })
    .limit(1)

  if (error || !enrollments?.length || !enrollments[0].courses) return null
  return enrollments[0]
}

/**
 * Sends the signed quiz link for a given lesson order number.
 * @param {string|number} phone
 * @param {number} lessonOrderNum
 */
async function sendQuiz(phone, lessonOrderNum) {
  const enrollment = await getEnrollment(phone)
  if (!enrollment) {
    await _sendMessage(phone, 'ℹ️ No course connected yet. Open your course page and tap *Start on WhatsApp* first.')
    return
  }

  const { data: lessons, error } = await _supabase
    .from('lessons')
    .select('id, title, order_num, quiz_questions')
    .eq('course_id', enrollment.course_uuid)
    .eq('order_num', lessonOrderNum)
    .eq('is_published', true)
    .limit(1)

  if (error || !lessons?.length) {
    await _sendMessage(phone, '⚠️ Lesson not found.')
    return
  }

  const lesson = lessons[0]
  const questions = Array.isArray(lesson.quiz_questions) ? lesson.quiz_questions : []

  if (questions.length === 0) {
    await _sendMessage(phone, `ℹ️ No quiz available for *${escMd(lesson.title)}* yet.`)
    return
  }

  const quizUrl = signQuizUrl(lesson.id, phone)

  await _sendMessage(
    phone,
    `🧠 *Quiz: ${escMd(lesson.title)}*\n\n${questions.length} question${questions.length !== 1 ? 's' : ''}. Tap below to take it — your access link expires in 2 hours.\n\n• Take Quiz: ${quizUrl}`,
  )
}

module.exports = { initQuizSender, sendQuiz }