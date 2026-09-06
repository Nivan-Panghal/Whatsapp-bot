/**
 * Whatsapp-bot/lessonMessages.js
 * ─────────────────────────────────────────────────────────────────
 * Reads creator-set messages from the `lesson_messages` table
 * (same table the course-web broadcast widget writes to, shared
 * across Telegram and WhatsApp — no bot-specific data here):
 *
 *  - 'availability' message → shown INSTEAD of the lesson when it
 *    isn't published / missing content, or for a future "next
 *    lesson" slot that has no row yet.
 *  - 'note' message → shown ABOVE an already-available lesson.
 *
 * Stateless: every function takes the supabase client as its first
 * argument, so no init() wiring is needed — just require() it.
 * ─────────────────────────────────────────────────────────────────
 */

function lessonNeedsContent(lesson) {
  if (lesson.content_type === 'quiz') {
    return !Array.isArray(lesson.quiz_questions) || lesson.quiz_questions.length === 0
  }
  if (lesson.content_type === 'assignment') {
    return !String(lesson.assignment_prompt || '').trim() && !String(lesson.assignment_file_url || '').trim()
  }
  return false
}

function isLessonAvailable(lesson) {
  return lesson.is_published && !lessonNeedsContent(lesson)
}

/** The real lesson row for this order_num, regardless of publish state — or null if it doesn't exist yet. */
async function findLessonRow(supabase, courseId, orderNum) {
  const { data } = await supabase
    .from('lessons')
    .select('id, title, is_published, content_type, quiz_questions, assignment_prompt, assignment_file_url')
    .eq('course_id', courseId)
    .eq('order_num', orderNum)
    .maybeSingle()
  return data || null
}

/**
 * Returns the creator's custom "not available yet" message for this lesson
 * slot, or null if none is set (caller should fall back to its own generic
 * copy in that case — this never invents wording).
 */
async function getAvailabilityMessage(supabase, courseId, orderNum) {
  const lessonRow = await findLessonRow(supabase, courseId, orderNum)

  const query = supabase
    .from('lesson_messages')
    .select('message_text')
    .eq('course_id', courseId)
    .eq('message_type', 'availability')

  const { data } = lessonRow
    ? await query.eq('lesson_id', lessonRow.id).maybeSingle()
    : await query.eq('pending_lesson_number', orderNum).is('lesson_id', null).maybeSingle()

  return data?.message_text || null
}

/** Returns the creator's "note" message for an already-available lesson, or null. */
async function getNoteMessage(supabase, lessonId) {
  const { data } = await supabase
    .from('lesson_messages')
    .select('message_text')
    .eq('lesson_id', lessonId)
    .eq('message_type', 'note')
    .maybeSingle()
  return data?.message_text || null
}

module.exports = {
  isLessonAvailable,
  lessonNeedsContent,
  findLessonRow,
  getAvailabilityMessage,
  getNoteMessage,
}