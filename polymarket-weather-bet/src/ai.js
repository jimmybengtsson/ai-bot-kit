import OpenAI from 'openai';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { retryWithBackoff } from './retry.js';

const log = createLogger('ai');
const client = new OpenAI({ apiKey: config.openaiApiKey });

const PICK_SCHEMA = {
  type: 'json_schema',
  name: 'temperature_pick',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      shouldBet: { type: 'boolean' },
      selectedOutcome: { type: 'string' },
      confidence: { type: 'number' },
      reasoning: { type: 'string' },
    },
    required: ['shouldBet', 'selectedOutcome', 'confidence', 'reasoning'],
    additionalProperties: false,
  },
};

const VALIDATION_SCHEMA = {
  type: 'json_schema',
  name: 'temperature_validation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      agrees: { type: 'boolean' },
      reasoning: { type: 'string' },
    },
    required: ['agrees', 'reasoning'],
    additionalProperties: false,
  },
};

const PICK_SYSTEM_PROMPT = [
  'You are a meteorological decision engine for Polymarket temperature markets.',
  'Your task is to choose at most one best temperature outcome bucket for a single event.',
  'The target variable is the highest temperature for the full event day (00:00-23:59 local day), not temperature at resolution timestamp.',
  'Use ONLY the provided weather context text and event metadata. Do not invent sources or facts.',
  '',
  'Decision objective:',
  '- Maximize correctness of outcome-bucket selection, not narrative quality.',
  '- If confidence is weak or outcome mapping is ambiguous, set shouldBet=false.',
  '',
  'Critical mapping rules:',
  '- selectedOutcome must match one provided outcome string exactly (character-for-character).',
  '- Pick the bucket for the day\'s peak temperature, not a single-hour reading at resolution time.',
  '- Market resolution uses whole degrees Celsius; do not treat decimal forecast values as direct resolvers.',
  '- Convert decimal forecast signals into likely whole-degree outcomes before mapping to buckets.',
  '- Do not return shouldBet=false only because forecast values include decimals.',
  '- If event resolution likely uses whole-degree precision, prefer conservative mapping over optimistic rounding up.',
  '- If data supports multiple adjacent buckets similarly, or boundary/rounding ambiguity is material, prefer shouldBet=false.',
  '',
  'Reasoning quality rules:',
  '- reasoning must briefly cite concrete signals from provided context (forecast periods, current conditions, climate consistency).',
  '- No chain-of-thought; return concise rationale only.',
  '',
  'Output policy:',
  '- Return JSON only, matching the provided JSON schema exactly.',
  '- confidence must be numeric and interpreted as 0-100.',
  '- When shouldBet=false, selectedOutcome should be an empty string.',
].join('\n');

const VALIDATION_SYSTEM_PROMPT = [
  'You are an independent weather-bet validator for Polymarket temperature outcomes.',
  'You receive a prior pick and must verify if it remains the strongest choice from provided data only.',
  'Do not defer to the first pick; reassess independently.',
  '',
  'Validation criteria:',
  '- Does the selected outcome still align best with the expected full-day highest temperature (not just resolution hour)?',
  '- Does whole-degree Celsius resolution support the selected bucket after handling decimal forecast noise?',
  '- Is climate context directionally consistent with the selected bucket?',
  '- Is mapping to bucket boundaries/precision defensible?',
  '- If uncertainty is material or another bucket is similarly likely, return agrees=false.',
  '',
  'Output policy:',
  '- Return JSON only, matching the provided JSON schema exactly.',
  '- reasoning must be concise and specific to the acceptance/rejection decision.',
].join('\n');

function outcomesBlock(event) {
  return event.outcomes.map((o) => `- ${o.outcome}${o.label ? ` [label: ${o.label}]` : ''}`).join('\n');
}

function schemaReferenceBlock(schema) {
  const obj = schema?.schema || {};
  const required = Array.isArray(obj.required) ? obj.required.join(', ') : '';
  const fields = Object.entries(obj.properties || {}).map(([key, def]) => {
    const t = Array.isArray(def?.type) ? def.type.join('|') : def?.type || 'unknown';
    return `- ${key}: ${t}`;
  }).join('\n');

  return [
    'Response JSON schema reference (must match exactly):',
    `Schema name: ${schema?.name || 'unknown'}`,
    `Required fields: ${required || 'none'}`,
    'Fields:',
    fields || '- none',
  ].join('\n');
}

async function callStructured(instructions, input, schema) {
  const response = await retryWithBackoff(
    () => client.responses.create({
      model: config.openaiModel,
      instructions,
      input,
      text: { format: schema },
      store: false,
    }),
    { maxRetries: 2, baseDelayMs: 1400, label: 'OpenAI call' },
  );

  return JSON.parse(response?.output_text || '{}');
}

export async function chooseTemperatureOutcome(event, weatherContextText) {
  const instructions = PICK_SYSTEM_PROMPT;
  const eventDateUtc = new Date(event.endTime).toISOString().slice(0, 10);

  const input = [
    'Task: Choose zero or one outcome for YES-side consideration.',
    'Do not use market odds in this selection stage.',
    'Interpretation rule: choose the bucket for the highest temperature of the full event day, not the value at resolution time.',
    'Precision rule: market resolves at whole degrees Celsius; decimal forecast points are guidance, not direct resolution values.',
    `Event: ${event.title}`,
    `Event description: ${event.description || 'n/a'}`,
    `Location: ${event.location || 'unknown'}`,
    `Resolution time: ${event.endTime}`,
    `Target day (UTC date anchor): ${eventDateUtc}`,
    'Available temperature outcomes:',
    outcomesBlock(event),
    '',
    'Weather data:',
    weatherContextText,
    '',
    schemaReferenceBlock(PICK_SCHEMA),
  ].join('\n');

  const parsed = await callStructured(instructions, input, PICK_SCHEMA);
  log.info(
    `AI pick: shouldBet=${parsed.shouldBet} selected="${parsed.selectedOutcome}" confidence=${parsed.confidence} reasoning="${parsed.reasoning || ''}"`,
  );
  return parsed;
}

export async function validateTemperatureOutcome(event, weatherContextText, firstPick) {
  const instructions = VALIDATION_SYSTEM_PROMPT;
  const eventDateUtc = new Date(event.endTime).toISOString().slice(0, 10);

  const input = [
    'Task: Validate whether prior selection should still be accepted.',
    'Interpretation rule: validate against highest temperature of the full event day, not temperature at resolution time.',
    'Precision rule: market resolves at whole degrees Celsius; decimal forecast points are guidance, not direct resolution values.',
    `Event: ${event.title}`,
    `Event description: ${event.description || 'n/a'}`,
    `Location: ${event.location || 'unknown'}`,
    `Resolution time: ${event.endTime}`,
    `Target day (UTC date anchor): ${eventDateUtc}`,
    'Available temperature outcomes:',
    outcomesBlock(event),
    '',
    `First AI selected outcome: ${firstPick.selectedOutcome}`,
    `First AI reasoning: ${firstPick.reasoning}`,
    '',
    'Weather data:',
    weatherContextText,
    '',
    schemaReferenceBlock(VALIDATION_SCHEMA),
  ].join('\n');

  const parsed = await callStructured(instructions, input, VALIDATION_SCHEMA);
  log.info(`AI validator: agrees=${parsed.agrees} reasoning="${parsed.reasoning || ''}"`);
  return parsed;
}
