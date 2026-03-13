// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Sessions Routes
//  routes/sessions.js
// ═══════════════════════════════════════════════════════════════
import express   from "express";
import Session   from "../models/Session.js";
import Business  from "../models/Business.js";
import { io }    from "../index.js";
import {
  haversineDistance,
  computeInfraScore,
  computeSignageScore,
  computeTrustScore,
  deriveStatus,
  GEO_DISTANCE_THRESHOLD_METRES,
} from "../config/scoring.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions
//  Called by React Native app when verification starts.
//  Creates a PENDING session and immediately computes geo score.
// ─────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      sessionId, businessId, businessName,
      gpsStart, gpsEnd, device, isRooted,
      accelerometer, appVersion,
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

    // Look up registered address for this business
    let registeredCoords  = null;
    let registeredAddress = "";
    const business = await Business.findOne({ businessId });

    if (business) {
      registeredCoords  = { lat: business.registeredAddress.lat, lng: business.registeredAddress.lng };
      registeredAddress = business.registeredAddress.fullText || "";
    } else {
      // Hackathon fallback — use mock Bengaluru address
      registeredCoords  = { lat: 12.9716, lng: 77.5946 };
      registeredAddress = "Mock: Bengaluru, Karnataka";
    }

    // Compute geo score
    let geoScore          = 0;
    let gpsDistanceMetres = null;

    if (gpsStart && registeredCoords) {
      gpsDistanceMetres = haversineDistance(gpsStart, registeredCoords);
      geoScore          = gpsDistanceMetres <= GEO_DISTANCE_THRESHOLD_METRES ? 1 : 0;
    }

    // Create session in DB
    const session = await Session.create({
      sessionId, businessId, businessName, registeredAddress,
      status: "PENDING",
      geoScore,
      gpsDistanceMetres,
      meta: {
        device,
        isRooted    : isRooted ?? false,
        gpsStart,
        gpsEnd,
        accelerometer: accelerometer?.slice(0, 300) ?? [],
        appVersion,
      },
      auditLog: [{
        action: "SESSION_CREATED",
        detail: `GPS distance: ${gpsDistanceMetres?.toFixed(0) ?? "unknown"}m. Geo score: ${geoScore}`,
      }],
    });

    // If geo fails → flag immediately without waiting for AI
    if (geoScore === 0) {
      await Session.findOneAndUpdate(
        { sessionId },
        {
          $set : { status: "FLAGGED", trustScore: 0 },
          $push: { auditLog: { action: "GEO_FAIL_FLAGGED", detail: `Distance ${gpsDistanceMetres?.toFixed(0)}m exceeds 100m threshold` } },
        }
      );
      io.emit("session_flagged_geo", { sessionId, businessId, businessName, gpsDistanceMetres, status: "FLAGGED" });
    }

    res.status(201).json({
      success           : true,
      sessionId         : session.sessionId,
      geoScore,
      gpsDistanceMetres : gpsDistanceMetres ? parseFloat(gpsDistanceMetres.toFixed(1)) : null,
      immediatelyFlagged: geoScore === 0,
    });

  } catch (err) {
    console.error("[POST /sessions]", err);
    if (err.code === 11000) {
      return res.status(409).json({ error: "Session ID already exists" });
    }
    res.status(500).json({ error: "Failed to create session", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions/ai-result
//  Called by AWS Lambda after Rekognition completes.
//
//  THE KEY FIX:
//  Use $set for all score fields SEPARATELY from $push.
//  Mixing bare fields with $push causes Mongoose to silently
//  drop signScore and infraScore — they never save to MongoDB.
// ─────────────────────────────────────────────────────────────────
router.post("/ai-result", async (req, res) => {
  try {
    const {
      s3Key,
      textDetected,
      labels,
      infraScore     : lambdaInfraScore,
      isFlagged      : lambdaFlagged,
      livenessResult,
      sessionId      : sessionIdFromBody,
    } = req.body;

    // ── Resolve sessionId — 3 fallback methods ────────────────────
    let sessionId = sessionIdFromBody || null;

    if (!sessionId && s3Key) {
      // Parse from "thumbnails/sess_1773385489536_ia31z_1234567890.jpg"
      const filename   = s3Key.split("/").pop();
      const withoutExt = filename.split(".")[0];
      const parts      = withoutExt.split("_");
      // parts = ["sess","1773385489536","ia31z","1234567890"]
      // slice(0,-1) removes last timestamp → ["sess","1773385489536","ia31z"]
      if (parts.length >= 3) {
        sessionId = parts.slice(0, -1).join("_");
      }
    }

    // ── Test mode — no sessionId found ────────────────────────────
    if (!sessionId) {
      console.warn(`[ai-result] Could not extract sessionId from s3Key: ${s3Key}`);
      const iVal       = lambdaInfraScore || 0;
      const sVal       = 0.2;
      const trustScore = Math.round((0 * 0.4 + sVal * 0.3 + iVal * 0.3) * 100);
      const status     = trustScore >= 70 ? "PASSED" : trustScore >= 40 ? "REVIEW" : "FLAGGED";
      return res.json({ success: true, testMode: true, trustScore, status, textDetected, labels, infraScore: iVal, isFlagged: lambdaFlagged });
    }

    console.log(`[ai-result] sessionId: ${sessionId} | text: "${textDetected}" | labels: ${labels?.join(", ")}`);

    // ── Find session ──────────────────────────────────────────────
    const session = await Session.findOne({ sessionId });

    if (!session) {
      console.warn(`[ai-result] Session not found in DB: ${sessionId}`);
      const iVal       = lambdaInfraScore || 0;
      const sVal       = textDetected && textDetected !== "NONE" ? 0.85 : 0.2;
      const trustScore = Math.round((0 * 0.4 + sVal * 0.3 + iVal * 0.3) * 100);
      const status     = trustScore >= 70 ? "PASSED" : trustScore >= 40 ? "REVIEW" : "FLAGGED";
      return res.json({ success: true, testMode: true, message: `Session ${sessionId} not in DB`, trustScore, status });
    }

    // ── Compute all 3 scores ──────────────────────────────────────

    // signScore: compare Rekognition detected text vs business name from DB
    // e.g. "Global Tech" in frame vs businessName "Global Tech Solutions Pvt Ltd"
    const signScore  = computeSignageScore(textDetected, session.businessName);

    // infraScore: recompute from labels (more reliable than Lambda's value)
    const { score: infraScore, flagged: labelFlagged } = computeInfraScore(labels ?? []);

    // isFlagged: residential labels (Bed, Sofa etc) OR Lambda flagged it
    const isFlagged  = lambdaFlagged || labelFlagged;

    // trustScore: G×0.4 + S×0.3 + I×0.3
    const trustScore = computeTrustScore({ geoScore: session.geoScore, signScore, infraScore });

    const status = deriveStatus(trustScore, isFlagged, session.geoScore);

    console.log(`[ai-result] geo:${session.geoScore} | sign:${signScore.toFixed(2)} | infra:${infraScore.toFixed(2)} → trust:${trustScore} | status:${status}`);

    // ── THE FIX: Use $set + $push separately ─────────────────────
    // NEVER mix bare fields with $push — Mongoose silently drops them.
    // $set guarantees signScore and infraScore are written to MongoDB.
    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          status,
          trustScore,
          signScore :  parseFloat(signScore.toFixed(4)),   // ← top-level, always saved
          infraScore:  parseFloat(infraScore.toFixed(4)),  // ← top-level, always saved
          s3ThumbUri:  s3Key,
          // Mirror inside aiResults for reference
          "aiResults.textDetected"  : textDetected   ?? "NONE",
          "aiResults.labels"        : labels          ?? [],
          "aiResults.infraScore"    : parseFloat(infraScore.toFixed(4)),
          "aiResults.livenessResult": livenessResult  ?? "UNKNOWN",
          "aiResults.isFlagged"     : isFlagged,
        },
        $push: {
          auditLog: {
            action: "AI_RESULT_RECEIVED",
            detail: `trust:${trustScore} | status:${status} | geo:${session.geoScore} | sign:${signScore.toFixed(2)} | infra:${infraScore.toFixed(2)} | labels: ${labels?.join(", ")} | text: "${textDetected}"`,
          },
        },
      },
      { new: true }
    );

    // ── Update business record ────────────────────────────────────
    await Business.findOneAndUpdate(
      { businessId: session.businessId },
      {
        $set: {
          lastVerifiedAt: new Date(),
          lastTrustScore: trustScore,
          overallStatus : status,
        },
      }
    );

    // ── Emit to dashboard + mobile ────────────────────────────────
    io.emit("session_complete", {
      sessionId,
      businessId  : session.businessId,
      businessName: session.businessName,
      trustScore,
      status,
      labels      : labels ?? [],
      textDetected,
      signScore   : parseFloat(signScore.toFixed(2)),
      infraScore  : parseFloat(infraScore.toFixed(2)),
      geoScore    : session.geoScore,
      isFlagged,
      timestamp   : new Date().toISOString(),
    });

    console.log(`[ai-result] ✅ Saved to MongoDB — sign:${signScore.toFixed(2)} infra:${infraScore.toFixed(2)}`);

    res.json({ success: true, sessionId, trustScore, status, signScore, infraScore });

  } catch (err) {
    console.error("[POST /sessions/ai-result]", err);
    res.status(500).json({ error: "Failed to process AI result", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions/patch-scores
//  One-time fix: backfills signScore + infraScore for old sessions
//  that were saved before the $set fix.
//  Call once from Postman then delete this route.
// ─────────────────────────────────────────────────────────────────
router.post("/patch-scores", async (req, res) => {
  try {
    const sessions = await Session.find({
      trustScore : { $ne: null },
      $or: [
        { signScore : { $exists: false } },
        { signScore : null },
        { infraScore: { $exists: false } },
        { infraScore: null },
      ],
    });

    let fixed = 0;
    for (const s of sessions) {
      const infra = s.aiResults?.infraScore ?? 0;
      const sign  = computeSignageScore(
        s.aiResults?.textDetected ?? "NONE",
        s.businessName ?? ""
      );
      await Session.findByIdAndUpdate(s._id, {
        $set: {
          signScore : parseFloat(sign.toFixed(4)),
          infraScore: parseFloat(infra.toFixed(4)),
        },
      });
      console.log(`Patched ${s.sessionId} → sign:${sign.toFixed(2)} infra:${infra.toFixed(2)}`);
      fixed++;
    }

    res.json({ success: true, fixed, message: `Patched ${fixed} sessions` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions
// ─────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { status, businessId, limit = 100, offset = 0, sortBy = "createdAt", order = "desc" } = req.query;

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
    if (!session) {
      return res.status(404).json({ error: `Session not found: ${req.params.id}` });
    }
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
      $push: { auditLog: { action: "MANUAL_REVIEW", detail: `Reviewed by ${reviewedBy}. Notes: ${notes}. Status: ${newStatus ?? "unchanged"}` } },
    };

    if (newStatus) update.$set.status = newStatus;

    const session = await Session.findOneAndUpdate({ sessionId: req.params.id }, update, { new: true });
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

export default router;