/** Structured mortgage call intelligence extracted from inbound transcripts. */

export const CALL_INTELLIGENCE_FIELD_KEYS = [
  'lead_temperature',
  'loan_type',
  'transaction_type',
  'timeline',
  'property_state',
  'property_type',
  'income_type',
  'credit_discussed',
  'realtor_involved',
  'realtor_name',
  'competitor_mentioned',
  'competitor_names',
  'main_objections',
  'rate_payment_discussed',
  'rate_payment_summary',
  'documents_promised',
  'follow_up_promised',
  'follow_up_details',
  'appointment_set',
  'appointment_details',
  'next_action',
  'compliance_concerns',
  'lo_coaching_opportunities',
  'quick_brief',
];

export const BORROWER_PAYMENT_FIELD_KEYS = [
  'monthly_payment_total',
  'principal_and_interest',
  'property_taxes',
  'payment_homeowners_insurance',
  'hoa',
  'payment_pmi',
  'payment_breakdown_notes',
];

function uniqueKeyList(keys) {
  return [...new Set(keys)];
}

export const BORROWER_LOAN_DETAIL_KEYS = uniqueKeyList([
  'mortgage_balance',
  'property_value',
  'interest_rate',
  'loan_term',
  'years_remaining',
  'pmi',
  'homeowners_insurance',
  'hoi_period',
  'property_tax',
  'property_tax_period',
  'flood_insurance',
  'flood_period',
  ...BORROWER_PAYMENT_FIELD_KEYS,
]);

function stringField() {
  return { type: 'string' };
}

function objectSchema(keys) {
  const uniqueKeys = uniqueKeyList(keys);
  const properties = Object.fromEntries(uniqueKeys.map((key) => [key, stringField()]));
  return {
    type: 'object',
    properties,
    required: uniqueKeys,
    additionalProperties: false,
  };
}

/** OpenAI strict json_schema rejects duplicate strings in any `required` array. */
export function uniquifyJsonSchemaRequired(node) {
  if (!node || typeof node !== 'object') {
    return node;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      uniquifyJsonSchemaRequired(item);
    }
    return node;
  }

  if (Array.isArray(node.required)) {
    node.required = uniqueKeyList(node.required);
  }

  for (const value of Object.values(node)) {
    uniquifyJsonSchemaRequired(value);
  }

  return node;
}

export const CALL_INTELLIGENCE_JSON_SCHEMA = objectSchema(CALL_INTELLIGENCE_FIELD_KEYS);

export const BORROWER_LOAN_DETAILS_JSON_SCHEMA = objectSchema(BORROWER_LOAN_DETAIL_KEYS);

export const AUTO_FLAG_JSON_SCHEMA = {
  type: 'object',
  properties: {
    flag_code: { type: 'string' },
    severity: { type: 'string' },
    category: { type: 'string' },
    title: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['flag_code', 'severity', 'category', 'title', 'detail'],
  additionalProperties: false,
};

export function emptyCallIntelligence() {
  return Object.fromEntries(CALL_INTELLIGENCE_FIELD_KEYS.map((key) => [key, '']));
}

export function emptyBorrowerLoanDetails() {
  return Object.fromEntries(BORROWER_LOAN_DETAIL_KEYS.map((key) => [key, '']));
}

export function normalizeCallIntelligence(raw = {}) {
  const normalized = emptyCallIntelligence();
  for (const key of CALL_INTELLIGENCE_FIELD_KEYS) {
    normalized[key] = String(raw[key] ?? '').trim();
  }
  return normalized;
}

export function normalizeBorrowerLoanDetails(raw = {}) {
  const normalized = emptyBorrowerLoanDetails();
  for (const key of BORROWER_LOAN_DETAIL_KEYS) {
    normalized[key] = String(raw[key] ?? '').trim();
  }
  return normalized;
}

export function normalizeAutoFlags(raw = []) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((row) => ({
      flag_code: String(row?.flag_code ?? '').trim(),
      severity: String(row?.severity ?? 'medium').trim().toLowerCase(),
      category: String(row?.category ?? 'conversion').trim().toLowerCase(),
      title: String(row?.title ?? '').trim(),
      detail: String(row?.detail ?? '').trim(),
    }))
    .filter((row) => row.flag_code && row.title);
}
