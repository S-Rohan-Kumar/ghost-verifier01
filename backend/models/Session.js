// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Session Model  (FIXED)
//  models/Session.js
// ═══════════════════════════════════════════════════════════════
import mongoose from "mongoose";

const AuditEntrySchema = new mongoose.Schema(
  {
    action    : { type: String, required: true },
    detail    : { type: String, default: "" },
    timestamp : { type: Date, default: Date.now },
  },
  { _id: false }
);

const SessionSchema = new mongoose.Schema(
  {
    sessionId   : { type: String, required: true, unique: true, index: true },
    businessId  : { type: String, required: true, index: true },
    businessName: { type: String },

    // ── Registered address (stored for display / audit) ──────────
    registeredAddress: { type: String, default: "" },

    // ── Status ────────────────────────────────────────────────────
    status: {
      type   : String,
      enum   : ["PENDING", "PASSED", "FLAGGED", "REVIEW", "ERROR"],
      default: "PENDING",
      index  : true,
    },

    // ── Scores (all top-level so $set works reliably) ─────────────
    trustScore  : { type: Number, default: null },   // 0-100 integer
    geoScore    : { type: Number, default: null },   // 0 or 1
    signScore   : { type: Number, default: null },   // 0.0 – 1.0  ← WAS MISSING
    infraScore  : { type: Number, default: null },   // 0.0 – 1.0  ← WAS MISSING

    // ── GPS ───────────────────────────────────────────────────────
    gpsDistanceMetres: { type: Number, default: null }, // ← WAS MISSING

    // ── S3 assets ─────────────────────────────────────────────────
    s3VideoUri  : { type: String },
    s3ThumbUri  : { type: String },

    // ── Raw AI results (kept for display) ────────────────────────
    aiResults: {
      textDetected  : { type: String },
      labels        : [String],
      infraScore    : { type: Number },   // mirror of top-level for legacy reads
      livenessResult: { type: String },
      isFlagged     : { type: Boolean },
    },

    // ── Device / GPS metadata ─────────────────────────────────────
    meta: {
      device      : String,
      isRooted    : { type: Boolean, default: false },
      gpsStart    : { lat: Number, lng: Number },
      gpsEnd      : { lat: Number, lng: Number },
      appVersion  : String,
      accelerometer: [{ x: Number, y: Number, z: Number, t: Number }],
    },

    // ── Manual review fields ──────────────────────────────────────
    reviewNotes : { type: String },          // ← WAS MISSING
    reviewedBy  : { type: String },          // ← WAS MISSING
    reviewedAt  : { type: Date },            // ← WAS MISSING

    // ── Audit trail ───────────────────────────────────────────────
    auditLog: { type: [AuditEntrySchema], default: [] }, // ← WAS MISSING
  },
  {
    timestamps: true,   // ← WAS MISSING — adds createdAt / updatedAt
  }
);

export default mongoose.model("Session", SessionSchema);