import { aiReviewFromTranscriptFields } from '../transcript-ai-review.js';
import { redactTranscriptPii } from '../transcript-redact.js';
import { canViewUnredactedTranscripts } from '../inbound-access.js';
import { resolveCallDisplay } from './resolve-call-display.js';
import { slugFromShapeStatusLabel } from '../disposition/status-slug.js';
import { normalizePhoneDigits } from '../phone.js';
import { searchMailerLeads } from '../mailer-lo/search.js';
import {
  resolveCrmStatusLabel,
  resolveLendingPadUrl,
  resolveLoDisplayName,
  resolveShapeUrl,
} from './call-links.js';

const LEAD_EMBED = `
  lead_id,
  full_name,
  phone_number,
  shape_lead_id,
  lead_source,
  reference_code,
  current_status_label,
  current_status_color
`;

const ANSWERED_SELECT = `
  transcript_id,
  timestamp,
  external_call_id,
  call_source,
  fields_populated,
  ai_status_label,
  ai_status_color,
  leads (${LEAD_EMBED})
`;

const CALL_SEARCH_SELECT = `
  transcript_id,
  timestamp,
  external_call_id,
  call_source,
  fields_populated,
  ai_status_label,
  ai_status_color,
  transcript_text,
  lead_id,
  leads (${LEAD_EMBED})
`;

const TRANSCRIPT_SELECT = `
  transcript_id,
  external_call_id,
  ai_status_label,
  ai_status_color,
  timestamp,
  transcript_text,
  fields_populated,
  call_source,
  lead_id,
  leads (${LEAD_EMBED})
`;

function parseCallId(externalCallId) {
  const raw = String(externalCallId ?? '');
  if (raw.endsWith(':answered')) {
    return raw.slice(0, -':answered'.length);
  }
  if (raw.endsWith(':transcript')) {
    return raw.slice(0, -':transcript'.length);
  }
  if (raw.endsWith(':missed')) {
    return raw.slice(0, -':missed'.length);
  }
  if (raw.endsWith(':created')) {
    return raw.slice(0, -':created'.length);
  }
  return raw;
}

function channelFromMeta(meta, lead, callSource) {
  if (meta.call_channel === 'questmail' || meta.questmail_callback_matched_by) {
    return 'questmail';
  }
  if (lead?.lead_source === 'questmail' || lead?.lead_source === 'mail' || callSource === 'QuestMail') {
    return 'questmail';
  }
  if (meta.call_channel) {
    return meta.call_channel;
  }
  return 'inbound_zoom';
}

function formatChannel(channel, meta) {
  if (channel === 'shape_inbound') {
    const source = meta?.shape_source_label || meta?.leadsource || 'Shape lead';
    return { key: 'shape_inbound', label: source };
  }
  if (channel === 'questmail') {
    const label = meta?.questmail_label || (meta?.questmail_state ? `QuestMail ${meta.questmail_state}` : 'QuestMail');
    const type = meta?.questmail_type ? ` · ${meta.questmail_type}` : '';
    return { key: 'questmail', label: `${label}${type}` };
  }
  if (meta?.landing_page_label) {
    return { key: 'inbound_zoom', label: meta.landing_page_label };
  }
  return { key: 'inbound_zoom', label: 'Inbound Ads' };
}

function formatPhone10(phone10) {
  const d = String(phone10 ?? '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return phone10 || null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function normalizeLead(row) {
  return Array.isArray(row?.leads) ? row.leads[0] : row?.leads ?? {};
}

/** True when AI evaluation persisted review fields on the transcript row (not just default status copy). */
function hasTranscriptAiReview(transcriptRow) {
  if (!transcriptRow?.transcript_text?.trim()) {
    return false;
  }
  const fields = transcriptRow.fields_populated ?? {};
  if (String(fields.call_summary ?? '').trim()) {
    return true;
  }
  if (String(fields.status_rationale ?? '').trim()) {
    return true;
  }
  if (fields.deal_review && typeof fields.deal_review === 'object') {
    return true;
  }
  if (fields.call_intelligence && typeof fields.call_intelligence === 'object') {
    return true;
  }
  if (Array.isArray(fields.auto_flags) && fields.auto_flags.length) {
    return true;
  }
  const qa = fields.questrock_analysis;
  if (qa && typeof qa === 'object' && Object.values(qa).some((v) => String(v ?? '').trim())) {
    return true;
  }
  const rc = fields.ray_coaching;
  if (rc && typeof rc === 'object' && Object.values(rc).some((v) => String(v ?? '').trim())) {
    return true;
  }
  if (fields.shape_sync && typeof fields.shape_sync === 'object') {
    return true;
  }
  return false;
}

function buildCallRecord({
  callId,
  answeredAt,
  meta,
  lead,
  callSource,
  transcriptRow,
  missingAnsweredRow = false,
  viewerEmail = null,
}) {
  const channelKey = channelFromMeta(meta, lead, callSource);
  const channelInfo = formatChannel(channelKey, meta);
  const landingState = meta.landing_page_state || meta.questmail_state || null;
  const aiReview = aiReviewFromTranscriptFields(transcriptRow?.fields_populated);
  const showUnredacted = canViewUnredactedTranscripts(viewerEmail);
  const rawTranscript = transcriptRow?.transcript_text?.trim() || null;
  const transcriptText = rawTranscript
    ? showUnredacted
      ? rawTranscript
      : redactTranscriptPii(rawTranscript)
    : null;
  const aiReviewComplete = hasTranscriptAiReview(transcriptRow);
  const aiStatus = aiReviewComplete
    ? transcriptRow?.ai_status_label || lead.current_status_label || null
    : null;
  const aiColor = aiReviewComplete
    ? transcriptRow?.ai_status_color || lead.current_status_color || null
    : null;
  const questmailHold = Boolean(meta.questmail_hold);
  const shapeArrival = channelKey === 'shape_inbound';
  const loDispositionStatus = meta.lo_disposition_status || null;
  const loDispositionLabel = meta.lo_disposition_label || null;
  const loDispositionNote = meta.lo_disposition_note || null;
  const loDispositionAt = meta.lo_disposition_at || null;
  const loDispositionShapeSync = meta.lo_disposition_shape_sync || null;
  const dispositionEmailSentAt = meta.disposition_email_sent_at || null;
  const pendingDisposition = Boolean(meta.pending_disposition);
  const aiSuggestedSlug = aiStatus ? slugFromShapeStatusLabel(aiStatus) : null;
  const loDispositionMismatch =
    Boolean(aiSuggestedSlug && loDispositionStatus && aiSuggestedSlug !== loDispositionStatus);
  const isMissedCall = meta.call_outcome === 'missed' || meta.event === 'call_missed';
  const transcriptState = isMissedCall
    ? 'missed'
    : transcriptText
    ? aiReviewComplete
      ? 'reviewed'
      : 'needs_ai'
    : transcriptRow
      ? 'processing'
      : questmailHold
        ? 'awaiting_identification'
        : shapeArrival
          ? 'awaiting_call'
          : missingAnsweredRow
            ? 'needs_ai'
            : 'pending';

  const shapeLeadId = lead.shape_lead_id || meta.shape_lead_id || null;
  const loName = resolveLoDisplayName(meta, lead);
  const extractedFields = aiReview.extracted_fields || [];
  const lendingpadUrl = resolveLendingPadUrl(extractedFields, meta);

  const partial = {
    call_id: callId,
    lead_id: lead.lead_id ?? null,
    answered_at: answeredAt,
    call_outcome: meta.call_outcome || (isMissedCall ? 'missed' : 'answered'),
    miss_reason: meta.miss_reason || null,
    is_missed_call: isMissedCall,
    call_channel: channelKey,
    channel_label: channelInfo.label,
    landing_page_state: landingState,
    landing_page_label: meta.landing_page_label || null,
    questmail_label: meta.questmail_label || null,
    questmail_type: meta.questmail_type || null,
    questmail_toll: meta.questmail_toll || null,
    questmail_hold: questmailHold,
    missing_answered_row: missingAnsweredRow,
    is_shape_arrival: shapeArrival,
    shape_source_label: meta.shape_source_label || meta.leadsource || null,
    utm_campaign: meta.utm_campaign || null,
    dialed_number: meta.dialed_number || null,
    dialed_number_display: formatPhone10(meta.dialed_number),
    borrower_name: lead.full_name || 'Unknown Caller',
    phone: lead.phone_number || null,
    shape_lead_id: shapeLeadId,
    shape_url: resolveShapeUrl(shapeLeadId),
    reference_code: lead.reference_code || meta.reference_code || null,
    mailer_desk_url: (lead.reference_code || meta.reference_code)
      ? `https://questrock-inbound-api.vercel.app/mailer-lo/?q=${encodeURIComponent(lead.reference_code || meta.reference_code)}`
      : null,
    lo_name: loName,
    lo_email: meta.lo_email || null,
    lendingpad_url: lendingpadUrl,
    contact_found: Boolean(meta.contact_found),
    pending_disposition: pendingDisposition,
    disposition_email_sent_at: dispositionEmailSentAt,
    ai_status_label: aiStatus,
    ai_status_color: aiColor,
    lo_disposition_status: loDispositionStatus,
    lo_disposition_label: loDispositionLabel,
    lo_disposition_note: loDispositionNote,
    lo_disposition_at: loDispositionAt,
    lo_disposition_shape_sync: loDispositionShapeSync,
    lo_disposition_mismatch: loDispositionMismatch,
    ai_review_complete: aiReviewComplete,
    transcript_state: transcriptState,
    transcript_id: transcriptRow?.transcript_id ?? null,
    transcript_at: transcriptRow?.timestamp ?? null,
    transcript_text: transcriptText,
    needs_ai_analysis: Boolean(transcriptText && !aiReviewComplete),
    needs_mailer_link: channelKey === 'questmail' && (!aiReviewComplete || questmailHold || !lead.reference_code),
    call_summary: aiReview.call_summary,
    sales_notes: aiReview.sales_notes,
    ray_coaching: aiReview.ray_coaching,
    ops_notes: aiReview.ops_notes,
    status_rationale: aiReview.status_rationale,
    questrock_analysis: aiReview.questrock_analysis,
    call_intelligence: aiReview.call_intelligence,
    auto_flags: aiReview.auto_flags,
    deal_review: aiReview.deal_review,
    private_identity: aiReview.private_identity,
    deal_review_sync: aiReview.deal_review_sync,
    private_identity_sync: aiReview.private_identity_sync,
    transcript_unredacted: showUnredacted,
    extracted_fields: extractedFields,
    shape_sync: aiReview.shape_sync,
    lead_status_label: lead.current_status_label || null,
    archived_at: meta.archived_at || transcriptRow?.fields_populated?.archived_at || null,
    is_archived: Boolean(meta.archived_at || transcriptRow?.fields_populated?.archived_at),
    fields_populated: {
      ...(transcriptRow?.fields_populated ?? {}),
      ...meta,
    },
  };

  const crmStatus = resolveCrmStatusLabel(partial);

  return {
    ...partial,
    crm_status_label: crmStatus.label,
    crm_status_source: crmStatus.source,
  };
}

function withResolvedDisplay(record) {
  const display = resolveCallDisplay(record);

  return {
    ...record,
    borrower_name: display.display_name,
    phone: display.display_phone,
    lead_record_name: display.lead_name,
    lead_record_phone: display.lead_phone,
    inbound_questmail_line: display.inbound_line,
    display_name_corrected: display.name_corrected,
    display_name_source: display.name_source,
  };
}

function buildCallRecordResolved(args) {
  return withResolvedDisplay(buildCallRecord(args));
}

function resolveViewLabel(hours) {
  const h = Number(hours);
  if (h <= 24) return 'Today';
  if (h <= 168) return 'Week';
  if (h <= 720) return 'Month';
  return `${h}h`;
}

function assembleInboundCalls({
  answeredRows,
  missedRows,
  transcriptRows,
  shapeCreatedRows,
  channel,
  state,
  outcome,
  includeArchived,
  archivedOnly,
  viewerEmail,
  maxRows,
}) {
  const transcriptByCallId = new Map();
  for (const row of transcriptRows ?? []) {
    transcriptByCallId.set(parseCallId(row.external_call_id), row);
  }

  const calls = [];
  const listedCallIds = new Set();
  const stateFilter = state ? String(state).trim().toUpperCase() : null;
  const outcomeFilter = outcome ? String(outcome).trim().toLowerCase() : null;

  for (const row of answeredRows ?? []) {
    const lead = normalizeLead(row);
    const meta = row.fields_populated ?? {};
    const callId = parseCallId(row.external_call_id);

    const channelKey = channelFromMeta(meta, lead, row.call_source);
    const landingState = meta.landing_page_state || meta.questmail_state || null;

    if (channel && channel !== channelKey) {
      continue;
    }
    if (stateFilter && landingState !== stateFilter) {
      continue;
    }
    if (outcomeFilter === 'missed') {
      continue;
    }

    calls.push(
      buildCallRecordResolved({
        callId,
        answeredAt: row.timestamp,
        meta,
        lead,
        callSource: row.call_source,
        transcriptRow: transcriptByCallId.get(callId),
        viewerEmail,
      }),
    );
    listedCallIds.add(callId);
  }

  for (const row of missedRows ?? []) {
    const lead = normalizeLead(row);
    const meta = row.fields_populated ?? {};
    const callId = parseCallId(row.external_call_id);

    if (listedCallIds.has(callId)) {
      continue;
    }

    const channelKey = channelFromMeta(meta, lead, row.call_source);
    const landingState = meta.landing_page_state || meta.questmail_state || null;

    if (channel && channel !== channelKey) {
      continue;
    }
    if (stateFilter && landingState !== stateFilter) {
      continue;
    }
    if (outcomeFilter === 'answered') {
      continue;
    }

    calls.push(
      buildCallRecordResolved({
        callId,
        answeredAt: row.timestamp,
        meta,
        lead,
        callSource: row.call_source,
        transcriptRow: transcriptByCallId.get(callId) ?? null,
        viewerEmail,
      }),
    );
    listedCallIds.add(callId);
  }

  for (const [callId, transcriptRow] of transcriptByCallId) {
    if (listedCallIds.has(callId)) {
      continue;
    }

    const lead = normalizeLead(transcriptRow);
    if (!lead?.lead_id) {
      continue;
    }

    const meta = {
      call_channel: lead.lead_source === 'questmail' ? 'questmail' : 'inbound_zoom',
      shape_lead_id: lead.shape_lead_id ?? null,
      reference_code: lead.reference_code ?? null,
      backfilled_listing: true,
    };
    const channelKey = channelFromMeta(meta, lead, transcriptRow.call_source);
    const landingState = meta.landing_page_state || meta.questmail_state || null;

    if (channel && channel !== channelKey) {
      continue;
    }
    if (stateFilter && landingState !== stateFilter) {
      continue;
    }
    if (outcomeFilter === 'missed') {
      continue;
    }

    calls.push(
      buildCallRecordResolved({
        callId,
        answeredAt: transcriptRow.timestamp,
        meta,
        lead,
        callSource: transcriptRow.call_source,
        transcriptRow,
        missingAnsweredRow: true,
        viewerEmail,
      }),
    );
    listedCallIds.add(callId);
  }

  for (const row of shapeCreatedRows ?? []) {
    const lead = normalizeLead(row);
    const meta = row.fields_populated ?? {};
    const callId = parseCallId(row.external_call_id);

    if (listedCallIds.has(callId)) {
      continue;
    }

    const channelKey = channelFromMeta(meta, lead, row.call_source);
    const landingState = meta.landing_page_state || meta.questmail_state || null;

    if (channel && channel !== channelKey) {
      continue;
    }
    if (stateFilter && landingState !== stateFilter) {
      continue;
    }
    if (outcomeFilter === 'missed') {
      continue;
    }

    calls.push(
      buildCallRecordResolved({
        callId,
        answeredAt: row.timestamp,
        meta,
        lead,
        callSource: row.call_source,
        transcriptRow: transcriptByCallId.get(callId) ?? null,
        viewerEmail,
      }),
    );
    listedCallIds.add(callId);
  }

  calls.sort((a, b) => new Date(b.answered_at).getTime() - new Date(a.answered_at).getTime());

  const filtered = calls.filter((call) => {
    const archived = Boolean(call.is_archived || call.archived_at);
    if (archivedOnly) {
      return archived;
    }
    if (!includeArchived && archived) {
      return false;
    }
    return true;
  });

  return {
    calls: filtered.slice(0, maxRows),
    count: Math.min(filtered.length, maxRows),
  };
}

async function findLeadIdsForSearch(supabase, query, { limit = 40 } = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 2) {
    return [];
  }

  const safe = q.replace(/[%_,]/g, ' ').trim();
  const pattern = `%${safe}%`;
  const digits = normalizePhoneDigits(q);
  const exactCode = /^[A-Z0-9]+$/i.test(safe) ? safe.toUpperCase() : null;
  const leadIds = new Set();

  if (exactCode) {
    const { data: exactRows, error: exactError } = await supabase
      .from('leads')
      .select('lead_id')
      .eq('reference_code', exactCode)
      .limit(10);

    if (exactError) {
      throw exactError;
    }

    for (const row of exactRows ?? []) {
      leadIds.add(row.lead_id);
    }
  }

  if (digits.length >= 7) {
    const phonePattern = `%${digits.slice(-10)}%`;
    const { data: phoneRows, error: phoneError } = await supabase
      .from('leads')
      .select('lead_id')
      .ilike('phone_number', phonePattern)
      .limit(20);

    if (phoneError) {
      throw phoneError;
    }

    for (const row of phoneRows ?? []) {
      leadIds.add(row.lead_id);
    }
  }

  const { data: nameRows, error: nameError } = await supabase
    .from('leads')
    .select('lead_id')
    .or(
      `full_name.ilike.${pattern},reference_code.ilike.${pattern},phone_number.ilike.${pattern}`,
    )
    .limit(Math.min(limit, 40));

  if (nameError) {
    throw nameError;
  }

  for (const row of nameRows ?? []) {
    leadIds.add(row.lead_id);
  }

  const mailerRows = await searchMailerLeads(supabase, q, { limit: 15 });
  const referenceCodes = new Set();
  const shapeLeadIds = new Set();

  for (const row of mailerRows) {
    if (row.reference_code) {
      referenceCodes.add(String(row.reference_code).trim().toUpperCase());
    }
    if (row.shape_lead_id) {
      shapeLeadIds.add(row.shape_lead_id);
    }
  }

  if (referenceCodes.size) {
    const { data: refRows, error: refError } = await supabase
      .from('leads')
      .select('lead_id')
      .in('reference_code', [...referenceCodes])
      .limit(20);

    if (refError) {
      throw refError;
    }

    for (const row of refRows ?? []) {
      leadIds.add(row.lead_id);
    }
  }

  if (shapeLeadIds.size) {
    const { data: shapeRows, error: shapeError } = await supabase
      .from('leads')
      .select('lead_id')
      .in('shape_lead_id', [...shapeLeadIds])
      .limit(20);

    if (shapeError) {
      throw shapeError;
    }

    for (const row of shapeRows ?? []) {
      leadIds.add(row.lead_id);
    }
  }

  return [...leadIds].slice(0, limit);
}

/**
 * Search inbound calls by borrower phone, name, or mailer reference code.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function searchInboundCalls(
  supabase,
  {
    q,
    limit = 80,
    channel,
    state,
    includeArchived = false,
    archivedOnly = false,
    outcome = null,
    viewerEmail = null,
  } = {},
) {
  const query = String(q ?? '').trim();
  const maxRows = Math.min(limit, 500);
  const leadIds = await findLeadIdsForSearch(supabase, query);

  if (!leadIds.length) {
    return {
      calls: [],
      count: 0,
      search_query: query,
      view_label: 'Search',
      generated_at: new Date().toISOString(),
      landing_states: ['FL', 'GA', 'NC', 'SC', 'TN', 'TX'],
    };
  }

  const { data: allRows, error } = await supabase
    .from('transcripts')
    .select(CALL_SEARCH_SELECT)
    .in('lead_id', leadIds)
    .order('timestamp', { ascending: false })
    .limit(500);

  if (error) {
    throw error;
  }

  const answeredRows = (allRows ?? []).filter((row) => String(row.external_call_id ?? '').endsWith(':answered'));
  const transcriptRows = (allRows ?? []).filter((row) =>
    String(row.external_call_id ?? '').endsWith(':transcript'),
  );
  const missedRows = (allRows ?? []).filter((row) => String(row.external_call_id ?? '').endsWith(':missed'));
  const shapeCreatedRows = (allRows ?? []).filter((row) =>
    /^shape:.+:created$/.test(String(row.external_call_id ?? '')),
  );

  const { calls, count } = assembleInboundCalls({
    answeredRows,
    missedRows,
    transcriptRows,
    shapeCreatedRows,
    channel,
    state,
    outcome,
    includeArchived,
    archivedOnly,
    viewerEmail,
    maxRows,
  });

  return {
    calls,
    count,
    search_query: query,
    view_label: 'Search',
    generated_at: new Date().toISOString(),
    landing_states: ['FL', 'GA', 'NC', 'SC', 'TN', 'TX'],
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listInboundCalls(
  supabase,
  {
    limit = 80,
    channel,
    state,
    hours = 24,
    since: sinceIso,
    until: untilIso,
    includeArchived = false,
    archivedOnly = false,
    outcome = null,
    viewerEmail = null,
  } = {},
) {
  const since =
    sinceIso != null
      ? new Date(sinceIso).toISOString()
      : new Date(Date.now() - Number(hours) * 60 * 60 * 1000).toISOString();
  const until = untilIso != null ? new Date(untilIso).toISOString() : null;
  const maxRows = Math.min(limit, 500);

  let answeredQuery = supabase
    .from('transcripts')
    .select(ANSWERED_SELECT)
    .like('external_call_id', '%:answered')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(maxRows);

  if (until) {
    answeredQuery = answeredQuery.lte('timestamp', until);
  }

  const { data: answeredRows, error } = await answeredQuery;

  if (error) {
    throw error;
  }

  let transcriptQuery = supabase
    .from('transcripts')
    .select(TRANSCRIPT_SELECT)
    .like('external_call_id', '%:transcript')
    .gte('timestamp', since);

  if (until) {
    transcriptQuery = transcriptQuery.lte('timestamp', until);
  }

  const { data: transcriptRows, error: transcriptError } = await transcriptQuery;

  if (transcriptError) {
    throw transcriptError;
  }

  let missedQuery = supabase
    .from('transcripts')
    .select(ANSWERED_SELECT)
    .like('external_call_id', '%:missed')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(maxRows);

  if (until) {
    missedQuery = missedQuery.lte('timestamp', until);
  }

  const { data: missedRows, error: missedError } = await missedQuery;

  if (missedError) {
    throw missedError;
  }

  let shapeQuery = supabase
    .from('transcripts')
    .select(ANSWERED_SELECT)
    .like('external_call_id', 'shape:%:created')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(maxRows);

  if (until) {
    shapeQuery = shapeQuery.lte('timestamp', until);
  }

  const { data: shapeCreatedRows, error: shapeError } = await shapeQuery;

  if (shapeError) {
    throw shapeError;
  }

  const { calls, count } = assembleInboundCalls({
    answeredRows,
    missedRows,
    transcriptRows,
    shapeCreatedRows,
    channel,
    state,
    outcome,
    includeArchived,
    archivedOnly,
    viewerEmail,
    maxRows,
  });

  return {
    calls,
    count,
    since,
    until,
    hours: sinceIso == null ? Number(hours) : null,
    view_label: resolveViewLabel(hours),
    generated_at: new Date().toISOString(),
    landing_states: ['FL', 'GA', 'NC', 'SC', 'TN', 'TX'],
  };
}
