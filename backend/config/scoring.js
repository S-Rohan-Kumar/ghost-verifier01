// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Scoring Config
//  config/scoring.js
// ═══════════════════════════════════════════════════════════════

export const GEO_DISTANCE_THRESHOLD_METRES = 100;

export function haversineDistance(a, b) {
  const R    = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const c =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}

const STOP_WORDS = new Set([
  "pvt","ltd","llp","inc","co","corp","the","and","of","for","a","an","by","in","at",
  "&","-","private","limited","public","company","enterprises","solutions","services",
  "group","india","ventures",
]);

function significantWords(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

export function computeSignageScore(detectedText, businessName) {
  if (!detectedText || detectedText === "NONE" || detectedText.trim() === "") return 0.10;
  if (!businessName || businessName.trim() === "") return 0.25;

  const detected = detectedText.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const bizLower  = businessName.toLowerCase().replace(/[^a-z0-9\s]/g, " ");

  if (detected.includes(bizLower) || bizLower.includes(detected.trim())) return 1.00;

  const sigWords   = significantWords(businessName);
  if (sigWords.length === 0) return 0.25;

  const matched    = sigWords.filter(w => detected.includes(w));
  const matchRatio = matched.length / sigWords.length;

  if (matchRatio === 1.0)                  return 0.85;
  if (matched.includes(sigWords[0]))       return parseFloat((0.55 + matchRatio * 0.15).toFixed(2));
  if (matched.length > 0)                  return parseFloat((0.30 + matchRatio * 0.20).toFixed(2));
  return 0.25;
}

// ── Trust score ───────────────────────────────────────────────
//  With motionScore:    geo 35% | sign 25% | infra 25% | motion 15%
//  Without motionScore: geo 40% | sign 30% | infra 30%  (backward compat)
export function computeTrustScore({ geoScore, signScore, infraScore, motionScore }) {
  const geo   = geoScore   ?? 0;
  const sign  = signScore  ?? 0;
  const infra = infraScore ?? 0;

  if (motionScore == null) {
    return Math.round((geo * 0.40 + sign * 0.30 + infra * 0.30) * 100);
  }
  return Math.round(
    (geo * 0.35 + sign * 0.25 + infra * 0.25 + motionScore * 0.15) * 100
  );
}

export function deriveStatus(trustScore, isFlagged, geoScore) {
  
  if (geoScore === 0)     return "FLAGGED";
  if (isFlagged === true) return "FLAGGED";
  if (trustScore >= 75)   return "PASSED";
  if (trustScore >= 40)   return "REVIEW";
  return "FLAGGED";
}