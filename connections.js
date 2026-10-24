"use strict";
/**
 * whatsapp-bot/connections.js
 * ─────────────────────────────────────────────────────────────────
 * Lets a creator send from THEIR OWN WhatsApp number (Meta Embedded Signup, billing phase 4).
 * The course-web app saves the connection (the Meta token is encrypted) in whatsapp_connections.
 *
 * What this file does
 *   - pickAccount():   before each send, chooses the creator's own number if they have a working one,
 *                      otherwise Kurso's (returns null = use Kurso's number, exactly as before).
 *   - runWithAccount(): while handling a student's incoming message, every reply goes out from the
 *                      number the student wrote to. (Uses AsyncLocalStorage, so the rest of the bot's
 *                      code does not need to know which number it is on.)
 *   - reportProblem(): if Meta rejects a creator's number (unpaid balance, revoked access...), marks it
 *                      as a problem and emails the creator through course-web.
 *   - setupTemplates(): copies Kurso's approved message templates into the creator's WhatsApp account.
 *
 * Safety rules
 *   - Before billing-phase4.sql is run, or if anything here fails, the bot behaves exactly as before:
 *     it sends from Kurso's number. Nothing in here may stop a message from sending.
 *   - Only connections with status "connected" are used.
 * ─────────────────────────────────────────────────────────────────
 */

const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");
const axios = require("axios");

const als = new AsyncLocalStorage();
const CACHE_TTL_MS = 60 * 1000;

let _supabase = null;
let _cfg = {};
let cache = { byCreator: new Map(), byNumberId: new Map(), loadedAt: 0 };
let loggedLoadError = false;

function initConnections({ supabase, config }) {
  _supabase = supabase;
  _cfg = config || {};
}

// ── token decryption (same format as course-web: iv(12) + tag(16) + ciphertext, base64, AES-256-GCM) ──
function decrypt(encoded) {
  const raw = process.env.WHATSAPP_TOKENS_KEY;
  if (!raw) throw new Error("WHATSAPP_TOKENS_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("WHATSAPP_TOKENS_KEY must decode to 32 bytes");
  const buf = Buffer.from(encoded, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

// ── the list of working connections, refreshed at most once a minute ─────────
async function ensureFresh(force) {
  if (!_supabase) return;
  if (!force && Date.now() - cache.loadedAt < CACHE_TTL_MS) return;
  try {
    const { data, error } = await _supabase
      .from("whatsapp_connections")
      .select("creator_id, waba_id, phone_number_id, token_encrypted")
      .eq("status", "connected");
    if (error) {
      // Most likely billing-phase4.sql has not been run yet. Keep using Kurso's number.
      if (!loggedLoadError) console.warn("[connections] could not load connections (using Kurso's number):", error.message);
      loggedLoadError = true;
      cache.loadedAt = Date.now();
      return;
    }
    loggedLoadError = false;
    const byCreator = new Map();
    const byNumberId = new Map();
    for (const row of data || []) {
      try {
        const account = {
          creatorId: row.creator_id,
          wabaId: row.waba_id,
          phoneNumberId: row.phone_number_id,
          token: decrypt(row.token_encrypted),
        };
        byCreator.set(account.creatorId, account);
        byNumberId.set(account.phoneNumberId, account);
      } catch (err) {
        console.error("[connections] skipping a connection, could not decrypt its token:", err.message);
      }
    }
    cache = { byCreator, byNumberId, loadedAt: Date.now() };
  } catch (err) {
    console.error("[connections] refresh failed (keeping the last list):", err.message);
    cache.loadedAt = Date.now();
  }
}

let lastMissRefreshAt = 0;
async function accountForPhoneNumberId(phoneNumberId) {
  await ensureFresh();
  let account = cache.byNumberId.get(phoneNumberId) || null;
  // A number connected a moment ago may not be in the cache yet. Look again, at most once every 10 seconds.
  if (!account && phoneNumberId && Date.now() - lastMissRefreshAt > 10 * 1000) {
    lastMissRefreshAt = Date.now();
    await ensureFresh(true);
    account = cache.byNumberId.get(phoneNumberId) || null;
  }
  return account;
}

async function hasConnectedNumber(creatorId) {
  await ensureFresh();
  return cache.byCreator.has(creatorId);
}

/**
 * Which number should this message go out from?  null = Kurso's number.
 *   1. Inside a student's incoming message: the number they wrote to.
 *   2. Otherwise the creator the message is for (passed in, or found from the student's course/workshop).
 */
async function pickAccount({ resolveOwner, phone, kind, ctx, courseName, workshopTitle }) {
  try {
    const store = als.getStore();
    if (store) {
      // Replying to a student: use the number they wrote to, unless it was just marked as a problem.
      const a = store.account;
      return a && cache.byNumberId.has(a.phoneNumberId) ? a : null;
    }
    await ensureFresh();
    if (cache.byCreator.size === 0) return null; // nobody connected: no lookups at all
    let creatorId = ctx && ctx.creatorId;
    if (!creatorId && resolveOwner) {
      const owner = await resolveOwner({ phone, kind, ctx, courseName, workshopTitle });
      creatorId = owner && owner.creatorId;
    }
    return (creatorId && cache.byCreator.get(creatorId)) || null;
  } catch (err) {
    console.error("[connections] pickAccount failed (using Kurso's number):", err.message);
    return null;
  }
}

function runWithAccount(account, fn) {
  return als.run({ account: account || null }, fn);
}

// ── Meta errors ────────────────────────────────────────────────────
function metaError(err) {
  return (err && err.response && err.response.data && err.response.data.error) || null;
}

function describeMetaError(err) {
  const e = metaError(err);
  return e ? `${e.error_user_msg || e.message || "Meta rejected the message"} (code ${e.code})` : (err && err.message) || "Unknown error";
}

// The creator's account itself is the problem: unpaid balance, revoked access, locked or unregistered number.
const ACCOUNT_ERROR_CODES = new Set([190, 131031, 131042, 133005, 133010, 133016]);
function isAccountLevelError(err) {
  const status = err && err.response && err.response.status;
  const e = metaError(err);
  return status === 401 || status === 403 || Boolean(e && ACCOUNT_ERROR_CODES.has(Number(e.code)));
}

// The creator's account is fine, but this template is not ready in it yet (not created, still in review, paused).
const TEMPLATE_NOT_READY_CODES = new Set([132001, 132015, 132016]);
function isTemplateNotReadyError(err) {
  const e = metaError(err);
  return Boolean(e && TEMPLATE_NOT_READY_CODES.has(Number(e.code)));
}

/** Marks a creator's number as a problem (once) and tells them. Never throws. */
async function reportProblem(account, message) {
  try {
    if (!_supabase || !account) return;
    const now = new Date().toISOString();
    // Stop using it straight away, without waiting for the next refresh.
    cache.byCreator.delete(account.creatorId);
    cache.byNumberId.delete(account.phoneNumberId);
    const { data, error } = await _supabase
      .from("whatsapp_connections")
      .update({ status: "problem", last_error: String(message || "").slice(0, 500), last_error_at: now, updated_at: now })
      .eq("creator_id", account.creatorId)
      .eq("status", "connected")
      .select("creator_id");
    if (error) {
      console.error("[connections] could not record the problem:", error.message);
      return;
    }
    if (data && data.length > 0 && _cfg.kursoUrl && _cfg.internalSecret) {
      axios
        .post(
          `${_cfg.kursoUrl}/api/internal/whatsapp-connection-problem`,
          { creatorId: account.creatorId, message: String(message || "").slice(0, 500) },
          { headers: { Authorization: `Bearer ${_cfg.internalSecret}` }, timeout: 10000 },
        )
        .catch((e) => console.error("[connections] could not email the creator:", e.message));
    }
  } catch (err) {
    console.error("[connections] reportProblem failed:", err.message);
  }
}

// ── copy Kurso's approved templates into a creator's WhatsApp account ─────
async function setupTemplates(creatorId, templateNames) {
  const result = { ok: false, templates: {} };
  try {
    if (!_supabase) return result;
    if (!_cfg.kursoWabaId || !_cfg.kursoToken) {
      console.error("[connections] setupTemplates: META_WABA_ID is not set, cannot copy templates");
      return result;
    }
    // Any status: a number still waiting for verification needs its templates too.
    const { data: row, error } = await _supabase
      .from("whatsapp_connections")
      .select("waba_id, token_encrypted, templates")
      .eq("creator_id", creatorId)
      .maybeSingle();
    if (error || !row) {
      console.error("[connections] setupTemplates: no connection for", creatorId, error && error.message);
      return result;
    }
    const base = `https://graph.facebook.com/${_cfg.graphVersion}`;
    const creatorToken = decrypt(row.token_encrypted);
    const out = { ...(row.templates || {}) };

    for (const name of templateNames || []) {
      try {
        const src = await axios.get(`${base}/${_cfg.kursoWabaId}/message_templates`, {
          params: { name, fields: "name,language,category,components,parameter_format,status", limit: 50 },
          headers: { Authorization: `Bearer ${_cfg.kursoToken}` },
          timeout: 15000,
        });
        const tpl = ((src.data && src.data.data) || []).find((t) => t.language === _cfg.templateLang && t.status === "APPROVED");
        if (!tpl) {
          out[name] = "MISSING";
          continue;
        }
        const body = { name: tpl.name, language: tpl.language, category: tpl.category, components: tpl.components };
        if (tpl.parameter_format) body.parameter_format = tpl.parameter_format;
        try {
          await axios.post(`${base}/${row.waba_id}/message_templates`, body, {
            headers: { Authorization: `Bearer ${creatorToken}`, "Content-Type": "application/json" },
            timeout: 20000,
          });
          out[name] = "PENDING"; // Meta reviews it; course-web shows the real status when the creator opens the page
        } catch (err) {
          const e = metaError(err);
          if (/already exist|name.*(taken|in use)/i.test(JSON.stringify(e || {}))) {
            out[name] = "PENDING"; // it is there already; course-web will show its real status
          } else {
            console.error("[connections] could not create template", name, "for", creatorId, "|", describeMetaError(err));
            out[name] = "FAILED";
          }
        }
      } catch (err) {
        console.error("[connections] could not read template", name, "|", describeMetaError(err));
        out[name] = "FAILED";
      }
    }

    const { error: saveErr } = await _supabase
      .from("whatsapp_connections")
      .update({ templates: out, updated_at: new Date().toISOString() })
      .eq("creator_id", creatorId);
    if (saveErr) console.error("[connections] could not save template results:", saveErr.message);
    return { ok: !saveErr, templates: out };
  } catch (err) {
    console.error("[connections] setupTemplates failed:", err.message);
    return result;
  }
}

module.exports = {
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
};
