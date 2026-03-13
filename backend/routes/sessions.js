// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Sessions Routes
//  routes/sessions.js
//
//  ✅ gpsDistanceMetres + registeredAddress saved to DB
//  ✅ signScore uses fuzzy word matching
//  ✅ PATCH /review uses $set correctly (no MongoServerError)
//  ✅ Layer 1 — Liveness enforcement (SPOOF_DETECTED / SUSPICIOUS)
//  ✅ Layer 2 — Accelerometer / motion analysis
//  ✅ Layer 3 — Screen recording enforcement
// ═══════════════════════════════════════════════════════════════
import express  from "express";
import Session  from "../models/Session.js";
import Business from "../models/Business.js";
import { io }   from "../index.js";
import {
  haversineDistance,
  computeSignageScore,
  computeTrustScore,
  deriveStatus,
  GEO_DISTANCE_THRESHOLD_METRES,
} from "../config/scoring.js";
import { analyseAccelerometer } from "../config/accelerometer.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions
//  Called by React Native app when verification starts.
//  Creates a PENDING session, computes geo score AND Layer 2
//  accelerometer score immediately (both arrive with the first request,
//  before the video is uploaded to S3).
// ─────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      sessionId,
      businessId,
      businessName,
      gpsStart,
      gpsEnd,
      device,
      isRooted,
      accelerometer,
      appVersion,
    } = req.body;

    if (!sessionId || !businessId) {
      return res.status(400).json({ error: "sessionId and businessId are required" });
    }

    if (isRooted === true) {
      return res.status(403).json({
        error  : "DEVICE_COMPROMISED",
        message: "Verification blocked: rooted/jailbroken device detected",
      });
    }

    // ── Look up registered address ────────────────────────────────
    let registeredCoords  = null;
    let registeredAddress = "";
    const business = await Business.findOne({ businessId });

    if (business) {
      registeredCoords  = { lat: business.registeredAddress.lat, lng: business.registeredAddress.lng };
      registeredAddress = business.registeredAddress.fullText || "";
    } else {
      registeredCoords  = { lat: 12.9716, lng: 77.5946 };
      registeredAddress = "Mock: Bengaluru, Karnataka";
    }

    // ── Geo score ─────────────────────────────────────────────────
    let geoScore          = 0;
    let gpsDistanceMetres = null;

    if (gpsStart && registeredCoords) {
      gpsDistanceMetres = haversineDistance(gpsStart, registeredCoords);
      geoScore = gpsDistanceMetres <= GEO_DISTANCE_THRESHOLD_METRES ? 1 : 0;
    }

    // ── Layer 2: Accelerometer analysis ──────────────────────────
    // Runs at session creation — accelerometer data arrives with GPS
    // before the video is even uploaded to S3.
    const motionAnalysis = analyseAccelerometer(accelerometer);
    const motionScore    = motionAnalysis.motionScore;

    console.log(
      `[Layer 2] ${sessionId} → ${motionAnalysis.result} | ` +
      `score=${motionScore} | ${motionAnalysis.detail}`
    );

    // ── Build initial audit log ───────────────────────────────────
    const auditLog = [
      {
        action: "SESSION_CREATED",
        detail: `GPS distance: ${gpsDistanceMetres?.toFixed(0) ?? "unknown"}m. Geo score: ${geoScore}`,
      },
      {
        action: "ACCELEROMETER_ANALYSED",
        detail: `Motion — ${motionAnalysis.result}: ${motionAnalysis.detail}`,
      },
    ];

    if (motionAnalysis.result === "STATIONARY") {
      auditLog.push({
        action: "MOTION_FAIL",
        detail: `Phone stationary (variance=${motionAnalysis.stats?.overallVariance}). Flagged for possible desk-mounted recording.`,
      });
    }

    // ── Create session ────────────────────────────────────────────
    const session = await Session.create({
      sessionId,
      businessId,
      businessName,
      registeredAddress,
      status           : "PENDING",
      geoScore,
      gpsDistanceMetres,
      motionScore,
      meta: {
        device,
        isRooted      : isRooted ?? false,
        gpsStart,
        gpsEnd,
        appVersion,
        accelerometer : accelerometer?.slice(0, 300) ?? [],
        motionAnalysis: {
          result: motionAnalysis.result,
          detail: motionAnalysis.detail,
          stats : motionAnalysis.stats,
        },
      },
      auditLog,
    });

    // ── Geo fail → flag immediately ───────────────────────────────
    if (geoScore === 0) {
      await Session.findOneAndUpdate(
        { sessionId },
        {
          status    : "FLAGGED",
          trustScore: 0,
          $push: {
            auditLog: {
              action: "GEO_FAIL_FLAGGED",
              detail: `Distance ${gpsDistanceMetres?.toFixed(0)}m exceeds ${GEO_DISTANCE_THRESHOLD_METRES}m threshold`,
            },
          },
        }
      );
      io.emit("session_flagged_geo", { sessionId, businessId, businessName, gpsDistanceMetres, status: "FLAGGED" });
    }

    // ── Motion fail → pre-flag (stationary = suspicious) ─────────
    if (motionAnalysis.result === "STATIONARY" && geoScore !== 0) {
      await Session.findOneAndUpdate(
        { sessionId },
        {
          status: "FLAGGED",
          $push: {
            auditLog: {
              action: "MOTION_FAIL_FLAGGED",
              detail: `Stationary device detected before AI analysis. Pre-flagged pending review.`,
            },
          },
        }
      );
      io.emit("session_flagged_motion", {
        sessionId, businessId, businessName,
        motionResult: motionAnalysis.result,
        status      : "FLAGGED",
      });
    }

    res.status(201).json({
      success           : true,
      sessionId         : session.sessionId,
      geoScore,
      gpsDistanceMetres : gpsDistanceMetres ? parseFloat(gpsDistanceMetres.toFixed(1)) : null,
      motionScore,
      motionResult      : motionAnalysis.result,
      immediatelyFlagged: geoScore === 0 || motionAnalysis.result === "STATIONARY",
    });

  } catch (err) {
    console.error("[POST /sessions]", err);
    if (err.code === 11000) return res.status(409).json({ error: "Session ID already exists" });
    res.status(500).json({ error: "Failed to create session", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions/ai-result
//  Called by AWS Lambda after Rekognition analysis completes.
//  Lambda now sends: processingMs field (used for audit log).
//  motionScore already on the session from POST / above.
// ─────────────────────────────────────────────────────────────────
router.post("/ai-result", async (req, res) => {
  try {
    const {
      s3Key,
      textDetected,
      labels,
      infraScore,
      isFlagged       : isFlaggedFromLambda,
      livenessResult,
      livenessDetail,
      screenRecording,
      processingMs,                    // ← new from updated Lambda
      sessionId       : sessionIdFromBody,
    } = req.body;

    // ── Resolve sessionId ─────────────────────────────────────────
    let sessionId = null;

    if (sessionIdFromBody) {
      sessionId = sessionIdFromBody;
    }

    if (!sessionId && s3Key) {
      const filename       = s3Key.split("/").pop();
      const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
      const lastUnderscore = nameWithoutExt.lastIndexOf("_");
      if (lastUnderscore > 0) sessionId = nameWithoutExt.substring(0, lastUnderscore);
    }

    // Anonymous test mode
    if (!sessionId) {
      console.warn(`[ai-result] Could not extract sessionId from s3Key: ${s3Key}`);
      const infraScoreVal = infraScore || 0;
      const signScore     = computeSignageScore(textDetected, "");
      const geoScore      = 0;
      const isFlagged     = isFlaggedFromLambda ?? false;
      const trustScore    = computeTrustScore({ geoScore, signScore, infraScore: infraScoreVal });
      const status        = deriveStatus(trustScore, isFlagged, geoScore);
      return res.json({ success: true, testMode: true, trustScore, status, textDetected, labels, infraScore: infraScoreVal, signScore, isFlagged });
    }

    const session = await Session.findOne({ sessionId });

    if (!session) {
      console.warn(`[ai-result] Session not found in DB: ${sessionId}`);
      const infraScoreVal = infraScore || 0;
      const signScore     = computeSignageScore(textDetected, "");
      const geoScore      = 0;
      const isFlagged     = isFlaggedFromLambda ?? false;
      const trustScore    = computeTrustScore({ geoScore, signScore, infraScore: infraScoreVal });
      const status        = deriveStatus(trustScore, isFlagged, geoScore);
      return res.json({ success: true, testMode: true, message: `Session ${sessionId} not in DB`, trustScore, status, textDetected, labels, infraScore: infraScoreVal, signScore, isFlagged });
    }

    // ── Full scoring ──────────────────────────────────────────────
    const signScore     = computeSignageScore(textDetected, session.businessName);
    const infraScoreVal = infraScore || 0;

    // ── Layer 1: Liveness ─────────────────────────────────────────
    const livenessIsFlagged =
      livenessResult === "SPOOF_DETECTED" || livenessResult === "SUSPICIOUS";

    // ── Layer 3: Screen recording ─────────────────────────────────
    const screenIsFlagged = screenRecording?.isScreenRecording === true;

    // ── Layer 2: Motion (already computed at POST /) ──────────────
    const motionScore     = session.motionScore ?? null;
    const motionIsFlagged = session.meta?.motionAnalysis?.result === "STATIONARY";

    const isFlagged = isFlaggedFromLambda || livenessIsFlagged || screenIsFlagged || motionIsFlagged;

    // Zero video-derived scores if video authenticity is compromised
    const videoTrusted        = !livenessIsFlagged && !screenIsFlagged;
    const effectiveSignScore  = videoTrusted ? signScore      : 0;
    const effectiveInfraScore = videoTrusted ? infraScoreVal  : 0;
    const effectiveMotionScore = motionIsFlagged ? 0 : motionScore;

    const trustScore = computeTrustScore({
      geoScore  : session.geoScore,
      signScore : effectiveSignScore,
      infraScore: effectiveInfraScore,
      motionScore: effectiveMotionScore,
    });

    const status = deriveStatus(trustScore, isFlagged, session.geoScore);

    // ── Audit entries ─────────────────────────────────────────────
    const auditEntries = [];

    if (livenessIsFlagged) {
      auditEntries.push({
        action: "LIVENESS_FAIL",
        detail: `Liveness — ${livenessResult}: ${livenessDetail ?? ""}`,
      });
    }

    if (screenIsFlagged) {
      auditEntries.push({
        action: "SCREEN_RECORDING_DETECTED",
        detail: `Screen — ${screenRecording.confidence}: ${screenRecording.reason}`,
      });
    }

    auditEntries.push({
      action: "AI_RESULT_RECEIVED",
      detail:
        `Score: ${trustScore} | Status: ${status} | ` +
        `Sign: ${effectiveSignScore.toFixed(2)} | Infra: ${effectiveInfraScore} | ` +
        `Motion: ${effectiveMotionScore?.toFixed(2) ?? "N/A"} | ` +
        `Liveness: ${livenessResult ?? "N/A"} | ` +
        `Screen: ${screenIsFlagged ? screenRecording.confidence : "CLEAR"} | ` +
        `Lambda: ${processingMs ?? "?"}ms | ` +
        `Labels: ${labels?.join(", ")}`,
    });

    // ── Persist ───────────────────────────────────────────────────
    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          status,
          trustScore,
          signScore : effectiveSignScore,
          infraScore: effectiveInfraScore,
          s3ThumbUri: s3Key,
          aiResults : {
            textDetected,
            labels,
            infraScore    : effectiveInfraScore,
            livenessResult: livenessResult ?? "UNKNOWN",
            livenessDetail: livenessDetail ?? "",
            isFlagged,
            screenRecording: {
              detected  : screenIsFlagged,
              confidence: screenRecording?.confidence ?? null,
              reason    : screenRecording?.reason     ?? null,
            },
          },
        },
        $push: {
          auditLog: { $each: auditEntries },
        },
      },
      { new: true }
    );

    io.emit("session_complete", {
      sessionId,
      trustScore,
      status,
      labels         : labels ?? [],
      textDetected,
      infraScore     : effectiveInfraScore,
      signScore      : effectiveSignScore,
      geoScore       : session.geoScore,
      motionScore    : effectiveMotionScore,
      isFlagged,
      livenessResult,
      screenRecording: screenRecording ?? null,
      timestamp      : new Date().toISOString(),
    });

    console.log(
      `[ai-result] ✅ ${sessionId} → Score: ${trustScore} | Status: ${status} | ` +
      `Sign: ${effectiveSignScore.toFixed(2)} | Motion: ${effectiveMotionScore?.toFixed(2) ?? "N/A"} | ` +
      `Liveness: ${livenessResult ?? "N/A"} | Screen: ${screenIsFlagged ? "FLAGGED" : "CLEAR"} | ` +
      `Lambda: ${processingMs ?? "?"}ms`
    );

    res.json({
      success      : true,
      sessionId,
      trustScore,
      status,
      signScore    : effectiveSignScore,
      infraScore   : effectiveInfraScore,
      motionScore  : effectiveMotionScore,
      livenessResult,
      screenFlagged: screenIsFlagged,
    });

  } catch (err) {
    console.error("[POST /sessions/ai-result]", err);
    res.status(500).json({ error: "Failed to process AI result", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions
// ─────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      status,
      businessId,
      limit  = 100,
      offset = 0,
      sortBy = "createdAt",
      order  = "desc",
    } = req.query;

    const filter = {};
    if (status)     filter.status     = status;
    if (businessId) filter.businessId = businessId;

    const sessions = await Session.find(filter)
      .sort({ [sortBy]: order === "asc" ? 1 : -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .select("-auditLog -meta.accelerometer");

    const total = await Session.countDocuments(filter);
    res.json({ data: sessions, total, limit: Number(limit), offset: Number(offset) });

  } catch (err) {
    console.error("[GET /sessions]", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions/:id
// ─────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) return res.status(404).json({ error: `Session not found: ${req.params.id}` });
    res.json(session);
  } catch (err) {
    console.error("[GET /sessions/:id]", err);
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  PATCH /api/sessions/:id/review
// ─────────────────────────────────────────────────────────────────
router.patch("/:id/review", async (req, res) => {
  try {
    const { notes, reviewedBy, newStatus } = req.body;

    const update = {
      $set : { reviewNotes: notes, reviewedBy, reviewedAt: new Date() },
      $push: {
        auditLog: {
          action: "MANUAL_REVIEW",
          detail: `Reviewed by ${reviewedBy}. Notes: ${notes}. Status → ${newStatus ?? "unchanged"}`,
        },
      },
    };

    if (newStatus) update.$set.status = newStatus;

    const session = await Session.findOneAndUpdate(
      { sessionId: req.params.id },
      update,
      { new: true }
    );

    if (!session) return res.status(404).json({ error: "Session not found" });

    io.emit("session_reviewed", { sessionId: req.params.id, newStatus, reviewedBy });
    res.json({ success: true, session });

  } catch (err) {
    console.error("[PATCH /sessions/:id/review]", err);
    res.status(500).json({ error: "Failed to update review" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  DELETE /api/sessions/:id  (dev only)
// ─────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Delete not allowed in production" });
    }
    await Session.deleteOne({ sessionId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete session" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { gstNumber, name } = req.body;

    const business = await Business.findOne({ gstNumber, name });

    if (!business) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    return res.status(200).json({ 
      success: true, 
      businessId: business.businessId, 
      name: business.name 
    });

  } catch (err) {
    console.error("[POST /login]", err);
    res.status(500).json({ error: "Server error during login" });
  }
});


export default router;