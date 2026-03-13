// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Surprise Audit Enforcer
//  jobs/auditEnforcer.js
//
//  Runs every 15 minutes via node-cron.
//  Scans all live (non-terminal) audits and advances the state
//  machine based on elapsed time since triggeredAt.
//
//  Install dep:  npm install node-cron
//  Mount in app: import "./jobs/auditEnforcer.js"
//                (import AFTER mongoose connects)
// ═══════════════════════════════════════════════════════════════
import cron    from "node-cron";
import Session from "../models/Session.js";
import { io }  from "../index.js";

const MS_PER_HOUR = 60 * 60 * 1000;

// ── Thresholds (hours since triggeredAt) ──────────────────────
const T_REMINDER       = 12;   // log a reminder, no status change
const T_WARNING        = 24;   // auditStatus → WARNING
const T_REVIEW_PENDING = 48;   // auditStatus → REVIEW_PENDING, session → REVIEW
const T_DEADLINE       = 60;   // auditStatus → REJECTED, session → FLAGGED

// ── Statuses the enforcer still needs to process ──────────────
const LIVE_STATUSES = ["REQUESTED", "WARNING", "REVIEW_PENDING"];

// ─────────────────────────────────────────────────────────────────
//  Core tick — called by cron every 15 minutes
// ─────────────────────────────────────────────────────────────────
async function enforcerTick() {
  const now = new Date();
  console.log(`[AuditEnforcer] Tick at ${now.toISOString()}`);

  // Pull only live audits — the partial index makes this fast
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
    return;
  }

  // ── T+24: WARNING ────────────────────────────────────────────
  if (hoursElapsed >= T_WARNING && currentStatus === "REQUESTED") {
    await advanceState(session, {
      auditStatus    : "WARNING",
      sessionStatus  : session.status,   // don't change session status yet
      auditLogAction : "AUDIT_WARNING",
      auditLogDetail : `24h elapsed — status escalated to WARNING. User notified.`,
      extraSet       : { "surpriseAudit.warningSentAt": now },
    });
    emitStateChange(session.sessionId, "WARNING", session.status, sa.auditDeadline);
    return;
  }

  // ── T+12: REMINDER (logged once, no status change) ──────────
  if (
    hoursElapsed >= T_REMINDER &&
    currentStatus === "REQUESTED"    &&
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

    // Push reminder to mobile app
    io.emit("audit_reminder", {
      sessionId     : session.sessionId,
      businessName  : session.businessName,
      auditDeadline : sa.auditDeadline,
      hoursRemaining: (T_DEADLINE - hoursElapsed).toFixed(1),
      message       : `Reminder: you have ${(T_DEADLINE - hoursElapsed).toFixed(0)} hours left to submit your audit video.`,
    });

    console.log(`  [${session.sessionId}] Reminder sent at T+${hoursElapsed.toFixed(1)}h`);
  }
}

// ─────────────────────────────────────────────────────────────────
//  Helper: write state transition to DB
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
//  Helper: broadcast state change to dashboard + app
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
//  Schedule: every 15 minutes
// ─────────────────────────────────────────────────────────────────
cron.schedule("*/15 * * * *", async () => {
  try {
    await enforcerTick();
  } catch (err) {
    console.error("[AuditEnforcer] Unhandled error in tick:", err.message);
  }
});

console.log("[AuditEnforcer] Scheduled — running every 15 minutes.");

export { enforcerTick }; // exported for tests