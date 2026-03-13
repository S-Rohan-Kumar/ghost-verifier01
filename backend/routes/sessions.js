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

    // Validate required fields
    if (!sessionId || !businessId) {
      return res
        .status(400)
        .json({ error: "sessionId and businessId are required" });
    }

    // Block rooted devices immediately
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
      registeredCoords = {
        lat: business.registeredAddress.lat,
        lng: business.registeredAddress.lng,
      };
      registeredAddress = business.registeredAddress.fullText || "";
    } else {
      // Fallback for dev/hackathon when business record doesn't exist yet
      registeredCoords  = { lat: 12.9716, lng: 77.5946 };
      registeredAddress = "Mock: Bengaluru, Karnataka";
    }

    // ── BUG FIX 1: Geo score ──────────────────────────────────────
    // geoScore was being computed correctly but gpsDistanceMetres was never
    // saved to the DB because Session schema had no such field.
    // Now both fields exist in the schema and are explicitly persisted.
    let geoScore          = 0;
    let gpsDistanceMetres = null;

    if (gpsStart && registeredCoords) {
      gpsDistanceMetres = haversineDistance(gpsStart, registeredCoords);
      geoScore = gpsDistanceMetres <= GEO_DISTANCE_THRESHOLD_METRES ? 1 : 0;
    }

    // Create session — all scored fields are now schema fields
    const session = await Session.create({
      sessionId,
      businessId,
      businessName,
      registeredAddress,          // ← now a schema field
      status            : "PENDING",
      geoScore,                   // ← schema field
      gpsDistanceMetres,          // ← now a schema field (was silently dropped)
      meta: {
        device,
        isRooted   : isRooted ?? false,
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

    // If geo fails → flag immediately without waiting for AI
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

      io.emit("session_flagged_geo", {
        sessionId,
        businessId,
        businessName,
        gpsDistanceMetres,
        status: "FLAGGED",
      });
    }

    res.status(201).json({
      success          : true,
      sessionId        : session.sessionId,
      geoScore,
      gpsDistanceMetres: gpsDistanceMetres
        ? parseFloat(gpsDistanceMetres.toFixed(1))
        : null,
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

    // ── BUG FIX 2: sessionId extraction ───────────────────────────
    // Lambda was not sending sessionId in the POST body (see index.mjs fix).
    // The s3Key fallback extraction was also fragile — improved below.
    let sessionId = null;

    // Method 1: Lambda sends sessionId directly in body (preferred — fixed in Lambda)
    if (sessionIdFromBody) {
      sessionId = sessionIdFromBody;
    }

    // Method 2: Extract from s3Key  →  thumbnails/<sessionId>_<timestamp>.<ext>
    if (!sessionId && s3Key) {
      const filename       = s3Key.split("/").pop();          // "sess_abc_123_1710000000.jpg"
      const nameWithoutExt = filename.replace(/\.[^.]+$/, ""); // strip extension
      const lastUnderscore = nameWithoutExt.lastIndexOf("_");  // find timestamp separator

      // ── BUG FIX 3: was using split("_").slice(0,-1) which breaks sessionIds
      // that themselves contain underscores (e.g. "sess_abc_BIZ001").
      // Using lastIndexOf("_") correctly strips only the trailing timestamp.
      if (lastUnderscore > 0) {
        sessionId = nameWithoutExt.substring(0, lastUnderscore);
      }
    }

    // Method 3: No session found — return computed score in test mode
    if (!sessionId) {
      console.warn(`[ai-result] Could not extract sessionId from s3Key: ${s3Key}`);

      const infraScoreVal = infraScore || 0;
      const signScore     = 0.2;
      const geoScore      = 0;
      const trustScore    = Math.round((geoScore * 0.4 + signScore * 0.3 + infraScoreVal * 0.3) * 100);
      const status        = trustScore >= 70 ? "PASSED" : trustScore >= 40 ? "REVIEW" : "FLAGGED";

      return res.json({
        success   : true,
        testMode  : true,
        message   : "No session found — returned computed score only (test mode)",
        trustScore, status, textDetected, labels, infraScore: infraScoreVal, isFlagged,
      });
    }

    const session = await Session.findOne({ sessionId });

    if (!session) {
      console.warn(`[ai-result] Session not found in DB: ${sessionId}`);

      const infraScoreVal = infraScore || 0;
      const signScore     = textDetected && textDetected !== "NONE" ? 0.85 : 0.2;
      const geoScore      = 0;
      const trustScore    = Math.round((geoScore * 0.4 + signScore * 0.3 + infraScoreVal * 0.3) * 100);
      const status        = trustScore >= 70 ? "PASSED" : trustScore >= 40 ? "REVIEW" : "FLAGGED";

      return res.json({
        success  : true,
        testMode : true,
        message  : `Session ${sessionId} not in DB — score computed without GPS`,
        trustScore, status, textDetected, labels, infraScore: infraScoreVal, isFlagged,
      });
    }

    // ── Session found — full scoring ──────────────────────────────

    // ── BUG FIX 4: signScore was computed but schema had no top-level
    // signScore or infraScore fields, so $set silently discarded them.
    // Both fields now exist in the schema (Session.js fix).
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
          signScore,                          // ← now a real schema field
          infraScore  : infraScoreVal,        // ← now a real schema field
          s3ThumbUri  : s3Key,
          aiResults   : {
            textDetected,
            labels,
            infraScore  : infraScoreVal,
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

    // ── BUG FIX 5: newStatus was being set at the top level of the update
    // object, but Mongoose requires status changes to be inside $set when
    // using $push in the same update — mixing operator and non-operator keys
    // causes a MongoServerError in newer MongoDB drivers.
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