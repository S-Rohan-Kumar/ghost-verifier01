// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Upload Routes
//  routes/upload.js
//
//  Provides pre-signed S3 PUT URLs for the mobile app.
//  The app uploads directly to S3 — the backend never touches
//  the binary data.
//
//  Supported types:
//    thumbnail       → thumbnails/<sessionId>_<ts>.jpg
//    video           → videos/<sessionId>_<ts>.mp4
//    audit-thumbnail → audit-thumbnails/<sessionId>_<ts>.jpg  ← triggers auditLambda
//    audit-video     → audit-videos/<sessionId>_<ts>.mp4
//
//  Mount in index.js:
//    import uploadRouter from "./routes/upload.js";
//    app.use("/api/upload", uploadRouter);
//
//  Required env vars:
//    S3_BUCKET       — e.g. ghost-verifier-uploads
//    AWS_REGION      — e.g. ap-south-1
//    AWS_ACCESS_KEY_ID
//    AWS_SECRET_ACCESS_KEY
// ═══════════════════════════════════════════════════════════════
import express         from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl }               from "@aws-sdk/s3-request-presigner";

const router = express.Router();

// ── S3 client (picks up env vars automatically) ───────────────
const s3 = new S3Client({
  region     : process.env.AWS_REGION      || "ap-south-1",
  credentials: {
    accessKeyId    : process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET      = process.env.S3_BUCKET;
const URL_EXPIRES = 300; // 5 minutes — plenty for a mobile upload

// ── Key prefix + content-type per upload type ────────────────
const TYPE_CONFIG = {
  "thumbnail"      : { prefix: "thumbnails",       contentType: "image/jpeg" },
  "video"          : { prefix: "videos",            contentType: "video/mp4"  },
  "audit-thumbnail": { prefix: "audit-thumbnails",  contentType: "image/jpeg" }, // ← S3 trigger fires auditLambda
  "audit-video"    : { prefix: "audit-videos",      contentType: "video/mp4"  },
};

// ─────────────────────────────────────────────────────────────────
//  GET /api/upload/presigned-url?type=<type>&sessionId=<id>
//
//  Returns:
//    { uploadUrl, s3Key, bucket, expiresIn }
//
//  The app uploads the file directly to `uploadUrl` with a PUT
//  request, then sends `s3Key` to the backend (e.g. /api/audit/:id/submit).
// ─────────────────────────────────────────────────────────────────
router.get("/presigned-url", async (req, res) => {
  try {
    const { type, sessionId } = req.query;

    if (!type || !sessionId) {
      return res.status(400).json({ error: "type and sessionId query params are required" });
    }

    const cfg = TYPE_CONFIG[type];
    if (!cfg) {
      return res.status(400).json({
        error: `Unknown type "${type}". Valid types: ${Object.keys(TYPE_CONFIG).join(", ")}`,
      });
    }

    if (!BUCKET) {
      console.error("[upload] S3_BUCKET env var not set");
      return res.status(500).json({ error: "S3 bucket not configured on server" });
    }

    // Build a unique S3 key: <prefix>/<sessionId>_<timestamp>.<ext>
    const ext       = cfg.contentType === "image/jpeg" ? "jpg" : "mp4";
    const timestamp = Date.now();
    const s3Key     = `${cfg.prefix}/${sessionId}_${timestamp}.${ext}`;

    const command = new PutObjectCommand({
      Bucket      : BUCKET,
      Key         : s3Key,
      ContentType : cfg.contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: URL_EXPIRES });

    console.log(`[upload] Presigned URL for ${type} | session: ${sessionId} | key: ${s3Key}`);

    res.json({
      uploadUrl,
      s3Key,
      bucket   : BUCKET,
      expiresIn: URL_EXPIRES,
    });

  } catch (err) {
    console.error("[GET /upload/presigned-url]", err);
    res.status(500).json({ error: "Failed to generate upload URL", message: err.message });
  }
});

export default router;