/**
 * whatsapp-bot/phone.js
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for phone normalization in this bot.
 *
 * Mirrors course-web/src/lib/phone.ts: `enrollments.phone`, `students.phone`
 * and `whatsapp_tokens.student_phone` are all stored as bare digits, no "+",
 * no spaces. Indian numbers are stored as the bare 10 digits; numbers from
 * other countries keep their country code (EnrollModal.tsx stores the
 * selected country's code plus the number).
 *
 * Meta's WhatsApp Cloud API, however, always sends `metaMessage.from` WITH
 * the country code, e.g. "919306385029". Before this module existed, three
 * separate copies of `normalizePhone()` lived in index.js, lessonSender.js
 * and quizSender.js — none of them stripped the country code, and
 * assignmentSender.js didn't normalize at all. The result: every WhatsApp
 * lookup against `enrollments`/`students` (keyed on the bare 10-digit form)
 * silently failed to match a real student's own enrollment, sending them
 * "something went wrong" errors or creating orphaned duplicate rows.
 *
 * Always normalize through THIS function before reading or writing the
 * `phone` column anywhere in this bot. Don't add a fourth copy.
 * ─────────────────────────────────────────────────────────────────
 */

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  // Strip a leading Indian country code so this always lands on the same
  // bare 10-digit form the rest of the system (course-web) stores.
  // 12 digits starting with "91" -> "919306385029" becomes "9306385029"
  if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 13 && digits.startsWith("091")) {
    // defensive: some clients prefix a leading 0 before the country code
    digits = digits.slice(3);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    // domestic dialing prefix, e.g. "09306385029"
    digits = digits.slice(1);
  }

  return digits || null;
}

module.exports = { normalizePhone };