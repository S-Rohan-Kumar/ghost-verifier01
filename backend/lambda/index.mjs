// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — AWS Lambda Function
//  lambda/index.mjs
//
//  Triggered by: S3 PUT event on thumbnails/ folder
//  Calls: Rekognition DetectText + DetectLabels
//  Posts: AI results back to Express backend
//
//  DEPLOY STEPS:
//  1. In AWS Lambda console, paste this entire file into index.mjs
//  2. Click Deploy
//  3. Set environment variable: BACKEND_URL=https://your-railway-url.app
// ═══════════════════════════════════════════════════════════════

import {
  RekognitionClient,
  DetectTextCommand,
  DetectLabelsCommand
} from '@aws-sdk/client-rekognition';

const rek = new RekognitionClient({ region: 'ap-south-1' });

// ── Label scoring maps (mirrors backend scoring.js) ──────────────
const POSITIVE_LABELS = {
  'Desk': 0.20, 'Computer': 0.20, 'Office': 0.20, 'Sign': 0.20,
  'Table': 0.15, 'Monitor': 0.15, 'Whiteboard': 0.15,
  'Chair': 0.10, 'Printer': 0.10, 'Keyboard': 0.10,
  'Bookcase': 0.10, 'Shelf': 0.10, 'Filing Cabinet': 0.10,
  'Conference Room': 0.20
};

const FLAG_LABELS = [
  'Bed', 'Pillow', 'Bedroom', 'Mattress',
  'Couch', 'Sofa', 'Living Room',
  'Refrigerator', 'Oven', 'Kitchen',
  'Bathroom', 'Bathtub', 'Toilet'
];

export const handler = async (event) => {
  const startTime = Date.now();

  try {
    // ── Parse S3 trigger event ──────────────────────────────────
    const record = event.Records?.[0];
    if (!record) {
      console.error('No Records in event');
      return { statusCode: 400, body: 'No S3 record in event' };
    }

    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    console.log(`[Lambda] Processing: s3://${bucket}/${key}`);

    // Only process thumbnails (not videos — too slow for frame analysis)
    if (!key.startsWith('thumbnails/')) {
      console.log('[Lambda] Skipping non-thumbnail file');
      return { statusCode: 200, body: 'Skipped: not a thumbnail' };
    }

    const s3Image = { S3Object: { Bucket: bucket, Name: key } };

    // ── Run Rekognition in parallel ─────────────────────────────
    const [textResult, labelResult] = await Promise.all([
      rek.send(new DetectTextCommand({ Image: s3Image })),
      rek.send(new DetectLabelsCommand({ Image: s3Image, MaxLabels: 15, MinConfidence: 70 }))
    ]);

    // ── Process text detections ─────────────────────────────────
    const textLines = textResult.TextDetections
      .filter(t => t.Type === 'LINE' && t.Confidence > 80)
      .map(t => ({ text: t.DetectedText, confidence: parseFloat(t.Confidence.toFixed(1)) }));

    const textDetected = textLines.map(t => t.text).join(', ') || 'NONE';

    // ── Process label detections ────────────────────────────────
    const labels = labelResult.Labels.map(l => l.Name);

    // ── Compute infrastructure score ────────────────────────────
    let infraScore = 0;
    let isFlagged  = false;
    const matchedLabels  = [];
    const flaggedLabels  = [];

    labels.forEach(label => {
      if (POSITIVE_LABELS[label]) {
        infraScore += POSITIVE_LABELS[label];
        matchedLabels.push(label);
      }
      if (FLAG_LABELS.includes(label)) {
        isFlagged = true;
        flaggedLabels.push(label);
      }
    });

    infraScore = parseFloat(Math.min(infraScore, 1.0).toFixed(2));

    const processingMs = Date.now() - startTime;

    const result = {
      timestamp    : new Date().toISOString(),
      s3Key        : key,
      textDetected,
      textLines,
      labels,
      matchedLabels,
      flaggedLabels,
      infraScore,
      isFlagged,
      processingMs
    };

    console.log('[Lambda] Result:', JSON.stringify(result));

    // ── Send results to backend ─────────────────────────────────
    const backendUrl = process.env.BACKEND_URL;
    if (!backendUrl) {
      console.warn('[Lambda] BACKEND_URL not set — skipping callback');
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    const response = await fetch(`${backendUrl}/api/sessions/ai-result`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(result)
    });

    if (!response.ok) {
      console.error(`[Lambda] Backend returned ${response.status}`);
    } else {
      const backendResult = await response.json();
      console.log('[Lambda] Backend response:', JSON.stringify(backendResult));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ...result, backendNotified: response.ok })
    };

  } catch (err) {
    console.error('[Lambda] Error:', err.message, err.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, timestamp: new Date().toISOString() })
    };
  }
};




// import {
//   RekognitionClient,
//   DetectTextCommand,
//   DetectLabelsCommand
// } from '@aws-sdk/client-rekognition';

// const rek = new RekognitionClient({ region: 'ap-south-1' });

// const POSITIVE_LABELS = {
//   'Desk': 0.20, 'Computer': 0.20, 'Office': 0.20, 'Sign': 0.20,
//   'Table': 0.15, 'Monitor': 0.15, 'Whiteboard': 0.15,
//   'Chair': 0.10, 'Printer': 0.10, 'Keyboard': 0.10,
//   'Bookcase': 0.10, 'Filing Cabinet': 0.10, 'Conference Room': 0.20
// };

// const FLAG_LABELS = [
//   'Bed', 'Pillow', 'Bedroom', 'Mattress',
//   'Couch', 'Sofa', 'Living Room',
//   'Refrigerator', 'Oven', 'Kitchen',
//   'Bathroom', 'Bathtub', 'Toilet'
// ];

// export const handler = async (event) => {
//   try {
//     // ── 1. Parse S3 event ────────────────────────────────────────
//     const bucket = event.Records[0].s3.bucket.name;
//     const key    = decodeURIComponent(
//                      event.Records[0].s3.object.key.replace(/\+/g, ' ')
//                    );

//     console.log(`Processing: s3://${bucket}/${key}`);

//     const s3Image = { S3Object: { Bucket: bucket, Name: key } };

//     // ── 2. Run Rekognition (parallel) ────────────────────────────
//     const [textRes, labelRes] = await Promise.all([
//       rek.send(new DetectTextCommand({ Image: s3Image })),
//       rek.send(new DetectLabelsCommand({
//         Image: s3Image, MaxLabels: 15, MinConfidence: 70
//       }))
//     ]);

//     // ── 3. Extract text ──────────────────────────────────────────
//     const textDetected = textRes.TextDetections
//       .filter(t => t.Type === 'LINE' && t.Confidence > 80)
//       .map(t => t.DetectedText)
//       .join(', ') || 'NONE';

//     // ── 4. Extract labels ────────────────────────────────────────
//     const labels = labelRes.Labels.map(l => l.Name);

//     // ── 5. Compute infra score ───────────────────────────────────
//     let infraScore = 0;
//     let isFlagged  = false;

//     labels.forEach(label => {
//       if (POSITIVE_LABELS[label]) infraScore += POSITIVE_LABELS[label];
//       if (FLAG_LABELS.includes(label)) isFlagged = true;
//     });
//     infraScore = parseFloat(Math.min(infraScore, 1.0).toFixed(2));

//     // ── 6. Build result ──────────────────────────────────────────
//     const result = {
//       s3Key       : key,
//       textDetected,
//       labels,
//       infraScore,
//       isFlagged,
//       timestamp   : new Date().toISOString()
//     };

//     console.log('Rekognition result:', JSON.stringify(result, null, 2));

//     // ── 7. POST to backend ───────────────────────────────────────
//     const BACKEND_URL = process.env.BACKEND_URL;

//     if (!BACKEND_URL) {
//       console.error('❌ BACKEND_URL environment variable is not set!');
//       return { statusCode: 500, body: 'BACKEND_URL not configured' };
//     }

//     console.log(`Posting to: ${BACKEND_URL}/api/sessions/ai-result`);

//     const response = await fetch(`${BACKEND_URL}/api/sessions/ai-result`, {
//       method : 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body   : JSON.stringify(result)
//     });

//     const responseText = await response.text();
//     console.log(`Backend status: ${response.status}`);
//     console.log(`Backend response: ${responseText}`);

//     if (!response.ok) {
//       console.error(`❌ Backend returned error: ${response.status} - ${responseText}`);
//       return {
//         statusCode: 500,
//         body: `Backend error: ${response.status} - ${responseText}`
//       };
//     }

//     console.log('✅ Successfully sent to backend!');
//     return {
//       statusCode: 200,
//       body: JSON.stringify({ result, backendResponse: JSON.parse(responseText) })
//     };

//   } catch (err) {
//     console.error('Lambda error:', err.message);
//     console.error(err.stack);
//     return { statusCode: 500, body: err.message };
//   }
// };
```

Click **Deploy** after pasting.

---

## Then Do This Test Sequence

**Step 1** — Wake up Render first:
```
// Open browser → https://your-app.onrender.com/ → wait for response