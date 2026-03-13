// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Surprise Audit Routes
//  routes/audit.js
//
//  How the audit starts (auto):
//    → Session reaches PASSED in POST /api/sessions/ai-result
//    → sessions.js calls autoTriggerAudit(sessionId, s3ThumbKey)
//    → Sets auditStatus = REQUESTED, deadline = now+60h
//    → Emits request_audit socket event to the mobile app
//    → auditEnforcer.js (cron, every 15 min) advances state machine
//    → App uploads audit video → POST /api/audit/:id/submit
//    → S3 triggers auditLambda.mjs → POST /api/audit/cv-result
//    → Final PASSED or REJECTED written here
//
//  How the audit starts (manual):
//    → Dashboard officer clicks "Trigger Surprise Audit"
//    → POST /api/audit/:sessionId/trigger  ← NEW route
//    → Same autoTriggerAudit path as above
//
//  Routes:
//    POST /api/audit/:sessionId/trigger   → manual officer trigger
//    POST /api/audit/:sessionId/submit    → mobile uploads audit video
//    POST /api/audit/cv-result            → Lambda posts CV result
//    GET  /api/audit/:sessionId/status    → poll current state
//
//  Exported function (not a route):
//    autoTriggerAudit(sessionId, anchorS3Key)  ← called by sessions.js
// ═══════════════════════════════════════════════════════════════
import express from "express";
import Session from "../models/Session.js";
import { io }  from "../index.js";

const router = express.Router();

const AUDIT_WINDOW_HOURS = 60;
const MS_PER_HOUR        = 60 * 60 * 1000;

// ═════════════════════════════════════════════════════════════════
//  EXPORTED HELPER — called by sessions.js, not a route
//
//  Called immediately after a session is written as PASSED.
//  anchorS3Key = the s3ThumbUri from the original session
//  (the thumbnail that Rekognition already scanned).
//  That image becomes the reference frame the audit Lambda
//  compares the new video against.
// ═════════════════════════════════════════════════════════════════
export async function autoTriggerAudit(sessionId, anchorS3Key) {
  const session = await Session.findOne({ sessionId });

  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== "PASSED") throw new Error(`Session is ${session.status}, not PASSED`);
  if (session.surpriseAudit?.auditStatus) {
    console.warn(`[autoTriggerAudit] Audit already exists for ${sessionId} — skipping`);
    return;
  }

  const now           = new Date();
  const auditDeadline = new Date(now.getTime() + AUDIT_WINDOW_HOURS * MS_PER_HOUR);

  const anchorFrameKeys = anchorS3Key ? [anchorS3Key] : [];

  await Session.findOneAndUpdate(
    { sessionId },
    {
      $set: {
        "surpriseAudit.auditStatus"    : "REQUESTED",
        "surpriseAudit.triggeredAt"    : now,
        "surpriseAudit.auditDeadline"  : auditDeadline,
        "surpriseAudit.triggeredBy"    : "SYSTEM",
        "surpriseAudit.anchorFrameKeys": anchorFrameKeys,
      },
      $push: {
        auditLog: {
          action: "AUDIT_AUTO_TRIGGERED",
          detail: `Surprise audit auto-started on PASSED. Deadline: ${auditDeadline.toISOString()}. Anchor: ${anchorS3Key ?? "none"}`,
        },
      },
    }
  );

  // Push to the mobile app — opens the AuditOverlay screen
  io.emit("request_audit", {
    sessionId,
    businessId   : session.businessId,
    businessName : session.businessName,
    auditDeadline: auditDeadline.toISOString(),
    triggeredBy  : "SYSTEM",
    hoursRemaining: AUDIT_WINDOW_HOURS,
    message      : "Your verification passed! A surprise re-check is required within 60 hours. Please re-record at the same premises.",
  });

  // Notify dashboard so CaseDetail shows the AuditClockPanel immediately
  io.emit("audit_state_changed", {
    sessionId,
    auditStatus  : "REQUESTED",
    sessionStatus: "PASSED",
    auditDeadline: auditDeadline.toISOString(),
    timestamp    : now.toISOString(),
  });

  console.log(`[autoTriggerAudit] ✅ ${sessionId} — deadline ${auditDeadline.toISOString()}`);
}

// ─────────────────────────────────────────────────────────────────
//  POST /api/audit/:sessionId/trigger
//  Manual trigger — called by the dashboard's TriggerAuditButton.
//  Requires the session to already be PASSED.
//  Accepts { triggeredBy: "Officer Name / Badge ID" } in body.
// ─────────────────────────────────────────────────────────────────
router.post("/:sessionId/trigger", async (req, res) => {
  try {
    const { sessionId }  = req.params;
    const { triggeredBy } = req.body;

    const session = await Session.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.status !== "PASSED") {
      return res.status(400).json({
        error: `Cannot trigger audit — session status is "${session.status}", not PASSED`,
      });
    }
    if (session.surpriseAudit?.auditStatus) {
      return res.status(409).json({
        error: `Audit already active (status: ${session.surpriseAudit.auditStatus})`,
      });
    }

    // Reuse autoTriggerAudit (sets triggeredBy = "SYSTEM" first)
    await autoTriggerAudit(sessionId, session.s3ThumbUri ?? null);

    // Overwrite triggeredBy with the officer name if provided
    if (triggeredBy) {
      await Session.findOneAndUpdate(
        { sessionId },
        { $set: { "surpriseAudit.triggeredBy": triggeredBy } }
      );
    }

    console.log(`[audit/trigger] Manual trigger by "${triggeredBy ?? "unknown"}" for ${sessionId}`);

    res.json({
      success    : true,
      sessionId,
      triggeredBy: triggeredBy ?? "SYSTEM",
      message    : "Surprise audit triggered. Business has 60 hours to submit a new video.",
    });

  } catch (err) {
    console.error("[POST /audit/trigger]", err);
    res.status(500).json({ error: "Failed to trigger audit", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/audit/:sessionId/submit
//  Called by the React Native app after uploading the audit
//  thumbnail to S3 (audit-thumbnails/ prefix).
//  Moves auditStatus → SUBMITTED.
//  The S3 PutObject event then fires auditLambda.mjs automatically.
// ─────────────────────────────────────────────────────────────────
router.post("/:sessionId/submit", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { auditS3ThumbUri, auditS3VideoUri } = req.body;

    const session = await Session.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const auditStatus = session.surpriseAudit?.auditStatus;
    if (!auditStatus || auditStatus === "REJECTED" || auditStatus === "PASSED") {
      return res.status(400).json({
        error: `Cannot submit audit — current audit status is "${auditStatus ?? "null"}"`,
      });
    }

    // Enforce deadline
    const deadline = session.surpriseAudit?.auditDeadline;
    if (deadline && new Date() > new Date(deadline)) {
      return res.status(410).json({
        error: "Audit deadline has passed. This session has been flagged.",
      });
    }

    const now = new Date();

    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          "surpriseAudit.auditStatus"    : "SUBMITTED",
          "surpriseAudit.submittedAt"    : now,
          "surpriseAudit.auditS3ThumbUri": auditS3ThumbUri ?? null,
          "surpriseAudit.auditS3VideoUri": auditS3VideoUri ?? null,
        },
        $push: {
          auditLog: {
            action: "AUDIT_SUBMITTED",
            detail: `Audit video submitted. Thumb: ${auditS3ThumbUri ?? "none"}. CV analysis queued via S3 trigger.`,
          },
        },
      }
    );

    io.emit("audit_state_changed", {
      sessionId,
      auditStatus: "SUBMITTED",
      submittedAt: now.toISOString(),
    });

    console.log(`[audit/submit] SUBMITTED — ${sessionId}`);

    res.json({
      success    : true,
      sessionId,
      auditStatus: "SUBMITTED",
      message    : "Audit video received. Visual continuity analysis is running.",
    });

  } catch (err) {
    console.error("[POST /audit/submit]", err);
    res.status(500).json({ error: "Failed to submit audit", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/audit/cv-result
//  Called by auditLambda.mjs after running the visual comparison.
//  similarityScore >= 75 → PASSED, < 75 → REJECTED + session FLAGGED
// ─────────────────────────────────────────────────────────────────
router.post("/cv-result", async (req, res) => {
  try {
    const {
      sessionId,
      similarityScore,
      layoutMismatch,
      frameComparisons,
      newLabels,
      missingLabels,
      labelOverlap,
      verdict,
    } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }

    const session = await Session.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ error: `Session not found: ${sessionId}` });
    }

    const finalAuditStatus   = layoutMismatch ? "REJECTED" : "PASSED";
    const finalSessionStatus = layoutMismatch ? "FLAGGED"  : session.status;

    const now = new Date();

    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          status                                   : finalSessionStatus,
          "surpriseAudit.auditStatus"              : finalAuditStatus,
          "surpriseAudit.cvResult.similarityScore" : similarityScore,
          "surpriseAudit.cvResult.layoutMismatch"  : layoutMismatch,
          "surpriseAudit.cvResult.frameComparisons": frameComparisons ?? [],
          "surpriseAudit.cvResult.newLabels"       : newLabels        ?? [],
          "surpriseAudit.cvResult.missingLabels"   : missingLabels    ?? [],
          "surpriseAudit.cvResult.labelOverlap"    : labelOverlap     ?? null,
          "surpriseAudit.cvResult.verdict"         : verdict          ?? null,
          "surpriseAudit.cvResult.processedAt"     : now,
        },
        $push: {
          auditLog: {
            action: layoutMismatch ? "AUDIT_LAYOUT_MISMATCH" : "AUDIT_CV_PASSED",
            detail:
              `Similarity: ${similarityScore?.toFixed(1)}% | ` +
              `Mismatch: ${layoutMismatch} | ` +
              `Label overlap: ${((labelOverlap ?? 0) * 100).toFixed(0)}% | ` +
              `Verdict: ${verdict}`,
          },
        },
      }
    );

    io.emit("audit_state_changed", {
      sessionId,
      auditStatus    : finalAuditStatus,
      sessionStatus  : finalSessionStatus,
      similarityScore,
      layoutMismatch,
      verdict,
      timestamp      : now.toISOString(),
    });

    console.log(
      `[audit/cv-result] ${sessionId} → auditStatus: ${finalAuditStatus} | ` +
      `similarity: ${similarityScore?.toFixed(1)}% | mismatch: ${layoutMismatch}`
    );

    res.json({
      success         : true,
      sessionId,
      auditStatus     : finalAuditStatus,
      sessionStatus   : finalSessionStatus,
      similarityScore,
      layoutMismatch,
    });

  } catch (err) {
    console.error("[POST /audit/cv-result]", err);
    res.status(500).json({ error: "Failed to record CV result", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/audit/:sessionId/status
//  Used by the mobile app and dashboard to poll audit state.
//  Also used by auditLambda.mjs to fetch anchorFrameKeys.
// ─────────────────────────────────────────────────────────────────
router.get("/:sessionId/status", async (req, res) => {
  try {
    const session = await Session.findOne(
      { sessionId: req.params.sessionId },
      { sessionId: 1, status: 1, businessName: 1, surpriseAudit: 1 }
    );

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const sa  = session.surpriseAudit;
    const now = new Date();
    const msRemaining = sa?.auditDeadline
      ? Math.max(0, new Date(sa.auditDeadline).getTime() - now.getTime())
      : null;

    res.json({
      sessionId      : session.sessionId,
      sessionStatus  : session.status,
      businessName   : session.businessName,
      auditStatus    : sa?.auditStatus      ?? null,
      auditDeadline  : sa?.auditDeadline    ?? null,
      triggeredAt    : sa?.triggeredAt      ?? null,
      submittedAt    : sa?.submittedAt      ?? null,
      triggeredBy    : sa?.triggeredBy      ?? null,
      anchorFrameKeys: sa?.anchorFrameKeys  ?? [],
      msRemaining,
      hoursRemaining : msRemaining != null ? (msRemaining / MS_PER_HOUR).toFixed(2) : null,
      cvResult       : sa?.cvResult         ?? null,
    });

  } catch (err) {
    console.error("[GET /audit/:id/status]", err);
    res.status(500).json({ error: "Failed to fetch audit status" });
  }
});

export default router;