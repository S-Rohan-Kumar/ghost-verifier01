// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Sessions Routes  (FIXED)
//  routes/sessions.js
// ═══════════════════════════════════════════════════════════════
import express  from "express";
import Session  from "../models/Session.js";
import Business from "../models/Business.js";
import { io }   from "../index.js";
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

    // Look up registered address
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

    // Compute geo score
    let geoScore          = 0;
    let gpsDistanceMetres = null;

    if (gpsStart && registeredCoords) {
      gpsDistanceMetres = haversineDistance(gpsStart, registeredCoords);
      geoScore = gpsDistanceMetres <= GEO_DISTANCE_THRESHOLD_METRES ? 1 : 0;
    }

    const session = await Session.create({
      sessionId,
      businessId,
      businessName,
      registeredAddress,
      status           : "PENDING",
      geoScore,
      gpsDistanceMetres,
      meta: {
        device,
        isRooted     : isRooted ?? false,
        gpsStart,
        gpsEnd,
        appVersion,
        accelerometer: accelerometer?.slice(0, 300) ?? [],
      },
      auditLog: [
        {
          action: "SESSION_CREATED",
          detail: `GPS distance: ${gpsDistanceMetres?.toFixed(0) ?? "unknown"}m. Geo score: ${geoScore}`,
        },
      ],
    });

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
//  Called by AWS Lambda after Rekognition analysis completes.
// ─────────────────────────────────────────────────────────────────
router.post("/ai-result", async (req, res) => {
  try {
    const {
      s3Key,
      textDetected,
      labels,
      infraScore,
      isFlagged,
      livenessResult,
      sessionId: sessionIdFromBody,
    } = req.body;

    // ── Resolve sessionId (3 methods) ────────────────────────────
    let sessionId = null;

    // Method 1: Lambda sends it directly (preferred)
    if (sessionIdFromBody) {
      sessionId = sessionIdFromBody;
    }

    // Method 2: Extract from s3Key → thumbnails/<sessionId>_<timestamp>.<ext>
    if (!sessionId && s3Key) {
      const filename       = s3Key.split("/").pop();
      const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
      const lastUnderscore = nameWithoutExt.lastIndexOf("_");
      if (lastUnderscore > 0) {
        sessionId = nameWithoutExt.substring(0, lastUnderscore);
      }
    }

    // Method 3: No sessionId at all — anonymous test mode
    if (!sessionId) {
      console.warn(`[ai-result] Could not extract sessionId from s3Key: ${s3Key}`);

      const infraScoreVal = infraScore || 0;
      // No businessName available — computeSignageScore("", "") returns 0.25 if text, 0.10 if none
      const signScore  = computeSignageScore(textDetected, "");
      const geoScore   = 0;
      const trustScore = computeTrustScore({ geoScore, signScore, infraScore: infraScoreVal });
      const status     = deriveStatus(trustScore, isFlagged, geoScore);

      return res.json({
        success : true,
        testMode: true,
        message : "No session found — returned computed score only (test mode)",
        trustScore, status, textDetected, labels,
        infraScore: infraScoreVal, signScore, isFlagged,
      });
    }

    const session = await Session.findOne({ sessionId });

    // SessionId parsed but not in DB — compute without GPS
    if (!session) {
      console.warn(`[ai-result] Session not found in DB: ${sessionId}`);

      const infraScoreVal = infraScore || 0;
      // FIXED: was hardcoded 0.85/0.2 — now uses real scoring.
      // businessName unknown, so partial score only (0.25 if text, 0.10 if none)
      const signScore  = computeSignageScore(textDetected, "");
      const geoScore   = 0;
      const trustScore = computeTrustScore({ geoScore, signScore, infraScore: infraScoreVal });
      const status     = deriveStatus(trustScore, isFlagged, geoScore);

      return res.json({
        success : true,
        testMode: true,
        message : `Session ${sessionId} not in DB — score computed without GPS or business name`,
        trustScore, status, textDetected, labels,
        infraScore: infraScoreVal, signScore, isFlagged,
      });
    }

    // ── Full scoring — session found with businessName ────────────
    //
    // computeSignageScore tiers (from scoring.js):
    //   1.00 → exact full name match
    //   0.85 → all significant words matched
    //   0.55–0.70 → primary brand word matched (scales with extra words)
    //   0.30–0.50 → partial words matched (not primary)
    //   0.25 → text found but zero name words matched
    //   0.10 → no text detected at all
    const signScore     = computeSignageScore(textDetected, session.businessName);
    const infraScoreVal = infraScore || 0;

    const trustScore = computeTrustScore({
      geoScore  : session.geoScore,
      signScore,
      infraScore: infraScoreVal,
    });

    const status = deriveStatus(trustScore, isFlagged, session.geoScore);

    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          status,
          trustScore,
          signScore,
          infraScore  : infraScoreVal,
          s3ThumbUri  : s3Key,
          aiResults   : {
            textDetected,
            labels,
            infraScore    : infraScoreVal,
            livenessResult: livenessResult ?? "UNKNOWN",
            isFlagged,
          },
        },
        $push: {
          auditLog: {
            action: "AI_RESULT_RECEIVED",
            detail: `Score: ${trustScore} | Status: ${status} | Sign: ${signScore.toFixed(2)} | Infra: ${infraScoreVal} | Labels: ${labels?.join(", ")}`,
          },
        },
      },
      { new: true }
    );

    io.emit("session_complete", {
      sessionId,
      trustScore,
      status,
      labels      : labels ?? [],
      textDetected,
      infraScore  : infraScoreVal,
      signScore,
      geoScore    : session.geoScore,
      isFlagged,
      timestamp   : new Date().toISOString(),
    });

    console.log(`[ai-result] ✅ ${sessionId} → Score: ${trustScore} | Status: ${status} | Sign: ${signScore.toFixed(2)}`);

    res.json({ success: true, sessionId, trustScore, status, signScore, infraScore: infraScoreVal });

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
      $set: {
        reviewNotes: notes,
        reviewedBy,
        reviewedAt : new Date(),
      },
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

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    io.emit("session_reviewed", { sessionId: req.params.id, newStatus, reviewedBy });
    res.json({ success: true, session });

  } catch (err) {
    console.error("[PATCH /sessions/:id/review]", err);
    res.status(500).json({ error: "Failed to update review" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  DELETE /api/sessions/:id  (dev/admin only)
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