// src/strategyGuards.js — Pure strategy guard helpers for scheduler gating

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function shouldRunAiValidator({
  enabled,
  confidence,
  edge,
  confidenceMax,
  edgeMax,
}) {
  if (!enabled) return false;
  const c = toFinite(confidence);
  const e = toFinite(edge);
  const cMax = toFinite(confidenceMax);
  const eMax = toFinite(edgeMax);

  const confidenceBorderline = c !== null && cMax !== null && c <= cMax;
  const edgeBorderline = e !== null && eMax !== null && e <= eMax;
  return confidenceBorderline || edgeBorderline;
}

export function extractNearestEventTempC(weatherText = '') {
  const lines = String(weatherText || '').split(/\r?\n/);

  // Prefer the explicitly tagged event period line.
  for (const line of lines) {
    if (!line.includes('<<<EVENT')) continue;
    const m = line.match(/temp=([-+]?\d+(?:\.\d+)?)C/i);
    if (m) return toFinite(m[1]);
  }

  // Fallback to the first forecast temp value if event marker is unavailable.
  const fallback = String(weatherText || '').match(/temp=([-+]?\d+(?:\.\d+)?)C/i);
  return fallback ? toFinite(fallback[1]) : null;
}

export function extractOutcomeBoundariesC(outcomeText = '') {
  const matches = String(outcomeText || '').match(/-?\d+(?:\.\d+)?/g) || [];
  const boundaries = matches
    .map((v) => toFinite(v))
    .filter((v) => v !== null);

  // Dedupe and sort for stable behavior.
  return Array.from(new Set(boundaries)).sort((a, b) => a - b);
}

export function evaluateBoundaryNoTrade({
  weatherText,
  predictedOutcome,
  bandDegrees,
  confidence,
  edge,
  overrideConfidence,
  overrideEdge,
}) {
  const tempC = extractNearestEventTempC(weatherText);
  if (tempC === null) {
    return { blocked: false, reason: 'no_event_temp', nearestTempC: null, nearestBoundaryC: null };
  }

  const boundaries = extractOutcomeBoundariesC(predictedOutcome);
  if (boundaries.length === 0) {
    return { blocked: false, reason: 'no_numeric_boundary', nearestTempC: tempC, nearestBoundaryC: null };
  }

  const band = Math.max(0, Number(bandDegrees || 0));
  const nearestBoundaryC = boundaries.reduce((best, v) => {
    if (best === null) return v;
    return Math.abs(v - tempC) < Math.abs(best - tempC) ? v : best;
  }, null);

  const distanceC = Math.abs(nearestBoundaryC - tempC);
  if (distanceC > band) {
    return {
      blocked: false,
      reason: 'outside_boundary_band',
      nearestTempC: tempC,
      nearestBoundaryC,
      distanceC,
    };
  }

  const c = toFinite(confidence);
  const e = toFinite(edge);
  const cOverride = toFinite(overrideConfidence);
  const eOverride = toFinite(overrideEdge);

  const hasOverride = c !== null && e !== null && cOverride !== null && eOverride !== null && c >= cOverride && e >= eOverride;
  if (hasOverride) {
    return {
      blocked: false,
      reason: 'override_threshold_met',
      nearestTempC: tempC,
      nearestBoundaryC,
      distanceC,
    };
  }

  return {
    blocked: true,
    reason: 'boundary_no_trade_band',
    nearestTempC: tempC,
    nearestBoundaryC,
    distanceC,
  };
}
