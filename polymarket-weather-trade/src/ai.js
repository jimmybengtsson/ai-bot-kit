// src/ai.js — OpenAI analysis for weather event betting decisions
import OpenAI from 'openai';
import { config } from './config.js';
import { createLogger, emitEvent, logDetailedError } from './logger.js';
import { retryWithBackoff } from './retry.js';

const log = createLogger('ai');

const client = new OpenAI({ apiKey: config.openaiApiKey });

function summarizeOpenAIOutput(outputText) {
  if (!outputText) return 'no output text';
  try {
    const parsed = JSON.parse(outputText);
    const bets = Array.isArray(parsed?.bets) ? parsed.bets : [];
    const avgConfidence = bets.length
      ? (bets.reduce((sum, d) => sum + (Number(d?.confidence) || 0), 0) / bets.length).toFixed(1)
      : '0.0';
    return `bets=${bets.length} avg_confidence=${avgConfidence}%`;
  } catch {
    return `non-json output chars=${outputText.length}`;
  }
}

function clipText(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function formatDecisionLog(eventTitle, parsed, bets) {
  const lines = [];
  lines.push('AI Decision Summary');
  lines.push(`  Event: ${clipText(eventTitle, 90) || 'Unknown event'}`);
  lines.push(`  Decision: ${bets.length > 0 ? 'BET' : 'NO BET'}`);
  lines.push(`  Forecast: ${clipText(parsed?.forecastSummary || 'n/a')}`);
  lines.push(`  Uncertainty: ${clipText(parsed?.uncertaintyAssessment || 'n/a')}`);
  lines.push(`  Climate Signal: ${clipText(parsed?.climateSignalSummary || 'n/a')}`);
  lines.push(`  Resolution Alignment: ${clipText(parsed?.owmResolutionAlignment || 'n/a')}`);

  if (bets.length === 0) {
    lines.push('  Bet: none');
    return lines.join('\n');
  }

  const bet = bets[0];
  const confidence = Number(bet?.confidence);
  const estProb = Number(bet?.estimatedProbability);
  const edge = Number(bet?.edge);
  lines.push(`  Bet: YES on "${clipText(bet?.predictedOutcome || 'n/a', 120)}"`);
  lines.push(`  Confidence: ${Number.isFinite(confidence) ? `${confidence.toFixed(1)}%` : 'n/a'}`);
  lines.push(`  Estimated Probability: ${Number.isFinite(estProb) ? estProb.toFixed(3) : 'n/a'}`);
  lines.push(`  Edge: ${Number.isFinite(edge) ? `${(edge * 100).toFixed(1)}%` : 'n/a'}`);
  lines.push(`  Reasoning: ${clipText(bet?.reasoning || 'n/a', 260)}`);

  const keyFactors = Array.isArray(bet?.keyFactors)
    ? bet.keyFactors.map((k) => clipText(k, 120)).filter(Boolean)
    : [];
  if (keyFactors.length > 0) {
    lines.push(`  Key Factors: ${keyFactors.join(' | ')}`);
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are an expert meteorologist and weather betting advisor for Polymarket prediction markets.

YOU MUST USE ONLY THE PROVIDED DATA (NO WEB SEARCH):
- Event title, description, and resolution details from Polymarket
- OpenWeatherMap current observed weather + 5-day / 3-hour forecast data already fetched by the bot
- NOAA CDO v2 daily observations sampled at event-end aligned timing: last 2 days + same date/time in each of last 5 years
- Outcome prices and odds movement context

CRITICAL RESOLUTION RULES:
- Polymarket weather events often resolve to whole-degree Celsius values
- Use the forecast period closest to the event resolution timestamp (marked with <<<EVENT)
- If nearest periods are borderline between two outcomes, lower confidence
- If the event description says resolution uses whole degrees (for example "9°C"), treat this as integer precision from the source feed, not decimal rounding from your model forecast.
- For single-degree buckets (e.g., "be 10°C"), do NOT round decimal forecasts up; use conservative integer mapping (9.8°C aligns with 9°C unless strong evidence supports 10°C in the source's finalized whole-degree record).
- For range buckets (e.g., "between 9-10°C"), map using integer precision consistently and avoid optimistic rounding-up.

YOU WILL RECEIVE A SINGLE WEATHER EVENT with all its market outcomes (temperature buckets, etc.).
Each outcome is a separate YES/NO market for one bucket — exactly one bucket resolves YES.
Your job: either propose 1 YES-side bet on the single most likely outcome bucket, or propose no bet.
You may propose 0 bets (empty array) if confidence/edge is insufficient.

FOR THE EVENT YOU RECEIVE:
- Event title and description (includes resolution source text)
- Available outcomes with current odds (prices 0-1) and YES/NO token prices
- Price spread and which side is currently cheapest (context only, not a strict rule)
- OpenWeatherMap forecast periods around resolution time
- OpenWeatherMap current observed conditions for the location
- NOAA station-based climate daily samples aligned to event-end timing for recent days and years -1 to -5
- Price change context for each outcome over 24h, 6h, 1h (plus short-term 10m)
- Active bets, recent history, and recent AI accuracy

YOUR ANALYSIS MUST COVER:
1. Forecast confidence near resolution time
2. Forecast uncertainty (temperature swing, wind/precip volatility)
3. NOAA climate signal consistency (recent observed highs/lows/precip vs forecast path)
4. Seasonal context from same-window NOAA data across the last 5 years
5. Market mispricing: estimated probability vs implied market probability
6. Time proximity: events resolving sooner should have tighter confidence bands
7. Price momentum/regime from 24h, 6h, and 1h changes and whether movement supports or contradicts forecast view
8. Cheap side opportunity assessment (optional) — may bet non-cheap side when evidence is stronger
9. Resolution precision alignment: ensure selected bucket matches whole-degree source precision rules in the event description

BETTING DECISION FRAMEWORK:
- You may propose 0 or 1 bet only (never more than one)
- If proposing a bet, it MUST be the YES side on the single most likely temperature outcome bucket
- Prefer bets where combined evidence is clear: forecast confidence + market pricing + 24h/6h/1h movement
- Do NOT force bets. An empty bets array is perfectly valid.
- NO-side picks are not allowed
- Require at least 3% edge (estimatedProbability - marketImpliedProbability >= 0.03)
- Only propose bets where the selected side share price is within configured runtime bounds (MIN_ODDS_VALUE to MAX_ODDS_VALUE; defaults 0.05 to 0.70)
- Bet sizing rule: normally target about $1 notional, but when selected outcome price is below 0.20 the bot places a fixed 5-share order

IMPORTANT — NEG-RISK MULTI-OUTCOME MARKETS:
- Each outcome is a separate YES/NO market for one temperature bucket
- Exactly one bucket resolves YES
- predictedOutcome must be the exact outcome question string provided
- side must be "YES"

RESOLUTION PRECISION SAFETY:
- Event description resolution rules are authoritative.
- If description specifies whole-degree precision, avoid choosing a higher single-degree bucket based only on decimal forecast rounding.
- When precision interpretation is ambiguous, reduce confidence or return NO BET.

LOSING STREAK AWARENESS:
- If recent history shows losses, be more conservative
- Never chase losses

Respond ONLY with valid JSON matching the required schema.`;

const BET_PROPERTIES = {
  predictedOutcome: {
    type: 'string',
    description: 'The exact market outcome question string to bet on',
  },
  side: {
    type: 'string',
    description: 'Which side to buy. Must always be "YES"',
    enum: ['YES'],
  },
  confidence: {
    type: 'number',
    description: 'Confidence level 0-100 in the prediction',
  },
  estimatedProbability: {
    type: 'number',
    description: 'Estimated true probability (0-1) of the chosen side being correct',
  },
  edge: {
    type: 'number',
    description: 'Edge over market: estimatedProbability - marketImpliedProbability. Positive = value bet.',
  },
  reasoning: {
    type: 'string',
    description: 'Concise reasoning for this specific bet (max 500 chars)',
  },
  keyFactors: {
    type: 'array',
    items: { type: 'string' },
    description: 'Top 3-5 key factors that influenced this bet',
  },
};

const BET_REQUIRED = [
  'predictedOutcome', 'side', 'confidence', 'estimatedProbability',
  'edge', 'reasoning', 'keyFactors',
];

const BETTING_DECISION_SCHEMA = {
  type: 'json_schema',
  name: 'betting_decision',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      forecastSummary: {
        type: 'string',
        description: 'Brief summary of the weather forecast relevant to this event',
      },
      uncertaintyAssessment: {
        type: 'string',
        description: 'Assessment of forecast uncertainty and confidence level',
      },
      climateSignalSummary: {
        type: 'string',
        description: 'How NOAA climate observations support or weaken the forecast thesis',
      },
      owmResolutionAlignment: {
        type: 'string',
        description: 'How the OWM period nearest event resolution was mapped to the predicted outcome',
      },
      bets: {
        type: 'array',
        description: 'Array of 0-1 YES-side bet proposals for the single best outcome. Empty array = no bet.',
        minItems: 0,
        maxItems: 1,
        items: {
          type: 'object',
          properties: BET_PROPERTIES,
          required: BET_REQUIRED,
          additionalProperties: false,
        },
      },
    },
    required: ['forecastSummary', 'uncertaintyAssessment', 'climateSignalSummary', 'owmResolutionAlignment', 'bets'],
    additionalProperties: false,
  },
};

async function runAnalysisRequest(userMessage) {
  log.info(`OpenAI request: model=${config.openaiModel} prompt_chars=${userMessage.length}`);

  const response = await retryWithBackoff(
    () => client.responses.create({
      model: config.openaiModel,
      instructions: SYSTEM_PROMPT,
      input: userMessage,
      text: { format: BETTING_DECISION_SCHEMA },
      store: false,
    }),
    {
      maxRetries: 3,
      baseDelayMs: 2000,
      label: 'AI event request',
      shouldRetry: (err) => {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('401') || msg.includes('invalid api key') || msg.includes('schema')) return false;
        return true;
      },
    },
  );

  const usage = response?.usage || {};
  log.info(`OpenAI result: input_tokens=${usage.input_tokens ?? 'n/a'} output_tokens=${usage.output_tokens ?? 'n/a'} total_tokens=${usage.total_tokens ?? 'n/a'} | ${summarizeOpenAIOutput(response?.output_text || '')}`);
  return response;
}

/**
 * Format event data for the AI prompt.
 */
function formatEventPrompt(event, weatherText, priceHistories) {
  const outcomesStr = event.outcomes
    .map(o => {
      const ph = priceHistories[o.outcome];
      let trend = '';
      if (ph) {
        const fmt = (v) => v !== null && v !== undefined ? `${(v * 100).toFixed(1)}%` : 'N/A';
        trend = `\n      Price changes: 24h: ${fmt(ph.change24h)}, 6h: ${fmt(ph.change6h)}, 1h: ${fmt(ph.change1h)}, 10m: ${fmt(ph.change10m)}`;
      }
      return `  - "${o.outcome}" YES price: ${o.price ?? 'N/A'} (implied: ${o.price ? (o.price * 100).toFixed(1) + '%' : 'N/A'}) | NO price: ${o.noPrice ?? 'N/A'}${trend}`;
    })
    .join('\n');

  let block = `WEATHER EVENT ANALYSIS
══════════════════════════════════════════════════
Title: ${event.title}
Description: ${event.description || 'N/A'}
Category: ${event.category || 'general'}
Location: ${event.location || 'unknown'}
Resolution: ${event.endTime}
Price Spread: ${event.spread?.toFixed(3) ?? 'N/A'}
Cheap Side: ${event.cheapSide ? `${event.cheapSide.side} @ ${event.cheapSide.price?.toFixed(3)} ("${event.cheapSide.outcome}")` : 'N/A'}

Available Outcomes (each is a separate YES/NO market):
${outcomesStr}`;

  if (weatherText && weatherText.trim().length > 0) {
    block += `\n\nWeather Data:\n${weatherText}`;
  }

  return block;
}

/**
 * Analyze a single weather event and propose at most 1 YES-side bet.
 *
 * @param {object} params
 * @param {object} params.event - Event object with outcomes
 * @param {string} params.weatherText - Combined OWM + NOAA text
 * @param {object} params.priceHistories - Price histories keyed by outcome
 * @param {object[]} recentBets - Last 30 bets for context
 * @param {object[]} activeBets - Currently active bets
 * @param {string} accuracySummary - AI accuracy feedback string
 * @returns {Promise<{bets: object[], forecastSummary: string, _tokenUsage: object|null}>}
 */
export async function analyzeWeatherEvent({ event, weatherText, priceHistories }, recentBets, activeBets, accuracySummary = '') {
  const eventBlock = formatEventPrompt(event, weatherText, priceHistories);

  const activeBetsStr = activeBets.map(b =>
    `${b.event_title || 'Event'} -> ${b.predicted_outcome} (${b.status}) odds:${b.odds_at_bet}`
  ).join('\n');

  let userMessage = `${eventBlock}

═══════════════════════════════════════════

ACTIVE BETS (${activeBets.length}/${config.maxActiveBets}):
${activeBetsStr || 'None'}`;

  const resolvedBets = recentBets.filter(b => b.status === 'resolved');
  let losingStreak = 0;
  for (let i = resolvedBets.length - 1; i >= 0; i--) {
    if (resolvedBets[i].result === 'lost') losingStreak++;
    else break;
  }

  if (resolvedBets.length > 0) {
    const betLines = resolvedBets.slice(-10).map(b => {
      const status = b.result === 'won' ? 'W' : 'L';
      return `${b.placed_at?.slice(0, 10) || '?'} ${b.event_title || 'Event'} -> ${b.predicted_outcome} (${status}) odds:${b.odds_at_bet}`;
    }).join('\n');
    let header = 'RECENT BET HISTORY';
    if (losingStreak >= 2) header += ` (WARNING: ${losingStreak}-bet losing streak)`;
    userMessage += `\n\n${header}:\n${betLines}`;
  }

  if (accuracySummary) {
    userMessage += `\n\nYOUR RECENT ACCURACY:\n${accuracySummary}`;
  }

  userMessage += `\n\nAnalyze this event using the weather forecast and climate data. Recommend either BET or NO BET. If BET, return exactly one bet and it must be YES side for the single most likely temperature outcome bucket. Respect event-description precision rules exactly: when resolution says whole degrees, do not round decimal forecasts up to pick a higher single-degree bucket (e.g., 9.8 should map conservatively to 9 unless strong source-evidence supports 10). If confidence is too low or precision is ambiguous, return an empty bets array. Require >= 3% edge.`;

  log.info(`AI analyzing: "${event.title?.slice(0, 60)}"`);
  log.debug(`AI prompt length: ${userMessage.length} chars`);

  const emptyResult = {
    bets: [],
    forecastSummary: '',
    uncertaintyAssessment: '',
    climateSignalSummary: '',
    owmResolutionAlignment: '',
    _tokenUsage: null,
  };

  try {
    const response = await runAnalysisRequest(userMessage);
    const outputText = response?.output_text || '';

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch (err) {
      logDetailedError(log, 'Failed to parse AI response', err, {
        outputPreview: outputText.slice(0, 500),
      });
      return emptyResult;
    }

    const rawBets = Array.isArray(parsed?.bets) ? parsed.bets.slice(0, 1) : [];
    const seenOutcomes = new Set();
    const bets = [];

    // Defensive normalization: only allow one valid YES-side proposal.
    for (const b of rawBets) {
      const predictedOutcome = String(b?.predictedOutcome || '').trim();
      if (!predictedOutcome) continue;

      const side = 'YES';

      const outcomeKey = predictedOutcome.toLowerCase();
      if (seenOutcomes.has(outcomeKey)) continue;
      seenOutcomes.add(outcomeKey);

      bets.push({ ...b, predictedOutcome, side });
    }
    const usage = response.usage;
    const tokenUsage = usage
      ? { input: usage.input_tokens, output: usage.output_tokens, total: usage.total_tokens }
      : null;

    if (tokenUsage) log.debug(`AI tokens: ${tokenUsage.total}`);

    log.info(`\n${formatDecisionLog(event?.title, parsed, bets)}`);

    for (const bet of bets) {
      log.info(`  AI bet: "${bet.predictedOutcome}" ${bet.side} confidence=${bet.confidence}% edge=${((bet.edge || 0) * 100).toFixed(1)}%`);

      emitEvent('ai', 'ai_analysis', {
        event: event.title,
        category: event.category,
        predictedOutcome: bet.predictedOutcome,
        side: bet.side,
        confidence: bet.confidence,
        estimatedProbability: bet.estimatedProbability,
        edge: bet.edge,
        tokenUsage,
      });
    }

    if (bets.length === 0) {
      log.info(`  AI says NO BETS for "${event.title?.slice(0, 50)}"`);
    }

    return {
      bets,
      forecastSummary: parsed?.forecastSummary || '',
      uncertaintyAssessment: parsed?.uncertaintyAssessment || '',
      climateSignalSummary: parsed?.climateSignalSummary || '',
      owmResolutionAlignment: parsed?.owmResolutionAlignment || '',
      _tokenUsage: tokenUsage,
    };
  } catch (err) {
    logDetailedError(log, 'AI analysis failed', err, {
      event: event?.title || null,
      category: event?.category || null,
    });
    return { ...emptyResult, _tokenUsage: null };
  }
}
