"use strict";
/**
 * whatsapp-bot/usage.js
 * ─────────────────────────────────────────────────────────────────
 * Counts the WhatsApp messages this bot sends, so each creator's monthly
 * invoice can include them (course-web: lib/whatsappBilling.ts).
 *
 * How it works
 *   1. When a message is sent, recordSend() writes a row to whatsapp_usage
 *      with the creator, the course or workshop, the kind of message and
 *      Meta's message id. The row starts as "not billable".
 *   2. Meta then sends a delivery report (a "status" webhook). handleStatusPayload()
 *      reads it: when the message is delivered, and what Meta charged it as
 *      (its "pricing" block: billable yes/no and the category). Only delivered,
 *      billable rows are invoiced.
 *   3. If we cannot tell whose message it is, it goes to whatsapp_usage_unowned
 *      for review. It is never silently billed to a guess.
 *
 * Safety rules
 *   - Nothing in here may ever stop a message from sending or crash the bot.
 *     Every function catches its own errors and only logs them.
 *   - A creator with an overdue invoice has their PROMOTIONAL (marketing) sends
 *     paused. Lessons, replies and reminders for people who already joined keep
 *     working, so existing students lose nothing.
 * ─────────────────────────────────────────────────────────────────
 */

const { normalizePhone } = require("./phone");

let _supabase = null;

const OWNER_TTL_MS = 60 * 1000;
const MISS_TTL_MS = 15 * 1000;
const OVERDUE_TTL_MS = 5 * 60 * 1000;
const STATUS_RETRY_DELAYS_MS = [3000, 10000, 30000];

// Only if Meta's delivery reports ever arrive WITHOUT a pricing block: treat
// delivered template messages as billable. Off by default; check the logged
// webhook payloads first (the bot already logs them).
const FALLBACK_BILLABLE = process.env.USAGE_FALLBACK_BILLABLE === "true";

const ownerCache = new Map();
const overdueCache = new Map();
const whatsappFlagCache = new Map();
const templateCategories = new Map();

function initUsage({ supabase }) {
  _supabase = supabase;
}

// templateName -> 'utility' | 'marketing' | 'authentication'. Anything not
// listed is treated as utility. Meta's delivery report has the final say.
function registerTemplateCategories(map) {
  for (const [name, category] of Object.entries(map || {})) {
    if (name) templateCategories.set(name, category);
  }
}

function categoryForTemplate(name) {
  return templateCategories.get(name) || "utility";
}

// Meta category names -> the four we bill on.
function mapMetaCategory(c) {
  switch (c) {
    case "marketing":
    case "marketing_lite":
      return "marketing";
    case "utility":
      return "utility";
    case "authentication":
    case "authentication_international":
      return "authentication";
    case "service":
    case "referral_conversion":
      return "service";
    default:
      return null;
  }
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (hit && Date.now() < hit.until) return hit;
  if (hit) map.delete(key);
  return null;
}
function cacheSet(map, key, value, ttl) {
  map.set(key, { value, until: Date.now() + ttl });
  if (map.size > 5000) map.clear(); // never let a cache grow without limit
}

// Only trust ids passed by our own web app (internal routes are secret-protected).
function ctxFromBody(body) {
  if (!body || typeof body.creatorId !== "string" || !body.creatorId)
    return null;
  return {
    creatorId: body.creatorId,
    courseId: typeof body.courseId === "string" ? body.courseId : null,
    workshopId: typeof body.workshopId === "string" ? body.workshopId : null,
  };
}

// ── whose message is this? ──────────────────────────────────────────
async function ownerFromEnrollments(phone, courseName) {
  const p = normalizePhone(phone) || String(phone);
  const { data, error } = await _supabase
    .from("enrollments")
    .select("course_uuid, courses:course_uuid(id, name, creator_id)")
    .eq("phone", p)
    .order("enrolled_at", { ascending: false })
    .limit(10);
  if (error || !data || data.length === 0) return null;
  const rows = data.filter((r) => r.courses && r.courses.creator_id);
  const pick =
    (courseName && rows.find((r) => r.courses.name === courseName)) || rows[0];
  if (!pick) return null;
  return {
    creatorId: pick.courses.creator_id,
    courseId: pick.courses.id,
    workshopId: null,
  };
}

async function ownerFromWorkshops(phone, workshopTitle) {
  // Workshop registrations keep the full international number; enrollments do not.
  const full = String(phone).replace(/\D/g, "");
  const bare = normalizePhone(phone);
  const variants = [...new Set([full, bare].filter(Boolean))];
  const { data: regs, error } = await _supabase
    .from("workshop_registrations")
    .select("workshop_id")
    .in("phone", variants)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error || !regs || regs.length === 0) return null;
  const ids = [...new Set(regs.map((r) => r.workshop_id))];
  const { data: workshops } = await _supabase
    .from("workshops")
    .select("id, creator_id, title")
    .in("id", ids);
  if (!workshops || workshops.length === 0) return null;
  const ordered = ids
    .map((id) => workshops.find((w) => w.id === id))
    .filter(Boolean);
  const pick =
    (workshopTitle && ordered.find((w) => w.title === workshopTitle)) ||
    ordered[0];
  if (!pick || !pick.creator_id) return null;
  return { creatorId: pick.creator_id, courseId: null, workshopId: pick.id };
}

async function resolveOwner({ phone, kind, ctx, courseName, workshopTitle }) {
  try {
    if (ctx && ctx.creatorId) {
      return {
        creatorId: ctx.creatorId,
        courseId: ctx.courseId || null,
        workshopId: ctx.workshopId || null,
      };
    }
    if (!_supabase || !phone) return null;
    const workshopFirst = String(kind || "").startsWith("workshop");
    const key = `${workshopFirst ? "w" : "c"}|${phone}|${courseName || workshopTitle || ""}`;
    const cached = cacheGet(ownerCache, key);
    if (cached) return cached.value;

    const owner = workshopFirst
      ? (await ownerFromWorkshops(phone, workshopTitle)) ||
        (await ownerFromEnrollments(phone, courseName))
      : (await ownerFromEnrollments(phone, courseName)) ||
        (await ownerFromWorkshops(phone, workshopTitle));
    cacheSet(ownerCache, key, owner, owner ? OWNER_TTL_MS : MISS_TTL_MS);
    return owner;
  } catch (err) {
    console.error("[usage] resolveOwner failed:", err.message);
    return null;
  }
}

// ── 1. a message was sent ───────────────────────────────────────────
async function recordSend({
  messageId,
  toPhone,
  kind,
  templateName,
  category,
  ctx,
  courseName,
  workshopTitle,
  account,
}) {
  try {
    if (!_supabase || !messageId) return;
    const base = {
      wa_message_id: messageId,
      to_phone: toPhone ? String(toPhone).replace(/\D/g, "") : null,
      kind: kind || "message",
      template_name: templateName || null,
      category: category || "service",
      billable: false,
      sent_at: new Date().toISOString(),
    };
    let owner = await resolveOwner({
      phone: toPhone,
      kind,
      ctx,
      courseName,
      workshopTitle,
    });
    if (account && account.creatorId) {
      const same = owner && owner.creatorId === account.creatorId;
      owner = {
        creatorId: account.creatorId,
        courseId: same ? owner.courseId : null,
        workshopId: same ? owner.workshopId : null,
      };
    }
    if (!owner) {
      const { error } = await _supabase
        .from("whatsapp_usage_unowned")
        .insert({ ...base, note: "owner not found" });
      if (error && error.code !== "23505")
        console.error("[usage] unowned insert failed:", error.message);
      return;
    }
    const { error } = await _supabase.from("whatsapp_usage").insert({
      ...base,
      creator_id: owner.creatorId,
      course_id: owner.courseId,
            workshop_id: owner.workshopId,
      ...(account ? { own_number: true } : {}),
    });
    if (error && error.code !== "23505") console.error("[usage] insert failed:", error.message);
  } catch (err) {
    console.error("[usage] recordSend failed:", err.message);
  }
}

// ── 2. Meta's delivery report ───────────────────────────────────────
async function patchRow(id, patch) {
  for (const table of ["whatsapp_usage", "whatsapp_usage_unowned"]) {
    const { data, error } = await _supabase
      .from(table)
      .update(patch)
      .eq("wa_message_id", id)
      .select("wa_message_id");
    if (error) {
      console.error(`[usage] ${table} update failed:`, error.message);
      continue;
    }
    if (data && data.length > 0) return true;
  }
  return false;
}

async function applyStatus(st, attempt = 0) {
  try {
    if (!_supabase || !st || !st.id) return;
    const patch = {};
    const pricing = st.pricing;
    if (pricing) {
      if (typeof pricing.billable === "boolean")
        patch.billable = pricing.billable;
      const cat = mapMetaCategory(pricing.category);
      if (cat) patch.category = cat;
    }
    // A message that failed was not delivered and is not charged.
    if (st.status === "failed") patch.billable = false;
    const tsIso = st.timestamp
      ? new Date(Number(st.timestamp) * 1000).toISOString()
      : new Date().toISOString();
    if (st.status === "delivered") patch.delivered_at = tsIso;

    if (Object.keys(patch).length > 0) {
      const matched = await patchRow(st.id, patch);
      if (!matched) {
        // The send is saved a moment after Meta answers, so a very fast report can beat it. Try again shortly.
        if (attempt < STATUS_RETRY_DELAYS_MS.length) {
          const t = setTimeout(
            () => applyStatus(st, attempt + 1),
            STATUS_RETRY_DELAYS_MS[attempt],
          );
          if (t.unref) t.unref();
        } else {
          console.warn(
            "[usage] no record found for message",
            st.id,
            "status",
            st.status,
          );
        }
        return;
      }
    }

    // "read" proves it was delivered, even if we never saw "delivered". Keep the earliest time.
    if (st.status === "read") {
      for (const table of ["whatsapp_usage", "whatsapp_usage_unowned"]) {
        await _supabase
          .from(table)
          .update({ delivered_at: tsIso })
          .eq("wa_message_id", st.id)
          .is("delivered_at", null);
      }
    }

    if (
      FALLBACK_BILLABLE &&
      !pricing &&
      (st.status === "delivered" || st.status === "read")
    ) {
      for (const table of ["whatsapp_usage", "whatsapp_usage_unowned"]) {
        await _supabase
          .from(table)
          .update({ billable: true })
          .eq("wa_message_id", st.id)
          .neq("category", "service");
      }
    }
  } catch (err) {
    console.error("[usage] applyStatus failed:", err.message);
  }
}

// Meta may batch several reports, across several entries, in one webhook call.
async function handleStatusPayload(body) {
  const jobs = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      for (const st of (change.value && change.value.statuses) || []) {
        jobs.push(applyStatus(st));
      }
    }
  }
  if (jobs.length) await Promise.allSettled(jobs);
}

// ── 3a. did the creator switch WhatsApp off for this workshop? ──────
// Fails OPEN: if the column does not exist yet, or the lookup fails, WhatsApp stays on
// (how workshops behaved before the switch), so a bug can never silence a reminder.
async function workshopWhatsappEnabled(workshopId) {
  try {
    if (!_supabase || !workshopId) return true;
    const cached = cacheGet(whatsappFlagCache, workshopId);
    if (cached) return cached.value;
    const { data, error } = await _supabase
      .from("workshops")
      .select("notify_whatsapp")
      .eq("id", workshopId)
      .maybeSingle();
    if (error) return true;
    const enabled = !(data && data.notify_whatsapp === false);
    cacheSet(whatsappFlagCache, workshopId, enabled, 60 * 1000);
    return enabled;
  } catch (err) {
    console.error(
      "[usage] workshopWhatsappEnabled failed (leaving WhatsApp on):",
      err.message,
    );
    return true;
  }
}

// ── 3. overdue creators: pause promotions only ──────────────────────
async function isCreatorOverdue(creatorId) {
  try {
    if (!_supabase || !creatorId) return false;
    const cached = cacheGet(overdueCache, creatorId);
    if (cached) return cached.value;
    const { data, error } = await _supabase
      .from("revenue_share_invoices")
      .select("id")
      .eq("creator_id", creatorId)
      .eq("status", "overdue")
      .limit(1);
    if (error) {
      console.error(
        "[usage] overdue check failed (not blocking):",
        error.message,
      );
      return false; // never block on an error
    }
    const overdue = Array.isArray(data) && data.length > 0;
    cacheSet(overdueCache, creatorId, overdue, OVERDUE_TTL_MS);
    return overdue;
  } catch (err) {
    console.error(
      "[usage] isCreatorOverdue failed (not blocking):",
      err.message,
    );
    return false;
  }
}

module.exports = {
  initUsage,
  registerTemplateCategories,
  categoryForTemplate,
  mapMetaCategory,
  ctxFromBody,
  resolveOwner,
  recordSend,
  applyStatus,
  handleStatusPayload,
  isCreatorOverdue,
  workshopWhatsappEnabled,
};
