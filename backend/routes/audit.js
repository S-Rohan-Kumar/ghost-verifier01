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
//    GET  /api/audit/pending              → check pending audit by businessId
//
//  Exported function (not a route):
//    autoTriggerAudit(sessionId, anchorS3Key)  ← called by sessions.js
//
//  FIX: setImmediate(() => runCvAnalysis(...)) has been REMOVED from the
//  submit route. The backend was running its own CV analysis in parallel
//  with the S3-triggered auditLambda.mjs, creating a race condition where
//  whichever finished last would overwrite the DB — often the backend's
//  analysis (which ran against the still-uploading 0-byte object) would
//  win and incorrectly REJECT a legitimate audit. auditLambda.mjs is the
//  sole CV processor. runCvAnalysis() is kept as a named export for use
//  in tests and manual admin tooling only.
// ═══════════════════════════════════════════════════════════════
import express from "express";
import Session from "../models/Session.js";
import { io }  from "../index.js";
import {
  RekognitionClient,
  DetectLabelsCommand,
  CompareFacesCommand,
} from "@aws-sdk/client-rekognition";

const rek    = new RekognitionClient({ region: process.env.AWS_REGION || "ap-south-1" });
const BUCKET = process.env.S3_BUCKET;

const LAYOUT_MISMATCH_THRESHOLD = 75;
const MIN_FACE_SIMILARITY       = 70;

const SCENE_LABELS = new Set([
  "Desk","Table","Chair","Bookcase","Filing Cabinet","Whiteboard","Computer",
  "Monitor","Keyboard","Mouse","Printer","Laptop","Screen","Office",
  "Conference Room","Window","Door","Wall","Floor","Ceiling","Indoors",
  "Sign","Furniture","Electronics",
]);

function sceneFilter(labels) {
  return labels.filter(l => SCENE_LABELS.has(l));
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a), setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 100 : (intersection / union) * 100;
}

async function compareFaces(bucket, anchorKey, auditKey) {
  try {
    const res = await rek.send(new CompareFacesCommand({
      SourceImage        : { S3Object: { Bucket: bucket, Name: anchorKey } },
      TargetImage        : { S3Object: { Bucket: bucket, Name: auditKey  } },
      SimilarityThreshold: MIN_FACE_SIMILARITY,
    }));
    return res.FaceMatches?.[0]?.Similarity ?? null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────
//  runCvAnalysis — kept for manual admin use / tests only.
//  NOT called automatically on submit — auditLambda.mjs handles that.
//  Calling this in parallel with the Lambda caused a race condition
//  where the backend (working against a 0-byte S3 object that was
//  still uploading) would overwrite the Lambda's correct result.
// ─────────────────────────────────────────────────────────────────
export async function runCvAnalysis(sessionId, auditThumbKey) {
  const startMs = Date.now();
  console.log(`[CvAnalysis] ${sessionId} | thumb: ${auditThumbKey ?? "none"}`);
  try {
    const session = await Session.findOne({ sessionId });
    if (!session) { console.error(`[CvAnalysis] Session not found: ${sessionId}`); return; }

    const anchorFrameKeys = session.surpriseAudit?.anchorFrameKeys ?? [];
    const originalLabels  = session.aiResults?.labels ?? [];

    let auditLabels = [];
    if (auditThumbKey && BUCKET) {
      try {
        const res = await rek.send(new DetectLabelsCommand({
          Image: { S3Object: { Bucket: BUCKET, Name: auditThumbKey } },
          MaxLabels: 30, MinConfidence: 60, Features: ["GENERAL_LABELS"],
        }));
        auditLabels = (res.Labels ?? []).map(l => l.Name);
        console.log(`[CvAnalysis] Audit labels: ${auditLabels.join(", ")}`);
      } catch (err) {
        console.warn(`[CvAnalysis] DetectLabels failed: ${err.message}`);
      }
    }

    const auditScene          = sceneFilter(auditLabels);
    const originalScene       = sceneFilter(originalLabels);
    const labelOverlap        = jaccardSimilarity(originalScene, auditScene) / 100;
    const labelSimilarityScore = labelOverlap * 100;
    const newLabels            = auditScene.filter(l => !originalScene.includes(l));
    const missingLabels        = originalScene.filter(l => !auditScene.includes(l));

    const frameComparisons = [];
    let faceSimilaritySum = 0, faceCount = 0;

    if (auditThumbKey && BUCKET) {
      for (const anchorKey of anchorFrameKeys) {
        const faceSim = await compareFaces(BUCKET, anchorKey, auditThumbKey);
        if (faceSim !== null) {
          faceSimilaritySum += faceSim; faceCount++;
          frameComparisons.push({ anchorKey, similarityScore: faceSim, matchMethod: "FEATURE_MATCH" });
        } else {
          frameComparisons.push({ anchorKey, similarityScore: labelSimilarityScore, matchMethod: "LABEL_JACCARD" });
        }
      }
    }

    let similarityScore = faceCount > 0
      ? (faceSimilaritySum / faceCount) * 0.6 + labelSimilarityScore * 0.4
      : labelSimilarityScore;
    similarityScore = parseFloat(similarityScore.toFixed(1));

    const layoutMismatch = similarityScore < LAYOUT_MISMATCH_THRESHOLD;
    const verdict =
      similarityScore >= 75 ? "HIGH_CONFIDENCE_MATCH — premises appear consistent" :
      similarityScore >= 50 ? "LOW_CONFIDENCE_MATCH — some differences, manual review recommended" :
      similarityScore >= 25 ? "LAYOUT_MISMATCH — significant differences from original premises" :
                              "COMPLETE_MISMATCH — no visual continuity with original session";

    const finalAuditStatus   = layoutMismatch ? "REJECTED" : "PASSED";
    const finalSessionStatus = layoutMismatch ? "FLAGGED"  : session.status;
    const now                = new Date();

    await Session.findOneAndUpdate({ sessionId }, {
      $set: {
        status                                   : finalSessionStatus,
        "surpriseAudit.auditStatus"              : finalAuditStatus,
        "surpriseAudit.cvResult.similarityScore" : similarityScore,
        "surpriseAudit.cvResult.layoutMismatch"  : layoutMismatch,
        "surpriseAudit.cvResult.frameComparisons": frameComparisons,
        "surpriseAudit.cvResult.newLabels"       : newLabels,
        "surpriseAudit.cvResult.missingLabels"   : missingLabels,
        "surpriseAudit.cvResult.labelOverlap"    : labelOverlap,
        "surpriseAudit.cvResult.verdict"         : verdict,
        "surpriseAudit.cvResult.processedAt"     : now,
      },
      $push: { auditLog: {
        action: layoutMismatch ? "AUDIT_LAYOUT_MISMATCH" : "AUDIT_CV_PASSED",
        detail: `Similarity: ${similarityScore}% | ${verdict} | ${Date.now()-startMs}ms`,
      }},
    });

    io.emit("audit_state_changed", {
      sessionId, auditStatus: finalAuditStatus, sessionStatus: finalSessionStatus,
      similarityScore, layoutMismatch, verdict, timestamp: now.toISOString(),
    });

    console.log(`[CvAnalysis] DONE ${sessionId} → ${finalAuditStatus} | ${similarityScore}%`);
  } catch (err) {
    console.error(`[CvAnalysis] Error for ${sessionId}:`, err.message);
  }
}

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
    businessId   : session.businessId,
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
//  thumbnail + video to S3.
//  Moves auditStatus → SUBMITTED.
//  The S3 PutObject event on audit-thumbnails/ fires auditLambda.mjs
//  automatically — that Lambda is the sole CV processor.
//
//  FIX: setImmediate(() => runCvAnalysis(...)) has been REMOVED.
//  Running backend CV in parallel with the Lambda caused a race:
//    1. App submits → backend runCvAnalysis fires immediately
//    2. auditThumbKey may not yet be in S3 (XHR still in flight)
//    3. Backend Rekognition call gets 0-byte or missing object → 0% score → REJECTED
//    4. Lambda fires seconds later with the real image → correct score
//    5. But the backend result already overwrote the DB → wrong verdict
//  The Lambda alone is the source of truth for CV results.
// ─────────────────────────────────────────────────────────────────
router.post("/:sessionId/submit", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { auditS3ThumbUri, auditS3VideoUri, gps } = req.body;

    const session = await Session.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const auditStatus = session.surpriseAudit?.auditStatus;

    // No active audit at all
    if (!auditStatus) {
      return res.status(400).json({ error: `No active audit found for session "${sessionId}"` });
    }

    // Lambda already finished before the app called /submit.
    // This happens when video upload is slow — thumbnail lands in S3,
    // Lambda runs and writes PASSED/REJECTED, then the app finishes
    // uploading the video and POSTs here. Don't return 400 — just save
    // the video key + GPS and return success so the app closes normally.
    if (auditStatus === "PASSED" || auditStatus === "REJECTED") {
      const now = new Date();
      await Session.findOneAndUpdate(
        { sessionId },
        {
          $set: {
            ...(auditS3VideoUri ? { "surpriseAudit.auditS3VideoUri": auditS3VideoUri } : {}),
            ...(gps?.lat && gps?.lng ? { "surpriseAudit.auditGps": gps } : {}),
          },
          $push: {
            auditLog: {
              action: "AUDIT_SUBMIT_LATE",
              detail: `App submitted after Lambda already finished (${auditStatus}). Video key stored.`,
            },
          },
        }
      );
      console.log(`[audit/submit] Lambda already finished (${auditStatus}) — returning success to app`);
      return res.json({
        success    : true,
        sessionId,
        auditStatus,
        message    : "Audit already processed. Result is ready.",
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
          // Store audit GPS if provided
          ...(gps?.lat && gps?.lng ? {
            "surpriseAudit.auditGps": { lat: gps.lat, lng: gps.lng },
          } : {}),
        },
        $push: {
          auditLog: {
            action: "AUDIT_SUBMITTED",
            detail: `Audit submitted. Thumb: ${auditS3ThumbUri ?? "none"}. Video: ${auditS3VideoUri ?? "none"}. Lambda CV analysis triggered via S3 event.`,
          },
        },
      }
    );

    io.emit("audit_state_changed", {
      sessionId,
      auditStatus: "SUBMITTED",
      submittedAt: now.toISOString(),
    });

    console.log(`[audit/submit] SUBMITTED — ${sessionId} | thumb: ${auditS3ThumbUri ?? "none"} | video: ${auditS3VideoUri ?? "none"}`);

    res.json({
      success    : true,
      sessionId,
      auditStatus: "SUBMITTED",
      message    : "Audit received. Visual analysis is running via Lambda — result will arrive shortly.",
    });

    // ── NO setImmediate(runCvAnalysis) here ──────────────────────
    // auditLambda.mjs fires automatically when the thumbnail lands in
    // audit-thumbnails/ on S3. Running a second analysis here in parallel
    // caused a race condition that corrupted the final verdict.
    // See file header for full explanation.

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
//  GET /api/audit/pending?businessId=xxx
//  Called by AuditOverlay on app mount to check whether this business
//  has a live audit that was triggered while the app was closed.
//  Returns the most recent non-terminal audit session, or 404.
//  Non-terminal: REQUESTED | WARNING | REVIEW_PENDING
// ─────────────────────────────────────────────────────────────────
router.get("/pending", async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) {
      return res.status(400).json({ error: "businessId query param required" });
    }

    // SUBMITTED is excluded — business has already done their part
    const LIVE_STATUSES = ["REQUESTED", "WARNING", "REVIEW_PENDING"];

    const session = await Session.findOne(
      {
        businessId,
        "surpriseAudit.auditStatus": { $in: LIVE_STATUSES },
      },
      { sessionId: 1, businessId: 1, businessName: 1, surpriseAudit: 1 }
    ).sort({ "surpriseAudit.triggeredAt": -1 });

    if (!session) {
      return res.status(404).json({ pending: false });
    }

    const sa  = session.surpriseAudit;
    const now = new Date();
    const msRemaining = sa?.auditDeadline
      ? Math.max(0, new Date(sa.auditDeadline).getTime() - now.getTime())
      : null;

    res.json({
      pending      : true,
      sessionId    : session.sessionId,
      businessId   : session.businessId,
      businessName : session.businessName,
      auditStatus  : sa.auditStatus,
      auditDeadline: sa.auditDeadline,
      triggeredAt  : sa.triggeredAt,
      msRemaining,
      message      : "A surprise audit is pending. Please re-record at the same premises.",
    });

  } catch (err) {
    console.error("[GET /audit/pending]", err);
    res.status(500).json({ error: "Failed to check pending audit" });
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