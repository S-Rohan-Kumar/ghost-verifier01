// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — AWS Lambda  (FIXED)
//  index.mjs
// ═══════════════════════════════════════════════════════════════
import {
  RekognitionClient,
  DetectTextCommand,
  DetectLabelsCommand,
} from "@aws-sdk/client-rekognition";

const rek = new RekognitionClient({ region: "ap-south-1" });

const POSITIVE_LABELS = {
  Desk             : 0.20,
  Computer         : 0.20,
  Office           : 0.20,
  Sign             : 0.20,
  Table            : 0.15,
  Monitor          : 0.15,
  Whiteboard       : 0.15,
  Chair            : 0.10,
  Printer          : 0.10,
  Keyboard         : 0.10,
  Bookcase         : 0.10,
  "Filing Cabinet" : 0.10,
  "Conference Room": 0.20,
};

const FLAG_LABELS = [
  "Bed", "Pillow", "Bedroom", "Mattress",
  "Couch", "Sofa", "Living Room",
  "Refrigerator", "Oven", "Kitchen",
  "Bathroom", "Bathtub", "Toilet",
];

export const handler = async (event) => {
  try {
    // ── 1. Parse S3 event ────────────────────────────────────────
    const bucket = event.Records[0].s3.bucket.name;
    const key    = decodeURIComponent(
      event.Records[0].s3.object.key.replace(/\+/g, " ")
    );

    console.log(`Processing: s3://${bucket}/${key}`);

    // ── BUG FIX 1: Extract sessionId HERE in the Lambda before calling
    // Rekognition, so we can include it in the POST body.
    // Previously sessionId was never sent → backend always ran in "test mode"
    // and never updated any real session in MongoDB.
    //
    // Expected S3 key format:  thumbnails/<sessionId>_<timestamp>.<ext>
    // e.g.  thumbnails/sess_BIZ001_abc_1710000000.jpg
    const filename       = key.split("/").pop();
    const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
    const lastUnderscore = nameWithoutExt.lastIndexOf("_");
    // Strip only the trailing numeric timestamp — everything before it is the sessionId
    const sessionId =
      lastUnderscore > 0 && /^\d+$/.test(nameWithoutExt.substring(lastUnderscore + 1))
        ? nameWithoutExt.substring(0, lastUnderscore)
        : nameWithoutExt; // fallback: use whole name if no timestamp suffix

    console.log(`Extracted sessionId: ${sessionId}`);

    const s3Image = { S3Object: { Bucket: bucket, Name: key } };

    // ── 2. Run Rekognition in parallel ───────────────────────────
    const [textRes, labelRes] = await Promise.all([
      rek.send(new DetectTextCommand({ Image: s3Image })),
      rek.send(
        new DetectLabelsCommand({ Image: s3Image, MaxLabels: 15, MinConfidence: 70 })
      ),
    ]);

    // ── 3. Extract text ──────────────────────────────────────────
    const textDetected =
      textRes.TextDetections
        .filter((t) => t.Type === "LINE" && t.Confidence > 80)
        .map((t) => t.DetectedText)
        .join(", ") || "NONE";

    // ── 4. Extract labels ────────────────────────────────────────
    const labels = labelRes.Labels.map((l) => l.Name);

    // ── 5. Compute infra score ───────────────────────────────────
    let infraScore = 0;
    let isFlagged  = false;

    labels.forEach((label) => {
      if (POSITIVE_LABELS[label]) infraScore += POSITIVE_LABELS[label];
      if (FLAG_LABELS.includes(label)) isFlagged = true;
    });
    infraScore = parseFloat(Math.min(infraScore, 1.0).toFixed(2));

    // ── 6. Build result — NOW INCLUDES sessionId ─────────────────
    const result = {
      sessionId,          // ← BUG FIX: was missing; backend fell into test mode
      s3Key       : key,
      textDetected,
      labels,
      infraScore,
      isFlagged,
      timestamp   : new Date().toISOString(),
    };

    console.log("Rekognition result:", JSON.stringify(result, null, 2));

    // ── 7. POST to backend ───────────────────────────────────────
    const BACKEND_URL = process.env.BACKEND_URL;

    if (!BACKEND_URL) {
      console.error("❌ BACKEND_URL environment variable is not set!");
      return { statusCode: 500, body: "BACKEND_URL not configured" };
    }

    console.log(`Posting to: ${BACKEND_URL}/api/sessions/ai-result`);

    const response = await fetch(`${BACKEND_URL}/api/sessions/ai-result`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(result),
    });

    const responseText = await response.text();
    console.log(`Backend status: ${response.status}`);
    console.log(`Backend response: ${responseText}`);

    if (!response.ok) {
      console.error(`❌ Backend returned error: ${response.status} - ${responseText}`);
      return {
        statusCode: 500,
        body      : `Backend error: ${response.status} - ${responseText}`,
      };
    }

    console.log("✅ Successfully sent to backend!");
    return {
      statusCode: 200,
      body      : JSON.stringify({ result, backendResponse: JSON.parse(responseText) }),
    };

  } catch (err) {
    console.error("Lambda error:", err.message);
    console.error(err.stack);
    return { statusCode: 500, body: err.message };
  }
};
