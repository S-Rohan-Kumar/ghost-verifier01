// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Surprise Audit Enforcer
//  jobs/auditEnforcer.js
//
//  Runs every 15 minutes via node-cron.
//  Scans all live (non-terminal) audits and advances the state
//  machine based on elapsed time since triggeredAt.
//
//  ADDED: Expo Push Notifications at every threshold.
//  Socket events still fire for when the app IS open.
//  Push notifications fire for when the app is closed/background.
//  Both run together — no conflict.
//
//  Install deps:  npm install node-cron
//  Mount in app:  import "./jobs/auditEnforcer.js"
//                 (import AFTER mongoose connects)
//
//  Required: Business model must have a pushToken field.
//  Token is saved via POST /api/sessions/push-token (sessions.js).
// ═══════════════════════════════════════════════════════════════
import cron     from "node-cron";
import Session  from "../models/Session.js";
import Business from "../models/Business.js";
import { io }   from "../index.js";

const MS_PER_HOUR = 2 * 1000; // TESTING: 1 "hour" = 2 seconds → full 60h = 120 seconds
// ── For testing: set MS_PER_HOUR = 2 * 1000 (1 "hour" = 2 seconds)
// ── and change cron to "*/5 * * * * *" (every 5 seconds)

// ── Thresholds (hours since triggeredAt) ──────────────────────
const T_REMINDER       = 12;   // push reminder, no status change
const T_WARNING        = 24;   // auditStatus → WARNING
const T_REVIEW_PENDING = 48;   // auditStatus → REVIEW_PENDING, session → REVIEW
const T_DEADLINE       = 60;   // auditStatus → REJECTED, session → FLAGGED

// ── Statuses the enforcer still needs to process ──────────────
const LIVE_STATUSES = ["REQUESTED", "WARNING", "REVIEW_PENDING"];

let isScheduled = false; // Flag to prevent multiple cron schedules

// ─────────────────────────────────────────────────────────────────
//  sendPushNotification
//  Uses Expo's push API — no SDK needed on the server, just fetch.
//  Silently skips if pushToken is null (business hasn't granted
//  notification permission or hasn't logged in via updated app).
// ─────────────────────────────────────────────────────────────────
async function sendPushNotification(pushToken, title, body) {
  if (!pushToken) {
    console.log(`  [Push] No token — skipping push notification`);
    return;
  }
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method : "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept"      : "application/json",
      },
      body: JSON.stringify({
        to      : pushToken,
        title,
        body,
        sound   : "default",
        priority: "high",
        data    : { type: "audit_notification" },
      }),
    });
    const json = await res.json();
    console.log(`  [Push] Sent to ${pushToken.slice(-8)} → ${JSON.stringify(json?.data?.status ?? json)}`);
  } catch (err) {
    // Never crash the enforcer over a failed push
    console.warn(`  [Push] Failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────
//  getPushToken — fetch pushToken from Business model
//  Returns null if not found — caller handles gracefully
// ─────────────────────────────────────────────────────────────────
async function getPushToken(businessId) {
  try {
    const business = await Business.findOne({ businessId }).select("pushToken");
    return business?.pushToken ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
//  Core tick — called by cron every 15 minutes
// ─────────────────────────────────────────────────────────────────
async function enforcerTick() {
  const now = new Date();
  console.log(`[AuditEnforcer] Tick at ${now.toISOString()}`);

  const liveSessions = await Session.find({
    "surpriseAudit.auditStatus": { $in: LIVE_STATUSES },
  }).select("sessionId businessId businessName status surpriseAudit auditLog");

  if (liveSessions.length === 0) {
    console.log("[AuditEnforcer] No live audits.");
    return;
  }

  console.log(`[AuditEnforcer] Checking ${liveSessions.length} live audit(s)...`);

  for (const session of liveSessions) {
    await processSession(session, now);
  }
}

// ─────────────────────────────────────────────────────────────────
//  Per-session state advancement
// ─────────────────────────────────────────────────────────────────
async function processSession(session, now) {
  const sa            = session.surpriseAudit;
  const triggeredAt   = new Date(sa.triggeredAt);
  const hoursElapsed  = (now - triggeredAt) / MS_PER_HOUR;
  const currentStatus = sa.auditStatus;
  const hoursLeft     = (T_DEADLINE - hoursElapsed).toFixed(0);

  console.log(`  [${session.sessionId}] ${currentStatus} | ${hoursElapsed.toFixed(1)}h elapsed`);

  // ── T+60: DEADLINE — auto-flag if no submission ──────────────
  if (hoursElapsed >= T_DEADLINE && currentStatus !== "SUBMITTED") {
    await advanceState(session, {
      auditStatus    : "REJECTED",
      sessionStatus  : "FLAGGED",
      auditLogAction : "AUDIT_DEADLINE_MISSED",
      auditLogDetail : `60-hour window expired with no submission. Session auto-flagged.`,
      extraSet       : {},
    });
    emitStateChange(session.sessionId, "REJECTED", "FLAGGED", sa.auditDeadline);

    // Push notification — deadline missed
    const token = await getPushToken(session.businessId);
    await sendPushNotification(
      token,
      "🚩 Audit Deadline Missed",
      `Your audit window for ${session.businessName} has expired. Your session has been flagged.`
    );
    return;
  }

  // ── T+48: REVIEW_PENDING ─────────────────────────────────────
  if (hoursElapsed >= T_REVIEW_PENDING && currentStatus === "WARNING") {
    await advanceState(session, {
      auditStatus    : "REVIEW_PENDING",
      sessionStatus  : "REVIEW",
      auditLogAction : "AUDIT_REVIEW_PENDING",
      auditLogDetail : `48h elapsed — escalated to REVIEW_PENDING. Ops team alerted.`,
      extraSet       : {},
    });
    emitStateChange(session.sessionId, "REVIEW_PENDING", "REVIEW", sa.auditDeadline);

    // Socket alert — works when app is open
    io.emit("audit_reminder", {
      sessionId     : session.sessionId,
      businessId    : session.businessId,
      businessName  : session.businessName,
      auditDeadline : sa.auditDeadline,
      hoursRemaining: hoursLeft,
      message       : `Escalated: only ${hoursLeft} hours remaining. Submit your audit video immediately.`,
    });

    // Push notification — works when app is closed
    const token = await getPushToken(session.businessId);
    await sendPushNotification(
      token,
      "🔍 Audit Escalated",
      `Your audit for ${session.businessName} has been escalated. Only ${hoursLeft} hours remaining — submit now.`
    );
    return;
  }

  // ── T+24: WARNING ────────────────────────────────────────────
  if (hoursElapsed >= T_WARNING && currentStatus === "REQUESTED") {
    await advanceState(session, {
      auditStatus    : "WARNING",
      sessionStatus  : session.status,
      auditLogAction : "AUDIT_WARNING",
      auditLogDetail : `24h elapsed — status escalated to WARNING. User notified.`,
      extraSet       : { "surpriseAudit.warningSentAt": now },
    });
    emitStateChange(session.sessionId, "WARNING", session.status, sa.auditDeadline);

    // Socket alert — works when app is open
    io.emit("audit_reminder", {
      sessionId     : session.sessionId,
      businessId    : session.businessId,
      businessName  : session.businessName,
      auditDeadline : sa.auditDeadline,
      hoursRemaining: hoursLeft,
      message       : `Warning: 24 hours have passed. You have ${hoursLeft} hours left to submit your audit video.`,
    });

    // Push notification — works when app is closed
    const token = await getPushToken(session.businessId);
    await sendPushNotification(
      token,
      "⚠️ Audit Warning",
      `${session.businessName}: 24 hours have passed. You have ${hoursLeft} hours left to submit your audit video.`
    );
    return;
  }

  // ── T+12: REMINDER (sent once, no status change) ─────────────
  if (
    hoursElapsed >= T_REMINDER &&
    currentStatus === "REQUESTED" &&
    !sa.reminderSentAt
  ) {
    await Session.findOneAndUpdate(
      { sessionId: session.sessionId },
      {
        $set : { "surpriseAudit.reminderSentAt": now },
        $push: {
          auditLog: {
            action: "AUDIT_REMINDER_SENT",
            detail: `12h reminder: ${(T_DEADLINE - hoursElapsed).toFixed(1)}h remaining before deadline.`,
          },
        },
      }
    );

    // Socket event — works when app is open
    io.emit("audit_reminder", {
      sessionId     : session.sessionId,
      businessName  : session.businessName,
      auditDeadline : sa.auditDeadline,
      hoursRemaining: (T_DEADLINE - hoursElapsed).toFixed(1),
      message       : `Reminder: you have ${hoursLeft} hours left to submit your audit video.`,
    });

    // Push notification — works when app is closed
    const token = await getPushToken(session.businessId);
    await sendPushNotification(
      token,
      "⏰ Audit Reminder",
      `${session.businessName}: You have ${hoursLeft} hours left to submit your audit video.`
    );

    console.log(`  [${session.sessionId}] Reminder sent at T+${hoursElapsed.toFixed(1)}h`);
  }
}

// ─────────────────────────────────────────────────────────────────
//  Helper: write state transition to DB — unchanged
// ─────────────────────────────────────────────────────────────────
async function advanceState(session, { auditStatus, sessionStatus, auditLogAction, auditLogDetail, extraSet }) {
  await Session.findOneAndUpdate(
    { sessionId: session.sessionId },
    {
      $set: {
        status                     : sessionStatus,
        "surpriseAudit.auditStatus": auditStatus,
        ...extraSet,
      },
      $push: {
        auditLog: {
          action: auditLogAction,
          detail: auditLogDetail,
        },
      },
    }
  );
  console.log(`  [${session.sessionId}] → auditStatus: ${auditStatus} | sessionStatus: ${sessionStatus}`);
}

// ─────────────────────────────────────────────────────────────────
//  Helper: broadcast state change to dashboard + app — unchanged
// ─────────────────────────────────────────────────────────────────
function emitStateChange(sessionId, auditStatus, sessionStatus, auditDeadline) {
  io.emit("audit_state_changed", {
    sessionId,
    auditStatus,
    sessionStatus,
    auditDeadline,
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────
//  Schedule: every 15 minutes — PRODUCTION MODE
// ─────────────────────────────────────────────────────────────────
if (!isScheduled) {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await enforcerTick();
    } catch (err) {
      console.error("[AuditEnforcer] Unhandled error in tick:", err.message);
    }
  });
  isScheduled = true;
  console.log("[AuditEnforcer] Scheduled — running every 15 minutes.");
}

export { enforcerTick }; // exported for tests