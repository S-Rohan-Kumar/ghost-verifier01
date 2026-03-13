// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Session Model
//  models/Session.js
//
//  ✅ All original fields retained
//  ✅ surpriseAudit subdocument added (replaces old auditMeta)
//  ✅ Partial index on live audits for fast enforcer queries
// ═══════════════════════════════════════════════════════════════
import mongoose from "mongoose";

const AuditEntrySchema = new mongoose.Schema(
  {
    action   : { type: String, required: true },
    detail   : { type: String, default: "" },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SessionSchema = new mongoose.Schema(
  {
    sessionId        : { type: String, required: true, unique: true, index: true },
    businessId       : { type: String, required: true, index: true },
    businessName     : { type: String },
    registeredAddress: { type: String, default: "" },

    status: {
      type   : String,
      enum   : ["PENDING", "PASSED", "FLAGGED", "REVIEW", "ERROR"],
      default: "PENDING",
      index  : true,
    },

    // ── Scores ────────────────────────────────────────────────────
    trustScore       : { type: Number, default: null },
    geoScore         : { type: Number, default: null },
    signScore        : { type: Number, default: null },
    infraScore       : { type: Number, default: null },
    motionScore      : { type: Number, default: null },
    gpsDistanceMetres: { type: Number, default: null },

    // ── S3 assets ─────────────────────────────────────────────────
    s3VideoUri: { type: String },
    s3ThumbUri: { type: String },

    // ── AI results ────────────────────────────────────────────────
    aiResults: {
      textDetected  : { type: String },
      labels        : [String],
      infraScore    : { type: Number },
      livenessResult: {
        type   : String,
        enum   : ["LIVE", "SUSPICIOUS", "SPOOF_DETECTED", "NO_FACE", "UNKNOWN"],
        default: "UNKNOWN",
      },
      livenessDetail : { type: String, default: "" },
      screenRecording: {
        detected  : { type: Boolean, default: false },
        confidence: { type: String, enum: ["HIGH", "MEDIUM", "LOW", null], default: null },
        reason    : { type: String, default: null },
      },
      isFlagged: { type: Boolean },
    },

    // ── Device / GPS ──────────────────────────────────────────────
    meta: {
      device        : String,
      isRooted      : { type: Boolean, default: false },
      gpsStart      : { lat: Number, lng: Number },
      gpsEnd        : { lat: Number, lng: Number },
      appVersion    : String,
      accelerometer : [{ x: Number, y: Number, z: Number, t: Number }],
      motionAnalysis: {
        result: {
          type   : String,
          enum   : ["NATURAL", "MINIMAL", "STATIONARY", "INSUFFICIENT_DATA", null],
          default: null,
        },
        detail: { type: String, default: "" },
        stats : {
          sampleCount    : Number,
          overallVariance: Number,
          magnitudeMean  : Number,
          magnitudeStdDev: Number,
          magnitudeRange : Number,
          xStd           : Number,
          yStd           : Number,
          zStd           : Number,
        },
      },
    },

    // ── Manual review ─────────────────────────────────────────────
    reviewNotes: { type: String },
    reviewedBy : { type: String },
    reviewedAt : { type: Date },

    // ═════════════════════════════════════════════════════════════
    //  SURPRISE AUDIT  (all fields null until triggered)
    //
    //  State machine:
    //    null           → audit not triggered yet
    //    REQUESTED      → T+0:  audit triggered (auto or manual)
    //    WARNING        → T+24: user warned, deadline approaching
    //    REVIEW_PENDING → T+48: auto-escalated to ops team
    //    SUBMITTED      → audit video received, CV analysis running
    //    PASSED         → CV similarity >= 75%, layout matches
    //    REJECTED       → deadline missed OR layout mismatch
    // ═════════════════════════════════════════════════════════════
    surpriseAudit: {
      auditStatus: {
        type   : String,
        enum   : ["REQUESTED", "WARNING", "REVIEW_PENDING", "SUBMITTED", "PASSED", "REJECTED", null],
        default: null,
        index  : true,
      },

      // ── Timing ────────────────────────────────────────────────
      triggeredAt   : { type: Date, default: null },   // T+0
      auditDeadline : { type: Date, default: null },   // T+0 + 60h
      reminderSentAt: { type: Date, default: null },   // T+12 reminder logged
      warningSentAt : { type: Date, default: null },   // T+24 WARNING set
      submittedAt   : { type: Date, default: null },   // when audit video arrives

      // ── Who triggered ─────────────────────────────────────────
      triggeredBy: { type: String, default: null },    // "SYSTEM" or officer name

      // ── Audit video S3 assets ─────────────────────────────────
      auditS3VideoUri: { type: String, default: null },
      auditS3ThumbUri: { type: String, default: null },

      // ── Anchor frames from original session ───────────────────
      // S3 keys the CV Lambda fetches for SSIM / label comparison
      anchorFrameKeys: { type: [String], default: [] },

      // ── Computer Vision results ───────────────────────────────
      cvResult: {
        similarityScore : { type: Number, default: null },   // 0–100 average
        layoutMismatch  : { type: Boolean, default: null },  // true if < 75
        frameComparisons: [
          {
            anchorKey      : String,
            similarityScore: Number,
            matchMethod    : String,  // "SSIM" | "FEATURE_MATCH"
          },
        ],
        newLabels    : [String],   // labels in audit NOT in original
        missingLabels: [String],   // labels in original NOT in audit
        labelOverlap : { type: Number, default: null },  // 0–1 Jaccard
        verdict      : { type: String, default: null },
        processedAt  : { type: Date, default: null },
      },
    },

    // ── Audit trail ───────────────────────────────────────────────
    auditLog: { type: [AuditEntrySchema], default: [] },
  },
  { timestamps: true }
);

// Partial index — enforcer cron only scans live (non-terminal) audits
SessionSchema.index(
  { "surpriseAudit.auditStatus": 1, "surpriseAudit.auditDeadline": 1 },
  {
    partialFilterExpression: {
      "surpriseAudit.auditStatus": { $nin: [null, "PASSED", "REJECTED"] },
    },
  }
);

export default mongoose.model("Session", SessionSchema);