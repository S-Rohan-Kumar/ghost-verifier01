// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Accelerometer Analysis  (Layer 2)
//  config/accelerometer.js
//
//  A person walking into a real business has natural micro-movements.
//  A phone propped up recording a screen is nearly perfectly still.
//
//  Returns:
//    motionScore   : 0.0–1.0  (higher = more natural movement)
//    isStationary  : boolean  (true = suspicious)
//    result        : "NATURAL" | "MINIMAL" | "STATIONARY" | "INSUFFICIENT_DATA"
//    detail        : human-readable explanation
//    stats         : raw variance numbers for audit display
// ═══════════════════════════════════════════════════════════════

const STATIONARY_VARIANCE_THRESHOLD = 0.08;
const MINIMAL_VARIANCE_THRESHOLD    = 0.25;
const MIN_SAMPLES_REQUIRED          = 15;

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function magnitudes(samples) {
  return samples.map(s => Math.sqrt(s.x ** 2 + s.y ** 2 + s.z ** 2));
}

export function analyseAccelerometer(samples) {
  if (!samples || samples.length < MIN_SAMPLES_REQUIRED) {
    return {
      motionScore : 0.5,
      isStationary: false,
      result      : "INSUFFICIENT_DATA",
      detail      : `Only ${samples?.length ?? 0} samples — need at least ${MIN_SAMPLES_REQUIRED} to analyse motion`,
      stats       : null,
    };
  }

  const mags    = magnitudes(samples);
  const magMax  = Math.max(...mags);
  const magMin  = Math.min(...mags);

  const xStd = stdDev(samples.map(s => s.x));
  const yStd = stdDev(samples.map(s => s.y));
  const zStd = stdDev(samples.map(s => s.z));
  const overallVariance = (xStd + yStd + zStd) / 3;

  const stats = {
    sampleCount    : samples.length,
    overallVariance: parseFloat(overallVariance.toFixed(4)),
    magnitudeMean  : parseFloat(mean(mags).toFixed(4)),
    magnitudeStdDev: parseFloat(stdDev(mags).toFixed(4)),
    magnitudeRange : parseFloat((magMax - magMin).toFixed(4)),
    xStd: parseFloat(xStd.toFixed(4)),
    yStd: parseFloat(yStd.toFixed(4)),
    zStd: parseFloat(zStd.toFixed(4)),
  };

  if (overallVariance < STATIONARY_VARIANCE_THRESHOLD) {
    return {
      motionScore : 0.0,
      isStationary: true,
      result      : "STATIONARY",
      detail      : `Phone appears stationary (variance=${overallVariance.toFixed(3)}). Likely propped up or on a desk — not hand-held.`,
      stats,
    };
  }

  if (overallVariance < MINIMAL_VARIANCE_THRESHOLD) {
    const motionScore = parseFloat(
      (0.2 + ((overallVariance - STATIONARY_VARIANCE_THRESHOLD) /
              (MINIMAL_VARIANCE_THRESHOLD - STATIONARY_VARIANCE_THRESHOLD)) * 0.4
      ).toFixed(2)
    );
    return {
      motionScore,
      isStationary: false,
      result      : "MINIMAL",
      detail      : `Low motion detected (variance=${overallVariance.toFixed(3)}). Below typical walking levels.`,
      stats,
    };
  }

  const motionScore = parseFloat(
    Math.min(0.6 + ((overallVariance - MINIMAL_VARIANCE_THRESHOLD) / 0.5) * 0.4, 1.0).toFixed(2)
  );

  return {
    motionScore,
    isStationary: false,
    result      : "NATURAL",
    detail      : `Natural hand-held motion detected (variance=${overallVariance.toFixed(3)}). Consistent with someone walking.`,
    stats,
  };
}