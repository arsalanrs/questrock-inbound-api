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

const BORROWER_LOAN_PROFILE_KEYS = [
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
];

const PAYMENT_BREAKDOWN_SCHEMA_KEYS = [
  'monthly_payment_total',
  'principal_and_interest',
  'property_taxes',
  'homeowners_insurance',
  'hoa',
  'pmi',
  'notes',
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
  ...BORROWER_LOAN_PROFILE_KEYS,
  ...BORROWER_PAYMENT_FIELD_KEYS,
]);

function stringField() {
  return { type: 'string' };
}

function objectSchema(keys) {
  const properties = Object.fromEntries(uniqueKeyList(keys).map((key) => [key, stringField()]));
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
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

  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    node.required = Object.keys(node.properties);
    node.additionalProperties = false;
  } else if (Array.isArray(node.required)) {
    node.required = uniqueKeyList(node.required);
  }

  for (const value of Object.values(node)) {
    uniquifyJsonSchemaRequired(value);
  }

  return node;
}

export const CALL_INTELLIGENCE_JSON_SCHEMA = objectSchema(CALL_INTELLIGENCE_FIELD_KEYS);

export const BORROWER_LOAN_DETAILS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    ...Object.fromEntries(BORROWER_LOAN_PROFILE_KEYS.map((key) => [key, stringField()])),
    payment_breakdown: objectSchema(PAYMENT_BREAKDOWN_SCHEMA_KEYS),
  },
  required: [...BORROWER_LOAN_PROFILE_KEYS, 'payment_breakdown'],
  additionalProperties: false,
};

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
  const breakdown = raw?.payment_breakdown && typeof raw.payment_breakdown === 'object' ? raw.payment_breakdown : {};

  for (const key of BORROWER_LOAN_PROFILE_KEYS) {
    normalized[key] = String(raw[key] ?? '').trim();
  }

  normalized.monthly_payment_total = String(
    breakdown.monthly_payment_total ?? raw.monthly_payment_total ?? '',
  ).trim();
  normalized.principal_and_interest = String(
    breakdown.principal_and_interest ?? raw.principal_and_interest ?? '',
  ).trim();
  normalized.property_taxes = String(breakdown.property_taxes ?? raw.property_taxes ?? '').trim();
  normalized.hoa = String(breakdown.hoa ?? raw.hoa ?? '').trim();
  normalized.payment_homeowners_insurance = String(
    breakdown.homeowners_insurance ?? raw.payment_homeowners_insurance ?? '',
  ).trim();
  normalized.payment_pmi = String(breakdown.pmi ?? raw.payment_pmi ?? '').trim();
  normalized.payment_breakdown_notes = String(
    breakdown.notes ?? raw.payment_breakdown_notes ?? '',
  ).trim();

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
