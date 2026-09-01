import { EXTRACTABLE_FIELDS } from './field-catalog.js';
import { mergeFieldsForShapeUpdate } from './normalize-fields.js';
import {
  buildEvaluationSystemPrompt,
  buildEvaluationUserPrompt,
} from './prompts.js';
import { RAY_COACHING_SCHEMA } from './ray-coaching-schema.js';
import { formatRayCoachingText, normalizeRayCoaching } from './ray-coaching-format.js';
import { redactTranscriptPii } from '../transcript-redact.js';
import {
  AUTO_FLAG_JSON_SCHEMA,
  BORROWER_LOAN_DETAILS_JSON_SCHEMA,
  CALL_INTELLIGENCE_JSON_SCHEMA,
  normalizeAutoFlags,
  normalizeBorrowerLoanDetails,
  normalizeCallIntelligence,
  uniquifyJsonSchemaRequired,
} from './call-intelligence-schema.js';
import { computeCallFlags } from './compute-call-flags.js';

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'questrock_call_evaluation',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        status_label: { type: 'string' },
        status_rationale: { type: 'string' },
        call_summary: { type: 'string' },
        ops_notes: { type: 'string' },
        questrock_analysis: {
          type: 'object',
          properties: {
            context_and_participants: { type: 'string' },
            financial_and_loan_profile: { type: 'string' },
            sales_pitch_and_value: { type: 'string' },
            friction_and_barriers: { type: 'string' },
            next_steps_and_status: { type: 'string' },
            borrower_loan_details: BORROWER_LOAN_DETAILS_JSON_SCHEMA,
          },
          required: [
            'context_and_participants',
            'financial_and_loan_profile',
            'sales_pitch_and_value',
            'friction_and_barriers',
            'next_steps_and_status',
            'borrower_loan_details',
          ],
          additionalProperties: false,
        },
        call_intelligence: CALL_INTELLIGENCE_JSON_SCHEMA,
        auto_flags: {
          type: 'array',
          items: AUTO_FLAG_JSON_SCHEMA,
        },
        ray_coaching: RAY_COACHING_SCHEMA,
        lead_fields: {
          type: 'object',
          properties: {
            full_name: { type: 'string' },
            email: { type: 'string' },
            current_address: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            zip_code: { type: 'string' },
            company_name: { type: 'string' },
          },
          required: [
            'full_name',
            'email',
            'current_address',
            'city',
            'state',
            'zip_code',
            'company_name',
          ],
          additionalProperties: false,
        },
        extracted_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              value: { type: 'string' },
              confidence: { type: 'number' },
              overwrite: { type: 'boolean' },
            },
            required: ['field', 'value', 'confidence', 'overwrite'],
            additionalProperties: false,
          },
        },
      },
      required: [
        'status_label',
        'status_rationale',
        'call_summary',
        'ops_notes',
        'questrock_analysis',
        'call_intelligence',
        'auto_flags',
        'ray_coaching',
        'lead_fields',
        'extracted_fields',
      ],
      additionalProperties: false,
    },
  },
};

export const CALL_EVALUATION_SCHEMA_VERSION = '2026-09-02-nested-payment';

function buildResponseFormat() {
  const schema = uniquifyJsonSchemaRequired(
    JSON.parse(JSON.stringify(RESPONSE_FORMAT.json_schema.schema)),
  );
  return {
    type: 'json_schema',
    json_schema: {
      name: 'questrock_call_evaluation',
      strict: true,
      schema,
    },
  };
}

function parseJsonContent(content) {
  const trimmed = String(content ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('OpenAI returned invalid JSON.');
  }
}

function isSchemaRejected(message) {
  return /invalid schema|non-unique elements|response_format/i.test(String(message ?? ''));
}

async function requestChatCompletion({ apiKey, model, system, user, responseFormat }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.05,
      max_completion_tokens: 10_000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: responseFormat,
    }),
  });

  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    const error = new Error('OpenAI returned non-JSON.');
    error.statusCode = 502;
    throw error;
  }

  return { ok: response.ok, data, rawText };
}

function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}\n\n...[truncated]`;
}

function mapLeadFieldsToTable(leadFields = {}) {
  return {
    full_name: leadFields.full_name || null,
    email: leadFields.email || null,
    current_address: leadFields.current_address || null,
    city: leadFields.city || null,
    state: leadFields.state || null,
    zip_code: leadFields.zip_code || null,
    company_name: leadFields.company_name || null,
  };
}

function buildTranscriptHistoryText(transcriptHistory) {
  const total = transcriptHistory.length;

  return transcriptHistory
    .map((row, index) => {
      const callNum = index + 1;
      const isLatest = index === total - 1;
      const priorStatus = row.ai_status_label?.trim();
      const headerParts = [
        `Call ${callNum} of ${total}`,
        row.call_source ?? 'unknown',
        row.timestamp ?? 'unknown',
      ];
      if (priorStatus) {
        headerParts.push(`AI status after this call: ${priorStatus}`);
      }
      if (isLatest) {
        headerParts.push('← NEWEST (this segment sets CRM status — read prior calls for context)');
      }

      const text = row.transcript_text?.trim();
      if (!text) {
        return `[${headerParts.join(' · ')} — call event, no transcript text]`;
      }

      return `[${headerParts.join(' · ')}]\n${redactTranscriptPii(text)}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Reads full transcript history, classifies status, and extracts Shape CRM fields.
 */
export async function evaluateCallWithAi({
  lead,
  shapeLead = {},
  transcriptHistory,
  latestTranscriptText,
  statusDefinitions,
}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const error = new Error('Missing OPENAI_API_KEY environment variable.');
    error.statusCode = 500;
    throw error;
  }

  const allowedStatuses = new Set(statusDefinitions.map((row) => row.status_label));
  const allowedFieldSet = new Set(EXTRACTABLE_FIELDS);
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const system = buildEvaluationSystemPrompt();
  const user = buildEvaluationUserPrompt({
    statusDefinitions,
    lead,
    shapeLead,
    transcriptHistoryText: truncate(buildTranscriptHistoryText(transcriptHistory), 30_000),
    latestTranscriptText: truncate(redactTranscriptPii(latestTranscriptText), 12_000),
  });

  let result = await requestChatCompletion({
    apiKey,
    model,
    system,
    user,
    responseFormat: buildResponseFormat(),
  });

  if (!result.ok) {
    const message = result.data?.error?.message || result.rawText.slice(0, 400);
    if (isSchemaRejected(message)) {
      console.warn(
        `[evaluate-call] ${CALL_EVALUATION_SCHEMA_VERSION} schema rejected, retrying json_object:`,
        message.slice(0, 240),
      );
      result = await requestChatCompletion({
        apiKey,
        model,
        system: `${system}\n\nReturn a single JSON object with the same keys described above.`,
        user,
        responseFormat: { type: 'json_object' },
      });
    }

    if (!result.ok) {
      const retryMessage = result.data?.error?.message || result.rawText.slice(0, 400);
      const error = new Error(`OpenAI: ${retryMessage}`);
      error.statusCode = 502;
      throw error;
    }
  }

  const content = result.data?.choices?.[0]?.message?.content;

  if (!content) {
    const error = new Error('OpenAI returned an empty completion.');
    error.statusCode = 502;
    throw error;
  }

  const parsed = parseJsonContent(content);

  if (!allowedStatuses.has(parsed.status_label)) {
    const error = new Error(
      `AI returned invalid status_label "${parsed.status_label}". Must match status_definitions exactly.`,
    );
    error.statusCode = 422;
    throw error;
  }

  const status = statusDefinitions.find((row) => row.status_label === parsed.status_label);
  const extractedRows = (parsed.extracted_fields ?? []).filter((row) =>
    allowedFieldSet.has(String(row.field ?? '').trim()),
  );

  const fieldsPopulated = mergeFieldsForShapeUpdate({
    extractedFields: extractedRows,
    existingShapeLead: shapeLead,
    minConfidence: Number(process.env.AI_MIN_FIELD_CONFIDENCE ?? 0.55),
  });

  const salesNotes = formatRayCoachingText(normalizeRayCoaching(parsed.ray_coaching));
  const opsNotes = String(parsed.ops_notes ?? '').trim();
  const questrockAnalysis = parsed.questrock_analysis ?? {};
  const rayCoaching = normalizeRayCoaching(parsed.ray_coaching);
  const callIntelligence = normalizeCallIntelligence(parsed.call_intelligence);
  const autoFlags = computeCallFlags({
    callIntelligence,
    aiFlags: normalizeAutoFlags(parsed.auto_flags),
    evaluation: { rayCoaching },
  });

  // Full LO coaching stays in sales_notes (Call Tracker). Shape notes_sidebar comes from extracted_fields only.
  if (opsNotes) {
    fieldsPopulated.notes_sidebar_ai_note = opsNotes;
  }

  return {
    status,
    statusRationale: parsed.status_rationale,
    callSummary: parsed.call_summary,
    salesNotes,
    opsNotes,
    rayCoaching,
    callIntelligence,
    autoFlags,
    questrockAnalysis: {
      context_and_participants: String(questrockAnalysis.context_and_participants ?? '').trim(),
      financial_and_loan_profile: String(questrockAnalysis.financial_and_loan_profile ?? '').trim(),
      sales_pitch_and_value: String(questrockAnalysis.sales_pitch_and_value ?? '').trim(),
      friction_and_barriers: String(questrockAnalysis.friction_and_barriers ?? '').trim(),
      next_steps_and_status: String(questrockAnalysis.next_steps_and_status ?? '').trim(),
      borrower_loan_details: normalizeBorrowerLoanDetails(questrockAnalysis.borrower_loan_details),
    },
    leadFields: mapLeadFieldsToTable(parsed.lead_fields),
    fieldsPopulated,
    extractedRows,
  };
}

export { EXTRACTABLE_FIELDS };
