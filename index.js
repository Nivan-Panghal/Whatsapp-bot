if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { initWatermark } = require("./watermark");
const { initQuizSender, sendQuiz } = require("./quizSender");
const { initWorkshopNudger, pollWorkshopNudges } = require("./workshopNudger");
const {
  initUsage,
  registerTemplateCategories,
  categoryForTemplate,
  ctxFromBody,
  resolveOwner,
  recordSend,
  handleStatusPayload,
  isCreatorOverdue,
  workshopWhatsappEnabled,
} = require("./usage");

const {
  initConnections,
  accountForPhoneNumberId,
  hasConnectedNumber,
  pickAccount,
  runWithAccount,
  describeMetaError,
  isAccountLevelError,
  isTemplateNotReadyError,
  reportProblem,
  setupTemplates,
} = require("./connections");
const {
  initAssignmentSender,
  sendAssignmentPrompt,
  beginAssignmentSubmit,
  submitAssignmentText,
  getRequiredAssignmentBlock,
  cancelPending,
  hasPendingSubmission,
} = require("./assignmentSender");
const {
  initRatingSender,
  maybePromptForRating,
  hasPendingRating,
  handleRatingReply,
  cancelPendingRating,
} = require("./ratingSender");

const {
  sendLesson,
  createWebBootstrapUrl,
  encodeFingerprint,
  escMd,
  init: initLessonSender,
} = require("./lessonSender");

const app = express();

// DIAGNOSTIC — logs the bare fact that a request arrived, before any body
// parsing, signature checks, or routing. If a request from Meta doesn't
// show up here, it never reached this server at all — the problem is
// upstream (Meta not sending it, Render not routing it), not in this code.
app.use((req, res, next) => {
  console.log(
    `[REQUEST] ${req.method} ${req.originalUrl} | content-type: ${req.get("content-type") || "none"}`,
  );
  next();
});

app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

const META_WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v22.0";
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || "";
const INTERNAL_BOT_SECRET = process.env.INTERNAL_BOT_SECRET || "";
const META_LIVE_REMINDER_TEMPLATE =
  process.env.META_LIVE_REMINDER_TEMPLATE_NAME || "live_class_reminder";
const META_RECORDING_READY_TEMPLATE =
  process.env.META_RECORDING_READY_TEMPLATE_NAME || "live_recording_ready";
const META_RECORDING_UNAVAILABLE_TEMPLATE =
  process.env.META_RECORDING_UNAVAILABLE_TEMPLATE_NAME ||
  "live_recording_unavailable";
const META_TEMPLATE_LANG = process.env.META_TEMPLATE_LANG || "en";
const META_WORKSHOP_CONFIRMATION_TEMPLATE =
  process.env.META_WORKSHOP_CONFIRMATION_TEMPLATE_NAME || "workshop_confirmation";
const META_WORKSHOP_REMINDER_TEMPLATE =
  process.env.META_WORKSHOP_REMINDER_TEMPLATE_NAME || "workshop_reminder";
const META_WORKSHOP_NUDGE_TEMPLATE =
  process.env.META_WORKSHOP_NUDGE_TEMPLATE_NAME || "workshop_payment_nudge";
// The nudge is a promotional message, so it is billed (and paused for overdue creators) as marketing.
// Every other template is treated as utility. Meta's own delivery report decides what is actually charged.
registerTemplateCategories({ [META_WORKSHOP_NUDGE_TEMPLATE]: "marketing" });
const KURSO_URL = (process.env.KURSO_URL || "").replace(/\/$/, "");
const LESSON_LINK_SECRET =
  process.env.WHATSAPP_LINK_SECRET ||
  process.env.LESSON_LINK_SECRET ||
  WEBHOOK_SECRET;

// Mirrors course-web/src/lib/phone.ts — always normalize before reading OR
// writing the `phone` column on enrollments/students/whatsapp_tokens.
// Meta's Cloud API already sends `message.from` as digits only, no "+" and
// no "whatsapp:" prefix (e.g. "919306385029"), matching what course-web's
// payment webhook stores. This normalizer is kept anyway as a defensive
// guard — some call sites still pass in identity strings built elsewhere
// (signed lesson URLs, /start tokens) that may carry stray formatting.
// See phone.js — always normalize before reading OR writing the `phone`
// column on enrollments/students/whatsapp_tokens. Meta's Cloud API sends
// `message.from` WITH the country code (e.g. "919306385029"), but
// course-web stores/matches bare 10-digit numbers with no country code
// (see src/lib/phone.ts and EnrollModal.tsx's 10-digit input cap). This
// mismatch was the root cause of "something went wrong saving your
// enrollment" — the bot could never match a student's web-created
// enrollment, so it fell into a fresh insert every time.
const { normalizePhone } = require("./phone");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Initialize shared modules
initWatermark(supabase);
initUsage({ supabase }); // counts WhatsApp messages for billing (see usage.js)
// Creators who connected their OWN WhatsApp number send from it (see connections.js).
initConnections({
  supabase,
  config: {
    kursoUrl: KURSO_URL,
    internalSecret: INTERNAL_BOT_SECRET,
    graphVersion: META_GRAPH_VERSION,
    kursoWabaId: process.env.META_WABA_ID || "",
    kursoToken: META_WHATSAPP_TOKEN,
    templateLang: META_TEMPLATE_LANG,
  },
});
initLessonSender({
  supabase,
  sendMessage: async (phone, text, keyboard, opts) =>
    sendWhatsAppMessage(phone, text, keyboard, opts),
  sendCtaUrlButton: async (phone, bodyText, buttonText, targetUrl) =>
    sendCtaUrlButton(phone, bodyText, buttonText, targetUrl),
  buildLessonMenuKeyboard,
  config: {
    WHATSAPP_LINK_SECRET: LESSON_LINK_SECRET,
    LESSON_LINK_SECRET,
    KURSO_URL,
  },
});
initQuizSender({
  supabase,
  sendMessage: async (phone, text, keyboard, opts) =>
    sendWhatsAppMessage(phone, text, keyboard, opts),
  config: {
    WHATSAPP_LINK_SECRET: LESSON_LINK_SECRET,
    LESSON_LINK_SECRET,
    KURSO_URL,
  },
});
initAssignmentSender({
  supabase,
  sendMessage: async (phone, text, keyboard, opts) =>
    sendWhatsAppMessage(phone, text, keyboard, opts),
  config: {},
});
initRatingSender({
  supabase,
  sendMessage: async (phone, text, keyboard, opts) =>
    sendWhatsAppMessage(phone, text, keyboard, opts),
});
initWorkshopNudger({
  supabase,
sendWhatsAppTemplate: (phone, templateName, params, opts) => sendWhatsAppTemplate(phone, templateName, params, opts),
  config: {
    KURSO_URL,
    TEMPLATE_NAME: META_WORKSHOP_NUDGE_TEMPLATE,
  },
});

Object.entries({
  META_WHATSAPP_TOKEN: META_WHATSAPP_TOKEN,
  META_PHONE_NUMBER_ID: META_PHONE_NUMBER_ID,
  META_APP_SECRET: META_APP_SECRET,
  META_WEBHOOK_VERIFY_TOKEN: META_WEBHOOK_VERIFY_TOKEN,
  KURSO_URL: KURSO_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
}).forEach(([key, value]) =>
  console.log(`${key}: ${value ? "loaded" : "MISSING"}`),
);

// Maps the existing Telegram-style { inline_keyboard: [...] } shape (used
// unchanged by lessonSender/quizSender/assignmentSender) onto WhatsApp's
// interactive message types. WhatsApp can't mix a URL button with tappable
// reply buttons in one message like Telegram can — so any url buttons become
// plain links appended to the text, and callback_data buttons become real
// tappable buttons (Reply Buttons if ≤3, List Message if more).
//
// opts.forceList — always render as a List Message (the "dropdown" look)
// even when there are ≤3 callback buttons. Used for the Activities menu,
// which must always look like a dropdown, never like 3 reply buttons.
function buildWhatsAppPayload(toPhone, text, keyboard, opts) {
  const to = toPhone.replace(/\D/g, ""); // Meta wants digits only, no "+", no "whatsapp:" prefix
  const forceList = Boolean(opts?.forceList);
  const listButtonLabel = opts?.listButtonLabel || "Choose";
  const listSectionTitle = opts?.listSectionTitle || "Options";

  if (!keyboard || !keyboard.inline_keyboard?.length) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    };
  }

  const flat = keyboard.inline_keyboard.flat();
  const urlButtons = flat.filter((b) => b.url);
  const callbackButtons = flat.filter((b) => b.callback_data);

  let bodyText = text;
  urlButtons.forEach((b) => {
    bodyText += `\n\n${b.text}: ${b.url}`;
  });

  if (callbackButtons.length === 0) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: bodyText },
    };
  }

  if (!forceList && callbackButtons.length <= 3) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: callbackButtons.map((b) => ({
            type: "reply",
            reply: { id: b.callback_data, title: b.text.slice(0, 20) },
          })),
        },
      },
    };
  }

  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: listButtonLabel,
        sections: [
          {
            title: listSectionTitle,
            rows: callbackButtons.slice(0, 10).map((b, i) => ({
              id: b.callback_data || `opt_${i}`,
              title: b.text.slice(0, 24),
            })),
          },
        ],
      },
    },
  };
}

// Sends one message to Meta. Every send in this bot goes through here.
//   - If the creator connected their own WhatsApp number, it goes out from that number.
//   - Otherwise (or if that number has a problem) it goes out from Kurso's number, as before.
// Returns { resp, account }: account is the creator's number if it was used, or null for Kurso's.
async function postToMeta(payload, pickInfo) {
  const account = await pickAccount({ resolveOwner, ...pickInfo });
  const headers = (token) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

  if (account) {
    try {
      const resp = await axios.post(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${account.phoneNumberId}/messages`,
        payload,
        { headers: headers(account.token), timeout: 10000 },
      );
      return { resp, account };
    } catch (err) {
      if (isAccountLevelError(err)) {
        reportProblem(account, describeMetaError(err));
      } else if (!isTemplateNotReadyError(err)) {
        throw err; // a normal failure (bad recipient, etc.): do not resend from another number
      }
      console.warn("[postToMeta] creator's own number could not send, using Kurso's number |", describeMetaError(err));
    }
  }

  const resp = await axios.post(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`,
    payload,
    { headers: headers(META_WHATSAPP_TOKEN), timeout: 10000 },
  );
  return { resp, account: null };
}

async function sendWhatsAppMessage(toPhone, text, keyboard, opts) {
  const payload = buildWhatsAppPayload(toPhone, text, keyboard, opts);

  try {
    const { resp, account } = await postToMeta(payload, { phone: toPhone, kind: opts?.kind || "reply", ctx: opts?.ctx });
    console.log(
      "[sendWhatsAppMessage] ✅ sent to",
      toPhone,
      "| status:",
      resp.status,
      "| id:",
resp.data?.messages?.[0]?.id,
);
// Count it for billing. Never awaited and never allowed to fail the send.
recordSend({
  messageId: resp.data?.messages?.[0]?.id,
  toPhone,
  kind: opts?.kind || "reply",
  category: "service",
  ctx: opts?.ctx,
  account: account ? { creatorId: account.creatorId, phoneNumberId: account.phoneNumberId } : null,
});

} catch (err) { // Log full Meta error but NEVER rethrow — a failed reply must not crash
    // the handler or roll back enrollment operations
    const errData = err.response?.data;
    console.error("[sendWhatsAppMessage] ❌ FAILED to", toPhone);
    console.error(
      "[sendWhatsAppMessage] Meta error:",
      JSON.stringify(errData?.error || err.message),
    );
  }
}

// A real WhatsApp "CTA URL" message — ONE clean button showing only the
// label text (e.g. "▶ Open Lesson"), with the actual URL fully hidden
// behind it — no ugly raw link ever appears in the chat. This is the
// ONLY WhatsApp message type that can hide a link this way.
//
// Trade-off: this message type can only ever contain this single button —
// WhatsApp doesn't allow mixing a cta_url button with reply buttons
// (Next Lesson, Activities, etc.) in the same message the way Telegram
// does. So lesson delivery is now two messages: this one (just the link),
// then a normal follow-up sendWhatsAppMessage() with the Next/Previous/
// Activities-or-My Courses reply buttons.
async function sendCtaUrlButton(toPhone, bodyText, buttonText, targetUrl, opts) {

  const to = String(toPhone).replace(/\D/g, "");

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: bodyText },
      action: {
        name: "cta_url",
        parameters: { display_text: buttonText.slice(0, 20), url: targetUrl },
      },
    },
  };

  try {
        const { resp, account } = await postToMeta(payload, { phone: toPhone, kind: opts?.kind || "lesson_link", ctx: opts?.ctx });
    console.log(
      "[sendCtaUrlButton] ✅ sent to",
      to,
      "| status:",
      resp.status,
      "| id:",
  resp.data?.messages?.[0]?.id,
);
recordSend({
  messageId: resp.data?.messages?.[0]?.id,
  toPhone,
  kind: opts?.kind || "lesson_link",
  category: "service",
  ctx: opts?.ctx,
  account: account ? { creatorId: account.creatorId, phoneNumberId: account.phoneNumberId } : null,
});
return true;
} catch (err) { const errData = err.response?.data; console.error("[sendCtaUrlButton] ❌ FAILED to", to);
    console.error(
      "[sendCtaUrlButton] Meta error:",
      JSON.stringify(errData?.error || err.message),
    );
    return false;
  }
}

// Proactive messages (the student hasn't necessarily messaged the bot in
// the last 24 hours) MUST use a pre-approved Meta Message Template —
// freeform text gets rejected outside that window. Used for live-class
// reminders sent by the cron job, never for anything reply-driven.
//
// Template must be created + approved in Meta Business Manager first with
// exactly this many body variables, in this order:
//   {{1}} lesson title   {{2}} course name   {{3}} time label   {{4}} join URL
// Returns true/false so the caller (the /internal/send-reminder route) can
// report failures back to the cron job instead of silently swallowing them.
//
// bodyParams accepts two shapes:
//   - plain strings, e.g. ['Intro to Guitar', 'in 30 minutes']
//     → sent as POSITIONAL parameters (matches {{1}}, {{2}}... templates,
//       e.g. live_class_reminder, approved before Meta required named
//       parameters for newly-created templates)
//   - {name, value} objects, e.g. [{name: 'session_title', value: '...'}]
//     → sent as NAMED parameters (matches {{session_title}}... templates —
//       required for any template created under Meta's current named-
//       parameter rules; sending plain positional parameters against a
//       named-format template gets silently rejected by Meta at send
//       time even though the template itself was approved, so the shape
//       here has to match how each specific template was actually built)
async function sendWhatsAppTemplate(toPhone, templateName, bodyParams, opts) {
  
  const to = String(toPhone).replace(/\D/g, "");

  // Billing: promotional messages are paused for a creator with an overdue Kurso invoice.
  // Lessons, replies and reminders to people who already joined are never paused.
  const expectedCategory = categoryForTemplate(templateName);
  if (expectedCategory === "marketing") {
    const owner = await resolveOwner({
      phone: toPhone,
      kind: opts?.kind,
      ctx: opts?.ctx,
      courseName: opts?.courseName,
      workshopTitle: opts?.workshopTitle,
    });
        if (owner && !(await hasConnectedNumber(owner.creatorId)) && (await isCreatorOverdue(owner.creatorId))) {
      console.warn(
        "[sendWhatsAppTemplate] ⏸ promotional message skipped: creator has an overdue invoice | to:",
        to,
        "| template:",
        templateName,
      );
      return false;
    }
  }

  const parameters = bodyParams.map((p) =>
    p && typeof p === "object" && "name" in p
      ? { type: "text", text: String(p.value), parameter_name: p.name }
      : { type: "text", text: String(p) },
  );

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: META_TEMPLATE_LANG },
      components: [
        {
          type: "body",
          parameters,
        },
      ],
    },
  };

  try {
        const { resp, account } = await postToMeta(payload, {
      phone: toPhone,
      kind: opts?.kind || "template",
      ctx: opts?.ctx,
      courseName: opts?.courseName,
      workshopTitle: opts?.workshopTitle,
    });
    console.log(
      "[sendWhatsAppTemplate] ✅ sent to",
      to,
      "| template:",
      templateName,
      "| status:",
      resp.status,
      "| id:",
  resp.data?.messages?.[0]?.id,
);
recordSend({
  messageId: resp.data?.messages?.[0]?.id,
  toPhone,
  kind: opts?.kind || "template",
  templateName,
  category: expectedCategory,
  ctx: opts?.ctx,
  courseName: opts?.courseName,
  workshopTitle: opts?.workshopTitle,
  account: account ? { creatorId: account.creatorId, phoneNumberId: account.phoneNumberId } : null,
});
return true;

} catch (err) { const errData = err.response?.data; console.error( "[sendWhatsAppTemplate] ❌ FAILED to",
      to,
      "| template:",
      templateName,
    );
    console.error(
      "[sendWhatsAppTemplate] Meta error:",
      JSON.stringify(errData?.error || err.message),
    );
    return false;
  }
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

async function firstRow(query) {
  const { data, error } = await query.limit(1);
  if (error) {
    console.error("Supabase error:", error.message);
    return null;
  }
  return data?.[0] || null;
}

function courseUrl(course) {
  return `${KURSO_URL}/course/${slugify(course.host_name || "creator")}/${slugify(course.name || course.slug || "course")}/${course.id}`;
}

// A lesson has "activities" only when it carries something EXTRA beyond
// its own primary content — e.g. a video/pdf/live lesson that also has a
// quiz, notes, or assignment attached to it.
//
// A lesson whose content_type IS 'quiz' or 'assignment' stores its own
// body in these same columns (quiz_questions / assignment_prompt) — that
// is the lesson, not an attachment to it, so it must NOT trigger the
// Activities dropdown pointing back at itself. Those lesson types get
// delivered as a normal lesson (open the link, watch/take it), exactly
// like a video or pdf lesson — Activities is strictly for the extras
// hanging off a lesson, never for the lesson's own type.
function lessonHasActivities(lesson) {
  if (!lesson) return false;
  const hasNotes = Boolean(lesson.notes_url || lesson.summary_url);
  const hasQuiz =
    lesson.content_type !== "quiz" &&
    Array.isArray(lesson.quiz_questions) &&
    lesson.quiz_questions.length > 0;
  const hasAssignment =
    lesson.content_type !== "assignment" &&
    Boolean(lesson.assignment_prompt || lesson.assignment_file_url);
  return hasNotes || hasQuiz || hasAssignment;
}

// Shared button layout used everywhere a lesson menu is shown (sendLesson,
// sendSpecificLesson, markDone). WhatsApp allows max 3 reply buttons per
// message, so the 3rd slot is always EITHER Activities OR My Courses,
// never both — Activities takes priority whenever this lesson has any.
//   Row 1: ▶ Next Lesson   (only if a next published lesson exists)
//   Row 2: ⬅ Previous Lesson (only if order_num > 1)
//   Row 3: 🎯 Activities (if lesson has notes/quiz/assignment) else 📚 My Courses
async function buildLessonMenuKeyboard(supabase, enrollment, lesson) {
  const buttons = [];

  const { data: nextLessons } = await supabase
    .from("lessons")
    .select("order_num")
    .eq("course_id", enrollment.course_uuid)
    .eq("order_num", lesson.order_num + 1)
    .eq("is_published", true)
    .limit(1);

  if (nextLessons && nextLessons.length > 0) {
    buttons.push({
      text: "▶ Next Lesson",
      callback_data: `goto:${lesson.order_num + 1}`,
    });
  }

  if (lesson.order_num > 1) {
    buttons.push({
      text: "⬅ Previous Lesson",
      callback_data: `goto:${lesson.order_num - 1}`,
    });
  }

  if (lessonHasActivities(lesson)) {
    buttons.push({
      text: "🎯 Activities",
      callback_data: `activities:${lesson.order_num}`,
    });
    return { inline_keyboard: buttons.map((b) => [b]) };
  }

  // No activities on this lesson — 3rd slot becomes My Courses, a real
  // website page (not an in-chat summary) so it matches "route to the
  // my-courses page" rather than replying with text.
  const keyboard = { inline_keyboard: buttons.map((b) => [b]) };
  keyboard.inline_keyboard.push([
    { text: "📚 My Courses", url: signMyCoursesUrl(String(enrollment.phone)) },
  ]);
  return keyboard;
}

// Sends the Activities dropdown (always a List Message, never reply
// buttons, even when there's only one activity) for a given lesson.
async function sendActivitiesMenu(supabase, phone, enrollment, lessonOrderNum) {
  const lesson = await firstRow(
    supabase
      .from("lessons")
      .select(
        "id, title, order_num, content_type, notes_url, summary_url, quiz_questions, assignment_prompt, assignment_file_url, assignment_required",
      )
      .eq("course_id", enrollment.course_uuid)
      .eq("order_num", lessonOrderNum)
      .eq("is_published", true),
  );

  if (!lesson || !lessonHasActivities(lesson)) {
    await sendWhatsAppMessage(
      phone,
      `ℹ️ No extra activities for *Lesson ${lessonOrderNum}* yet.`,
    );
    return;
  }

  const rows = [];
  if (lesson.notes_url || lesson.summary_url) {
    rows.push({ text: "📝 Notes", callback_data: `notes:${lessonOrderNum}` });
  }
  if (
    Array.isArray(lesson.quiz_questions) &&
    lesson.quiz_questions.length > 0
  ) {
    rows.push({ text: "🧠 Quiz", callback_data: `quiz:${lessonOrderNum}` });
  }
  if (lesson.assignment_prompt || lesson.assignment_file_url) {
    rows.push({
      text: "📋 Assignment",
      callback_data: `assign:${lessonOrderNum}`,
    });
  }

  await sendWhatsAppMessage(
    phone,
    `🎯 Activities for Lesson ${lessonOrderNum}: ${lesson.title}\n\nChoose one:`,
    { inline_keyboard: rows.map((b) => [b]) },
    {
      forceList: true,
      listButtonLabel: "Choose",
      listSectionTitle: "Activities",
    },
  );
}

async function sendNotesForLesson(supabase, phone, enrollment, lessonOrderNum) {
  const lesson = await firstRow(
    supabase
      .from("lessons")
      .select("id, title, summary_url, notes_url")
      .eq("course_id", enrollment.course_uuid)
      .eq("order_num", lessonOrderNum)
      .eq("is_published", true),
  );

  if (!lesson || (!lesson.summary_url && !lesson.notes_url)) {
    await sendWhatsAppMessage(
      phone,
      `ℹ️ No notes for *Lesson ${lessonOrderNum}* yet.`,
    );
    return;
  }

  const lines = [`📝 Notes — Lesson ${lessonOrderNum}: ${lesson.title}`, ""];
  if (lesson.summary_url)
    lines.push(`• 📄 Summary: ${signResourceUrl(lesson.id, "summary", phone)}`);
  if (lesson.notes_url)
    lines.push(`• 📝 Notes: ${signResourceUrl(lesson.id, "notes", phone)}`);

  await sendWhatsAppMessage(phone, lines.join("\n"));
}

// Matches course-web/src/lib/signer.ts's signMyCoursesUrl/verifyMyCoursesUrl —
// same secret, same payload shape.
function signMyCoursesUrl(phone) {
  const exp = Date.now() + 2 * 60 * 60 * 1000;
  const payload = `mycourses.${phone}.${exp}`;
  const sig = crypto
    .createHmac("sha256", LESSON_LINK_SECRET)
    .update(payload)
    .digest("hex");
  const params = new URLSearchParams({
    identity: String(phone),
    exp: String(exp),
    sig,
  });
  return `${KURSO_URL}/wa/my-courses?${params.toString()}`;
}

function signResourceUrl(lessonId, type, phone) {
  const exp = Date.now() + 2 * 60 * 60 * 1000;
  const payload = `resource.${lessonId}.${type}.${phone}.${exp}`;
  const sig = crypto
    .createHmac("sha256", LESSON_LINK_SECRET)
    .update(payload)
    .digest("hex");
  const params = new URLSearchParams({
    type,
    identity: String(phone),
    exp: String(exp),
    sig,
  });
  return `${KURSO_URL}/resource/${lessonId}?${params.toString()}`;
}

async function getEnrollment(phone) {
  return firstRow(
    supabase
      .from("enrollments")
      .select("*, courses:course_uuid(*)")
      .eq("phone", normalizePhone(phone) || String(phone))
      .order("enrolled_at", { ascending: false }),
  );
}

async function handleStart(phone, token) {
  console.log(
    "[handleStart] called | phone:",
    phone,
    "| token:",
    token ? token.slice(0, 16) + "..." : "(none)",
  );

  if (!token) {
    await sendWhatsAppMessage(
      phone,
      "Welcome to Kurso! 👋\n\nOpen a course page and tap *Start on WhatsApp* to connect your course.",
    );
    return;
  }

  // 1. Find valid unused token
  console.log("[handleStart] step 1 — looking up token in whatsapp_tokens");
  const tokenRow = await firstRow(
    supabase
      .from("whatsapp_tokens")
      .select("*")
      .eq("token", token)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString()),
  );

  if (!tokenRow) {
    console.warn(
      "[handleStart] ❌ token not found or already used or expired:",
      token.slice(0, 16),
    );
    await sendWhatsAppMessage(
      phone,
      "⚠️ This WhatsApp link is invalid or has expired. Please open the course page and tap *Start on WhatsApp* again.",
    );
    return;
  }
  console.log(
    "[handleStart] ✅ token found | course_slug:",
    tokenRow.course_slug,
    "| creator_id:",
    tokenRow.creator_id,
    "| used:",
    tokenRow.used,
    "| expires_at:",
    tokenRow.expires_at,
  );

  const courseSlugOrId = tokenRow.course_slug;

  // 2. Verify course still exists
  let course;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      courseSlugOrId,
    )
  ) {
    const { data: courseRows } = await supabase
      .from("courses")
      .select("*")
      .eq("id", courseSlugOrId)
      .limit(1);
    course = courseRows?.[0];
  } else {
    const { data: courseRows } = await supabase
      .from("courses")
      .select("*")
      .eq("slug", courseSlugOrId)
      .limit(1);
    course = courseRows?.[0];
  }

  if (!course) {
    console.warn("[handleStart] ❌ course not found for:", courseSlugOrId);
    await sendWhatsAppMessage(phone, "⚠️ This course is no longer available.");
    await supabase
      .from("whatsapp_tokens")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("id", tokenRow.id);
    return;
  }
  console.log(
    "[handleStart] ✅ course found:",
    course.name,
    "| id:",
    course.id,
  );

  // 3. Upsert student record
  let student = null;

  if (tokenRow.student_id) {
    const { data } = await supabase
      .from("students")
      .select("id")
      .eq("id", tokenRow.student_id)
      .limit(1);
    student = data?.[0] || null;
  } else if (tokenRow.student_email) {
    const { data } = await supabase
      .from("students")
      .select("id")
      .eq("email", tokenRow.student_email)
      .limit(1);
    student = data?.[0] || null;
  } else if (tokenRow.student_phone) {
    const { data } = await supabase
      .from("students")
      .select("id")
      .eq("phone", tokenRow.student_phone)
      .limit(1);
    student = data?.[0] || null;
  }

  if (!student) {
    console.log(
      "[handleStart] step 3 — inserting new student | email:",
      tokenRow.student_email,
    );
    const { data: inserted, error: insertErr } = await supabase
      .from("students")
      .insert({
        email: tokenRow.student_email || null,
        name: tokenRow.student_name || null,
        phone: tokenRow.student_phone || null,
      })
      .select("id")
      .single();

    if (insertErr?.code === "23505") {
      // Race with the website (razorpay/verify or webhook) inserting a
      // student with this same phone/email moments earlier. Use that row
      // instead of failing the whole /start flow over it.
      console.warn(
        "[handleStart] student insert raced — re-fetching existing row | phone:",
        tokenRow.student_phone,
        "| email:",
        tokenRow.student_email,
      );
      let raced = null;
      if (tokenRow.student_phone) {
        const { data } = await supabase
          .from("students")
          .select("id")
          .eq("phone", tokenRow.student_phone)
          .limit(1);
        raced = data?.[0] || null;
      }
      if (!raced && tokenRow.student_email) {
        const { data } = await supabase
          .from("students")
          .select("id")
          .eq("email", tokenRow.student_email)
          .limit(1);
        raced = data?.[0] || null;
      }
      if (!raced) {
        await sendWhatsAppMessage(
          phone,
          "⚠️ Something went wrong linking your account. Please try the link again.",
        );
        return;
      }
      student = raced;
    } else if (insertErr) {
      console.error(
        "[handleStart] ❌ student insert error:",
        insertErr.message,
        "| code:",
        insertErr.code,
      );
      await sendWhatsAppMessage(
        phone,
        "⚠️ Something went wrong linking your account. Please try the link again.",
      );
      return;
    } else {
      student = inserted;
    }
  }

  const isPaid = Boolean(tokenRow.payment_id);
  const phoneOrEmail = normalizePhone(phone) || String(phone);
  console.log(
    "[handleStart] step 4 — student id:",
    student?.id,
    "| isPaid:",
    isPaid,
    "| phoneOrEmail:",
    phoneOrEmail,
  );

  // 4. Find existing enrollment by every identifier before inserting
  let existingEnrollment = null;

  if (student?.id) {
    const { data } = await supabase
      .from("enrollments")
      .select(
        "id, student_id, payment_id, payment_status, delivery_method, completed_lessons, current_lesson, quiz_results",
      )
      .eq("course_uuid", course.id)
      .eq("student_id", student.id)
      .limit(1);
    existingEnrollment = data?.[0] || null;
  }

  if (!existingEnrollment && phoneOrEmail) {
    const { data } = await supabase
      .from("enrollments")
      .select(
        "id, student_id, payment_id, payment_status, delivery_method, completed_lessons, current_lesson, quiz_results",
      )
      .eq("course_uuid", course.id)
      .eq("phone", phoneOrEmail)
      .limit(1);
    existingEnrollment = data?.[0] || null;
  }

  // IMPORTANT:
  // Existing students use enrollment.delivery_method.
  // course.delivery is only the default for new enrollments.
  const effectiveDeliveryMethod =
    existingEnrollment?.delivery_method || course.delivery || "both";

  if (
    isPaid &&
    effectiveDeliveryMethod !== "whatsapp" &&
    effectiveDeliveryMethod !== "both"
  ) {
    console.warn(
      "[handleStart] WhatsApp blocked by enrollment snapshot:",
      effectiveDeliveryMethod,
    );

    await sendWhatsAppMessage(
      phone,
      "⚠️ This course's lessons are not delivered via WhatsApp. Please use the delivery channel shown on your course page (Telegram or the web) to continue.",
    );

    await supabase
      .from("whatsapp_tokens")
      .update({
        used: true,
        used_at: new Date().toISOString(),
      })
      .eq("id", tokenRow.id);

    return;
  }

  const now = new Date().toISOString();

  const safeTokenPaymentId =
    tokenRow.payment_id === "TEST"
      ? `TEST:${course.id}:${tokenRow.id}`
      : tokenRow.payment_id || null;

  // 5. Update or create enrollment — never downgrade payment_status from paid to free
  let enrollmentId = null;
  let enrollError = null;

  if (existingEnrollment) {
    const newPaymentStatus =
      existingEnrollment.payment_status === "paid"
        ? "paid"
        : isPaid
          ? "paid"
          : "free";

    const { error } = await supabase
      .from("enrollments")
      .update({
        student_id: student?.id || existingEnrollment.student_id || null,
        phone: phoneOrEmail,
        payment_status: newPaymentStatus,
        payment_id: existingEnrollment.payment_id || safeTokenPaymentId,
        delivery_method:
          existingEnrollment.delivery_method || course.delivery || "both",
        last_accessed: now,
      })
      .eq("id", existingEnrollment.id);

    enrollError = error;
    enrollmentId = existingEnrollment.id;
  } else {
    const { data: inserted, error } = await supabase
      .from("enrollments")
      .insert({
        phone: phoneOrEmail,
        course_uuid: course.id,
        creator_id: tokenRow.creator_id,
        student_id: student?.id || null,
        current_lesson: 1,
        payment_id: safeTokenPaymentId,
        payment_status: isPaid ? "paid" : "free",
        completed_lessons: [],
        quiz_results: [],
        amount_paid: 0,
        last_accessed: now,
        // Match the fields other enrollment-creation paths (web checkout,
        // creator test-enroll) already set, so an enrollment that happens
        // to originate from WhatsApp (rather than being found and updated
        // here) isn't left missing data those paths rely on.
        delivery_method: course.delivery || "both",
        certificate_student_name: tokenRow.student_name || null,
      })
      .select("id")
      .single();

    enrollError = error;
    enrollmentId = inserted?.id || null;
  }

  // 6. Only mark token used AFTER enrollment is confirmed
  if (enrollError || !enrollmentId) {
    console.error(
      "[handleStart] ❌ enrollment upsert FAILED | error:",
      enrollError?.message,
      "| code:",
      enrollError?.code,
      "| details:",
      enrollError?.details,
    );
    console.error(
      "[handleStart] ❌ was this an existing enrollment update?",
      Boolean(existingEnrollment),
      "| enrollmentId:",
      enrollmentId,
    );
    await sendWhatsAppMessage(
      phone,
      "⚠️ Something went wrong saving your enrollment. Please tap the link again — your access token is still valid.",
    );
    return;
  }
  console.log("[handleStart] ✅ enrollment upserted | id:", enrollmentId);

  await supabase
    .from("whatsapp_tokens")
    .update({ used: true, used_at: now, student_id: student?.id })
    .eq("id", tokenRow.id);

  console.log("[handleStart] ✅ all done — sending success message to", phone);
  await sendWhatsAppMessage(
    phone,
    "✅ You're connected! Tap below to start learning.",
    {
      inline_keyboard: [
        [{ text: "▶ Start Lesson 1", callback_data: "lesson" }],
        [{ text: "📚 My Courses", url: signMyCoursesUrl(String(phone)) }],
      ],
    },
  );
  console.log("[handleStart] ✅ success message dispatched");
}

async function markDone(phone, lessonNumber) {
  const enrollment = await getEnrollment(phone);
  if (!enrollment || !enrollment.courses) {
    await sendWhatsAppMessage(
      phone,
      "ℹ️ No course connected yet. Open a course page and tap *Start on WhatsApp* to begin.",
    );
    return;
  }

  // Call the web API so both platforms write progress the same way
  let certificateUrl = null;
  try {
    const res = await fetch(`${KURSO_URL}/api/lesson/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: String(phone),
        lessonNum: lessonNumber,
        courseId: enrollment.course_uuid,
        source: "whatsapp",
      }),
    });

    if (res.ok) {
      const result = await res.json().catch(() => ({}));
      if (result.certificateIssued && result.certificateUrl) {
        certificateUrl = result.certificateUrl;
      }
    } else {
      const err = await res.json().catch(() => ({}));
      console.error("[markDone] API error:", err);
    }
  } catch (err) {
    console.error("[markDone] fetch error:", err.message);
  }

  // Fetch the lesson for its order_num + resource/quiz/assignment flags
  // (needed by buildLessonMenuKeyboard to decide Activities vs My Courses)
  const lesson = await firstRow(
    supabase
      .from("lessons")
      .select(
        "id, order_num, content_type, summary_url, notes_url, quiz_questions, assignment_prompt, assignment_file_url, assignment_required",
      )
      .eq("course_id", enrollment.course_uuid)
      .eq("order_num", lessonNumber)
      .eq("is_published", true),
  );

  let assignmentBlocksNext = false;
  if (lesson?.assignment_required && lesson?.assignment_prompt) {
    const { data: existingAssignment } = await supabase
      .from("assignments")
      .select("id")
      .eq("enrollment_id", enrollment.id)
      .eq("lesson_id", lesson.id)
      .maybeSingle();
    assignmentBlocksNext = !existingAssignment;
  }

    // Course finished — replace the usual lesson menu with a certificate button
  if (certificateUrl) {
    await sendCtaUrlButton(
      phone,
      `🎉 Course complete! Lesson ${lessonNumber} marked complete, and your certificate is ready.`,
      "🎓 View Certificate",
      certificateUrl,
    );
    if (lessonNumber > 1) {
      await sendWhatsAppMessage(phone, "Want to revisit anything?", {
        inline_keyboard: [[{ text: "⬅ Previous Lesson", callback_data: `goto:${lessonNumber - 1}` }]],
      });
    }
    await maybePromptForRating(phone, enrollment);
    return;
  }

  const message = `✅ Lesson ${lessonNumber} marked complete!`;

  if (lesson) {
    const keyboard = await buildLessonMenuKeyboard(
      supabase,
      enrollment,
      lesson,
    );
    if (assignmentBlocksNext) {
      // Required assignment not yet submitted — drop the Next Lesson row so
      // the student isn't misled into thinking they can skip ahead; the
      // Submit Assignment prompt below is the actual next step.
      keyboard.inline_keyboard = keyboard.inline_keyboard.filter(
        (row) => row[0]?.callback_data !== `goto:${lessonNumber + 1}`,
      );
    }
    await sendWhatsAppMessage(phone, message, keyboard);
  } else {
    await sendWhatsAppMessage(phone, message);
  }

  await sendAssignmentPrompt(phone, lessonNumber);
}

async function sendProgress(phone) {
  const enrollment = await getEnrollment(phone);
  if (!enrollment || !enrollment.courses) {
    await sendWhatsAppMessage(
      phone,
      "ℹ️ No course connected yet. Open a course page and tap *Start on WhatsApp* to begin.",
    );
    return;
  }

  const completed = (enrollment.completed_lessons || []).length;

  // `total_lessons` on the course row is a stale column that's no longer
  // kept in sync (see api/lesson/complete's own comment on this) — compute
  // the real total the same way certificate eligibility does: the
  // creator's marked "last lesson" order_num if set, otherwise the count
  // of published lessons.
  const { data: lastLessonRow } = await supabase
    .from("lessons")
    .select("order_num")
    .eq("course_id", enrollment.course_uuid)
    .eq("is_last_lesson", true)
    .maybeSingle();

  let total = lastLessonRow?.order_num;
  if (!total) {
    const { count: publishedCount } = await supabase
      .from("lessons")
      .select("id", { count: "exact", head: true })
      .eq("course_id", enrollment.course_uuid)
      .eq("is_published", true);
    total = publishedCount || 0;
  }

  const percent =
    total > 0 ? Math.min(Math.round((completed / total) * 100), 100) : 0;

  // Already finished? Show the certificate instead of "Continue".
  const { data: existingCert } = await supabase
    .from("certificates")
    .select("pdf_url")
    .eq("enrollment_id", enrollment.id)
    .maybeSingle();

  if (existingCert?.pdf_url) {
    await sendCtaUrlButton(
      phone,
      `📊 Progress: ${completed}/${total} lessons complete (100%)\n\n🎉 Course complete! Your certificate is ready.`,
      "🎓 View Certificate",
      existingCert.pdf_url,
    );
    if (total > 1) {
      await sendWhatsAppMessage(phone, "Want to revisit anything?", {
        inline_keyboard: [[{ text: "⬅ Previous Lesson", callback_data: `goto:${total - 1}` }]],
      });
    }
    return;
  }

  await sendWhatsAppMessage(
    phone,
    `📊 *Progress:* ${completed}/${total} lessons complete (${percent}%)\nCurrent lesson: *${enrollment.current_lesson || 1}*`,
    { inline_keyboard: [[{ text: "▶ Continue", callback_data: "lesson" }]] },
  );
}

const { getAvailabilityMessage, getNoteMessage } = require("./lessonMessages");

async function sendSpecificLesson(phone, lessonOrderNum) {
  const enrollment = await getEnrollment(phone);
  if (!enrollment) {
    await sendWhatsAppMessage(
      phone,
      "ℹ️ No course connected yet. Open a course page and tap *Start on WhatsApp* to begin.",
    );
    return;
  }

  const currentLesson = enrollment.current_lesson || 1;
  if (lessonOrderNum > currentLesson) {
    const assignmentBlock = await getRequiredAssignmentBlock(
      enrollment,
      lessonOrderNum,
    );
    if (assignmentBlock) {
      await sendWhatsAppMessage(
        phone,
        `🔒 Assignment required\n\nComplete the assignment for Lesson ${assignmentBlock.prevLessonNum} before continuing.`,
        {
          inline_keyboard: [
            [
              {
                text: "📝 Submit HW",
                callback_data: `assign:${assignmentBlock.prevLessonNum}`,
              },
            ],
          ],
        },
      );
      return;
    }
  }

  const { data: lessons } = await supabase
    .from("lessons")
    .select(
      "id, title, order_num, content_type, notes_url, summary_url, quiz_questions, assignment_prompt, assignment_file_url, assignment_required, is_free",
    )
    .eq("course_id", enrollment.course_uuid)
    .eq("order_num", lessonOrderNum)
    .eq("is_published", true)
    .limit(1);

  const lesson = lessons?.[0];
  if (!lesson) {
    const customAvailabilityMessage = await getAvailabilityMessage(
      supabase,
      enrollment.course_uuid,
      lessonOrderNum,
    );
    const lockedKeyboard =
      lessonOrderNum > 1
        ? {
            inline_keyboard: [
              [
                {
                  text: "⬅ Previous Lesson",
                  callback_data: `goto:${lessonOrderNum - 1}`,
                },
              ],
            ],
          }
        : undefined;
    await sendWhatsAppMessage(
      phone,
      customAvailabilityMessage ||
        `⚠️ Lesson ${lessonOrderNum} is not available yet.`,
      lockedKeyboard,
    );
    return;
  }

  // Check access
  const isPaid = enrollment.payment_status === "paid";
  if (!isPaid) {
    const isFree =
      enrollment.courses?.is_free_course === true || lesson.is_free === true;
    if (!isFree) {
      const course = enrollment.courses;
      const courseUrlStr = `${KURSO_URL}/about-course/${slugify(course?.host_name || "creator")}/${slugify(course?.name || "course")}/${enrollment.course_uuid}`;
      await sendWhatsAppMessage(
        phone,
        `🔒 This lesson is locked.\n\nYou've completed your free preview — pay to unlock the full course and keep going.`,
        { inline_keyboard: [[{ text: "Pay Now", url: courseUrlStr }]] },
      );
      return;
    }
  }

  const noteMessage = await getNoteMessage(supabase, lesson.id);
  if (noteMessage) {
    await sendWhatsAppMessage(phone, noteMessage);
  }

  const lessonUrl = await createWebBootstrapUrl({
    course: enrollment.courses,
    enrollment,
    channel: "whatsapp",
  });
  const fp = encodeFingerprint(String(phone));

  const isWatchAgain = lesson.order_num < (enrollment.current_lesson || 1);
  const headerText = isWatchAgain
    ? `🔄 Watching Again: Lesson ${lesson.order_num}: ${escMd(lesson.title)}`
    : `📖 Lesson ${lesson.order_num}: ${escMd(lesson.title)}`;

  const linkBodyText = `${headerText}\n\nAccess expires in 2 hours.\n\n🔒 This link is personal. Do not share it.\n${fp}`;

  await sendCtaUrlButton(phone, linkBodyText, "▶ Open Lesson", lessonUrl);

  const keyboard = await buildLessonMenuKeyboard(supabase, enrollment, lesson);
  await sendWhatsAppMessage(phone, `What's next?`, keyboard);

  await supabase
    .from("enrollments")
    .update({ last_accessed: new Date().toISOString() })
    .eq("id", enrollment.id)
    .then(() => {})
    .catch(() => {});
}

async function handleIncomingMessage(metaMessage) {
  try {
    const phone = metaMessage.from; // Meta sends digits only, e.g. "919306385029"
    let text = "";
    if (metaMessage.type === "text") {
      text = (metaMessage.text?.body || "").trim();
    } else if (metaMessage.type === "interactive") {
      const interactive = metaMessage.interactive;
      if (interactive?.type === "button_reply") {
        text = interactive.button_reply.id;
      } else if (interactive?.type === "list_reply") {
        text = interactive.list_reply.id;
      }
    }

    console.log(
      "[handleIncomingMessage] received message from:",
      phone,
      "text:",
      text,
    );

    const hasPendingRatingFlow = await hasPendingRating(phone);
    if (hasPendingRatingFlow) {
      if (text && !text.startsWith("/")) {
        return handleRatingReply(phone, text);
      }
    }

    const hasPending = await hasPendingSubmission(phone);
    if (hasPending) {
      if (text && !text.startsWith("/")) {
        return submitAssignmentText(phone, text);
      }
    }
    if (text.startsWith("/start")) {
      const parts = text.split(" ");
      const token = parts[1] || "";
      if (token.startsWith("done_")) {
        const lessonNumber = Number(token.replace("done_", ""));
        return markDone(phone, lessonNumber);
      }
      return handleStart(phone, token);
    }
    if (
      text === "/lesson" ||
      text.toLowerCase() === "lesson" ||
      text.toLowerCase() === "next lesson"
    ) {
      return sendLesson(phone);
    }
    if (text === "/progress" || text.toLowerCase() === "progress") {
      return sendProgress(phone);
    }
        if (text === "/cancel" || text.toLowerCase() === "cancel") {
      if (hasPendingRatingFlow) {
        await cancelPendingRating(phone);
      } else if (hasPending) {
        await cancelPending(phone);
      } else {
        await sendWhatsAppMessage(phone, "ℹ️ Nothing to cancel.");
      }
      return;
    }
    if (text.startsWith("done:")) {
      const lessonNumber = Number(text.replace("done:", ""));
      return markDone(phone, lessonNumber);
    }
    if (text.startsWith("quiz:")) {
      const lessonNumber = Number(text.replace("quiz:", ""));
      return sendQuiz(phone, lessonNumber);
    }
    if (text.startsWith("assign:")) {
      const lessonNumber = Number(text.replace("assign:", ""));
      return beginAssignmentSubmit(phone, lessonNumber);
    }
    if (text.startsWith("goto:")) {
      const targetNum = Number(text.replace("goto:", ""));
      return sendSpecificLesson(phone, targetNum);
    }
    if (text.startsWith("activities:")) {
      const lessonNumber = Number(text.replace("activities:", ""));
      const enrollment = await getEnrollment(phone);
      if (!enrollment) {
        await sendWhatsAppMessage(
          phone,
          "ℹ️ No course connected yet. Open a course page and tap *Start on WhatsApp* to begin.",
        );
        return;
      }
      return sendActivitiesMenu(supabase, phone, enrollment, lessonNumber);
    }
    if (text.startsWith("notes:")) {
      const lessonNumber = Number(text.replace("notes:", ""));
      const enrollment = await getEnrollment(phone);
      if (!enrollment) {
        await sendWhatsAppMessage(
          phone,
          "ℹ️ No course connected yet. Open a course page and tap *Start on WhatsApp* to begin.",
        );
        return;
      }
      return sendNotesForLesson(supabase, phone, enrollment, lessonNumber);
    }
    if (text === "mycourses" || text.toLowerCase() === "my courses") {
      const enrollment = await getEnrollment(phone);
      if (!enrollment) {
        await sendWhatsAppMessage(
          phone,
          "ℹ️ No course connected yet. Open a course page and tap *Start on WhatsApp* to begin.",
        );
        return;
      }
      await sendWhatsAppMessage(
        phone,
        "📚 *My Courses*\n\nTap below to see all your enrolled courses and progress.",
        {
          inline_keyboard: [
            [
              {
                text: "📚 Open My Courses",
                url: signMyCoursesUrl(String(enrollment.phone)),
              },
            ],
          ],
        },
      );
      return;
    }

    // Default response — tappable buttons instead of typed commands.
    // WhatsApp reply-button messages cap at 3 buttons, so /cancel (a rarely
    // needed escape hatch) isn't listed here; it still works if typed.
    return sendWhatsAppMessage(
      phone,
      "👋 *Welcome to Kurso!*\n\nTap an option below to continue.",
      {
        inline_keyboard: [
          [{ text: "📖 Lesson", callback_data: "lesson" }],
          [{ text: "📊 Progress", callback_data: "progress" }],
          [{ text: "📚 My Courses", callback_data: "mycourses" }],
        ],
      },
    );
  } catch (err) {
    console.error(
      "[handleIncomingMessage] unhandled error:",
      err.message,
      err.stack,
    );
  }
}

// Validate Meta's webhook signature — HMAC-SHA256 over the raw request
// body, sent in the X-Hub-Signature-256 header. Needs the raw bytes
// (captured via express.json's verify hook above), not the re-serialized
// parsed body, since re-serializing can change key order/whitespace and
// silently break the signature check.
function validateMetaSignature(req, appSecret) {
  const signatureHeader = req.get("X-Hub-Signature-256");
  if (!signatureHeader || !req.rawBody) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader),
    );
  } catch {
    return false; // length mismatch → definitely invalid, not a crash
  }
}

// One-time (and periodic) verification handshake Meta sends as a GET
// request when you configure the webhook URL in Meta App Dashboard.
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === META_WEBHOOK_VERIFY_TOKEN) {
    console.log("[webhook/whatsapp] ✅ verify handshake OK");
    return res.status(200).send(challenge);
  }
  console.error("[webhook/whatsapp] ❌ verify handshake failed");
  return res.sendStatus(403);
});

// Webhook endpoint for Meta — must match what's configured in
// Meta App Dashboard > WhatsApp > Configuration > Webhook URL.
app.post("/webhook/whatsapp", async (req, res) => {
  console.log(
    "[webhook/whatsapp] POST received | rawBody present:",
    Boolean(req.rawBody),
    "| rawBody length:",
    req.rawBody?.length || 0,
  );
  try {
    if (META_APP_SECRET) {
      const isValid = validateMetaSignature(req, META_APP_SECRET);
      console.log(
        "[webhook/whatsapp] signature check:",
        isValid ? "✅ valid" : "❌ INVALID",
      );
      if (!isValid) {
        console.error(
          "[webhook/whatsapp] ❌ Invalid Meta signature — X-Hub-Signature-256 header present:",
          Boolean(req.get("X-Hub-Signature-256")),
        );
        return res.status(403).send("Forbidden");
      }
    } else {
      console.warn(
        "[webhook/whatsapp] ⚠️ META_APP_SECRET not set — skipping signature check entirely",
      );
    }

    res.sendStatus(200); // ack immediately — Meta retries hard on non-200/timeout

    console.log(
      "[webhook/whatsapp] payload:",
      JSON.stringify(req.body).slice(0, 2000),
    );

// Delivery reports: Meta says here whether each message was delivered and what it charged.
// Handled without waiting, and never allowed to affect normal message handling.
handleStatusPayload(req.body).catch((e) =>
  console.error("[webhook/whatsapp] status handling failed:", e.message),
);

const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
if (!message) {
      console.log(
        "[webhook/whatsapp] no message in payload — likely a status callback (sent/delivered/read), or a Meta test payload with a different shape",
      );
      return;
    }
    console.log(
      "[webhook/whatsapp] message extracted, id:",
      message.id,
      "| type:",
      message.type,
      "| from:",
      message.from,
    );

    // Idempotency check — WAMID plays the same role Twilio's MessageSid did
    const messageId = message.id;
    if (messageId) {
      const { data: existing } = await supabase
        .from("webhook_processed_messages")
        .select("message_sid")
        .eq("message_sid", messageId)
        .maybeSingle();

      if (existing) {
        console.log(
          "[webhook/whatsapp] ℹ️ Already processed message ID:",
          messageId,
        );
        return;
      }
      await supabase
        .from("webhook_processed_messages")
        .insert({ message_sid: messageId });
    }

    // Which of our numbers did the student write to? If it is a creator's own number, every reply
    // in this conversation goes out from that same number.
    const incomingNumberId = req.body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const account =
      incomingNumberId && String(incomingNumberId) !== String(META_PHONE_NUMBER_ID)
        ? await accountForPhoneNumberId(String(incomingNumberId))
        : null;
    await runWithAccount(account, () => handleIncomingMessage(message));
  } catch (err) {
    console.error(
      "[webhook/whatsapp] ❌ unhandled error:",
      err.message,
      err.stack,
    );
  }
});

// Called by course-web's /api/cron/live-session-reminders (the daily-on-
// Hobby-tier 24h advance reminder) — not a WhatsApp webhook, just an
// internal service-to-service call, so it's protected by a shared bearer
// secret instead of the Meta signature check. The 30-minute reminder does
// NOT come through here — see pollLiveClassReminders below, which runs
// entirely inside this process on its own timer.
app.post("/internal/send-reminder", async (req, res) => {
  const auth = req.get("Authorization") || "";
  if (!INTERNAL_BOT_SECRET || auth !== `Bearer ${INTERNAL_BOT_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { phone, lessonTitle, courseName, timeLabel, joinUrl } = req.body || {};
  if (!phone || !lessonTitle || !courseName || !timeLabel || !joinUrl) {
    return res.status(400).json({ error: "Missing required fields" });
  }

const ok = await sendWhatsAppTemplate( phone, META_LIVE_REMINDER_TEMPLATE, [lessonTitle, courseName, timeLabel, joinUrl], { kind: "live_reminder_24h", courseName, ctx: ctxFromBody(req.body) }, ); if (!ok) { return res.status(502).json({ error: "Meta rejected the template send — check template name/approval status", }); } return res.status(200).json({ ok: true }); });

// Called by course-web's /api/cron/live-session-recording-notify (once
// daily) — sends exactly one message per student per session: the
// recording link if the creator uploaded one, or a "not available yet"
// notice otherwise. Same internal-secret auth pattern as /internal/send-reminder above.
app.post("/internal/send-live-recording", async (req, res) => {
  const auth = req.get("Authorization") || "";
  if (!INTERNAL_BOT_SECRET || auth !== `Bearer ${INTERNAL_BOT_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { identity, sessionTitle, courseName, hasRecording, recordingLink } =
    req.body || {};
  if (
    !identity ||
    !sessionTitle ||
    !courseName ||
    typeof hasRecording !== "boolean"
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (hasRecording && !recordingLink) {
    return res
      .status(400)
      .json({ error: "recordingLink required when hasRecording is true" });
  }

  const usageOpts = { kind: "live_recording", courseName, ctx: ctxFromBody(req.body) };
  const ok = hasRecording
    ? await sendWhatsAppTemplate(
        identity,
        META_RECORDING_READY_TEMPLATE,
        [
          { name: "session_title", value: sessionTitle },
          { name: "course_name", value: courseName },
          { name: "recording_link", value: recordingLink },
        ],
        usageOpts,
      )
    : await sendWhatsAppTemplate(
        identity,
        META_RECORDING_UNAVAILABLE_TEMPLATE,
        [
          { name: "session_title", value: sessionTitle },
          { name: "course_name", value: courseName },
        ],
        usageOpts,
      );

  if (!ok) {
    return res.status(502).json({
      error:
        "Meta rejected the template send — check template name/approval status",
    });
  }
  return res.status(200).json({ ok: true });
});

// Called by course-web's /api/workshops/register and
// /api/workshops/registrations/confirm — fires immediately on a
// confirmed registration (free instant, or after the creator taps
// "Mark Paid" on a manual UPI registration). Same internal-secret auth
// pattern as /internal/send-reminder above.
app.post("/internal/send-workshop-confirmation", async (req, res) => {
  const auth = req.get("Authorization") || "";
  if (!INTERNAL_BOT_SECRET || auth !== `Bearer ${INTERNAL_BOT_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { phone, workshopTitle, dateTimeLabel, zoomLink } = req.body || {};
  if (!phone || !workshopTitle || !dateTimeLabel || !zoomLink) {
    return res.status(400).json({ error: "Missing required fields" });
  }

const ok = await sendWhatsAppTemplate( phone, META_WORKSHOP_CONFIRMATION_TEMPLATE, [ { name: "workshop_title", value: workshopTitle }, { name: "datetime_label", value: dateTimeLabel }, { name: "zoom_link", value: zoomLink }, ], { kind: "workshop_confirmation", workshopTitle, ctx: ctxFromBody(req.body) }, );
  if (!ok) {
    return res.status(502).json({
      error: "Meta rejected the template send — check template name/approval status",
    });
  }
  return res.status(200).json({ ok: true });
});

// Called by course-web's /api/cron/workshop-reminders (daily-on-Hobby-tier
// 24h advance reminder). The 1h-before reminder does NOT come through
// here — see pollWorkshopReminders below, running on its own timer,
// mirroring pollLiveClassReminders.
app.post("/internal/send-workshop-reminder", async (req, res) => {
  const auth = req.get("Authorization") || "";
  if (!INTERNAL_BOT_SECRET || auth !== `Bearer ${INTERNAL_BOT_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { phone, workshopTitle, dateTimeLabel, zoomLink } = req.body || {};
  if (!phone || !workshopTitle || !dateTimeLabel || !zoomLink) {
    return res.status(400).json({ error: "Missing required fields" });
  }

const ok = await sendWhatsAppTemplate( phone, META_WORKSHOP_REMINDER_TEMPLATE, [ { name: "workshop_title", value: workshopTitle }, { name: "datetime_label", value: dateTimeLabel }, { name: "zoom_link", value: zoomLink }, ], { kind: "workshop_reminder_24h", workshopTitle, ctx: ctxFromBody(req.body) }, );
  if (!ok) {
    return res.status(502).json({
      error: "Meta rejected the template send — check template name/approval status",
    });
  }
  return res.status(200).json({ ok: true });
});

// Called by course-web when a creator connects their own WhatsApp number (or taps "Set up my
// messages"). Copies Kurso's approved templates into the creator's WhatsApp account.
app.post("/internal/setup-own-number", async (req, res) => {
  const auth = req.get("Authorization") || "";
  if (!INTERNAL_BOT_SECRET || auth !== `Bearer ${INTERNAL_BOT_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { creatorId } = req.body || {};
  if (!creatorId || typeof creatorId !== "string") {
    return res.status(400).json({ error: "creatorId is required" });
  }
  res.status(202).json({ ok: true });
  setupTemplates(creatorId, [
    META_LIVE_REMINDER_TEMPLATE,
    META_RECORDING_READY_TEMPLATE,
    META_RECORDING_UNAVAILABLE_TEMPLATE,
    META_WORKSHOP_CONFIRMATION_TEMPLATE,
    META_WORKSHOP_REMINDER_TEMPLATE,
    META_WORKSHOP_NUDGE_TEMPLATE,
  ]).catch((e) => console.error("[setup-own-number] failed:", e.message));
});

app.get("/", (req, res) => {
  res.json({
    status: "Kurso WhatsApp bot running",
    time: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════════
// 30-MINUTE LIVE CLASS REMINDER — self-scheduled, runs on the bot itself
// ═══════════════════════════════════════════════════════════════════
// This does NOT depend on course-web's Vercel cron at all — Railway runs
// this process continuously, so it can poll on its own timer with no
// "once a day" ceiling the way Vercel Hobby's cron has. The 24-hour
// advance reminder still comes from course-web's daily cron (it only
// needs to run once a day anyway), but this one needs real 5-minute
// precision to hand the join link over right before class starts, so it
// lives here instead.
async function pollLiveClassReminders() {
  try {
    const windowStart = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() + 35 * 60 * 1000).toISOString();

    const { data: dueLessons, error: lessonsError } = await supabase
      .from("lessons")
      .select(
    "id, title, course_id, order_num, live_join_url, live_scheduled_at, courses:course_id(name, creator_id)",
      )
      .eq("content_type", "live")
      .eq("is_published", true)
      .is("reminder_30m_sent_at", null)
      .not("live_join_url", "is", null)
      .gte("live_scheduled_at", windowStart)
      .lte("live_scheduled_at", windowEnd);

    if (lessonsError) {
      console.error(
        "[pollLiveClassReminders] lesson query failed:",
        lessonsError.message,
      );
      return;
    }
    if (!dueLessons || dueLessons.length === 0) return;

    for (const lesson of dueLessons) {
      const { data: students, error: studentsError } = await supabase
        .from("enrollments")
        .select("phone, students(reminder_channel)")
        .eq("course_uuid", lesson.course_id)
        .eq("current_lesson", lesson.order_num)
        .eq("payment_status", "paid");

      if (studentsError) {
        console.error(
          "[pollLiveClassReminders] enrollment query failed for lesson",
          lesson.id,
          studentsError.message,
        );
        continue;
      }

      const courseName = lesson.courses?.name || "your course";

      for (const s of students || []) {
        const channel = s.students?.reminder_channel;
        if (channel !== "whatsapp" || !s.phone) continue;

    const ok = await sendWhatsAppTemplate(
      s.phone,
      META_LIVE_REMINDER_TEMPLATE,
      [lesson.title, courseName, "in 30 minutes", lesson.live_join_url],
      {
        kind: "live_reminder_30m",
        courseName,
        ctx: lesson.courses?.creator_id
          ? { creatorId: lesson.courses.creator_id, courseId: lesson.course_id }
          : undefined,
      },
    );
        console.log(
          `[pollLiveClassReminders] 30m reminder to ${s.phone} for lesson ${lesson.id}: ${ok ? "sent" : "FAILED"}`,
        );
      }

      await supabase
        .from("lessons")
        .update({ reminder_30m_sent_at: new Date().toISOString() })
        .eq("id", lesson.id);
    }
  } catch (err) {
    console.error("[pollLiveClassReminders] unhandled error:", err.message);
  }
}

setInterval(pollLiveClassReminders, 5 * 60 * 1000);
pollLiveClassReminders(); // also run once at startup instead of waiting 5 min for the first check

// Mirrors pollLiveClassReminders exactly, scaled to a ±5-minute window
// around the 1-hour mark instead of the 30-minute mark.
async function pollWorkshopReminders() {
  try {
    const windowStart = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() + 65 * 60 * 1000).toISOString();

    const { data: dueWorkshops, error: workshopsError } = await supabase
      .from("workshops")
  .select("id, creator_id, title, date_time, zoom_link")
  .eq("status", "published")
  .is("reminder_1h_sent_at", null)
      .gte("date_time", windowStart)
      .lte("date_time", windowEnd);

    if (workshopsError) {
      console.error(
        "[pollWorkshopReminders] workshop query failed:",
        workshopsError.message,
      );
      return;
    }
    if (!dueWorkshops || dueWorkshops.length === 0) return;

for (const workshop of dueWorkshops) {
  // The creator can switch WhatsApp off for a workshop. Email and Telegram still reach people.
  if (!(await workshopWhatsappEnabled(workshop.id))) {
    console.log("[pollWorkshopReminders] WhatsApp is switched off for workshop", workshop.id, "- skipping");
    await supabase
      .from("workshops")
      .update({ reminder_1h_sent_at: new Date().toISOString() })
      .eq("id", workshop.id);
    continue;
  }
  const { data: regs, error: regsError } = await supabase
    .from("workshop_registrations")
    .select("phone")
        .eq("workshop_id", workshop.id)
        .eq("payment_status", "confirmed");

      if (regsError) {
        console.error(
          "[pollWorkshopReminders] registration query failed for workshop",
          workshop.id,
          regsError.message,
        );
        continue;
      }

      const dateTimeLabel = new Date(workshop.date_time).toLocaleString("en-IN", {
        weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
        timeZone: "Asia/Kolkata",
      });

      for (const r of regs || []) {
        if (!r.phone) continue;
    const ok = await sendWhatsAppTemplate(
      r.phone,
      META_WORKSHOP_REMINDER_TEMPLATE,
      [
        { name: "workshop_title", value: workshop.title },
        { name: "datetime_label", value: dateTimeLabel },
        { name: "zoom_link", value: workshop.zoom_link || "Link will follow shortly" },
      ],
      {
        kind: "workshop_reminder_1h",
        workshopTitle: workshop.title,
        ctx: workshop.creator_id
          ? { creatorId: workshop.creator_id, workshopId: workshop.id }
          : undefined,
      },
    );
        console.log(
          `[pollWorkshopReminders] 1h reminder to ${r.phone} for workshop ${workshop.id}: ${ok ? "sent" : "FAILED"}`,
        );
      }

      await supabase
        .from("workshops")
        .update({ reminder_1h_sent_at: new Date().toISOString() })
        .eq("id", workshop.id);
    }
  } catch (err) {
    console.error("[pollWorkshopReminders] unhandled error:", err.message);
  }
}

setInterval(pollWorkshopReminders, 5 * 60 * 1000);
pollWorkshopReminders(); // also run once at startup

// Pre-purchase nurture — see workshopNudger.js. Every 5 minutes, but it only
// ever sends between 9:00 and 21:00 IST and only for creators who opted in.
setInterval(pollWorkshopNudges, 5 * 60 * 1000);
pollWorkshopNudges(); // also run once at startup

const PORT = process.env.PORT || 3003;

// DIAGNOSTIC — catches any request that didn't match a real route above.
// If Meta is somehow hitting a slightly different path (trailing slash,
// typo in the Callback URL, etc.), this logs it instead of just returning
// a silent 404 with nothing in the logs.
app.use((req, res) => {
  console.log(`[404] No route matched: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not found" });
});

// DIAGNOSTIC — global error handler, must be defined last and take 4 args
// for Express to recognize it as an error handler. Catches anything that
// throws outside an individual route's own try/catch (e.g. in middleware)
// so it shows up in logs instead of Express silently sending its default
// error page.
app.use((err, req, res, next) => {
  console.error(
    `[UNHANDLED ERROR] ${req.method} ${req.originalUrl}:`,
    err.message,
    err.stack,
  );
  if (!res.headersSent)
    res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => console.log(`WhatsApp bot running on port ${PORT}`));
