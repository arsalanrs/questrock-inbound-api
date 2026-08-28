import { formatRayCoachingText } from './ai/ray-coaching-format.js';

export const REVIEW_META_KEYS = new Set([
  'call_summary',
  'sales_notes',
  'ray_coaching',
  'ops_notes',
  'status_rationale',
  'questrock_analysis',
  'call_intelligence',
  'auto_flags',
  'deal_review',
  'private_identity',
  'deal_review_sync',
  'private_identity_sync',
  'deal_review_error',
  'shape_sync',
  'mailer_reference_code',
  'questmail_identified_by',
  'notes_sidebar',
  'notes_sidebar_ai_note',
  'lo_disposition_shape_sync',
]);

/**
 * Compact Shape sync result for Supabase + Call Tracker display.
 */
export function summarizeShapeSync(shapeSync) {
  if (!shapeSync || typeof shapeSync !== 'object') {
    return { state: 'unknown', message: 'No Shape sync data' };
  }

  if (shapeSync.skipped) {
    return {
      state: 'skipped',
      synced: false,
      message: shapeSync.reason || 'Shape sync skipped',
    };
  }

  if (shapeSync.synced) {
    const fieldsSent = shapeSync.fields_sent ?? [];
    const statusSent = shapeSync.status_sent ?? null;
    const queued = Boolean(shapeSync.shape_async_or_queued_hint);
    const queuedNote =
      shapeSync.shape_response?.message?.includes('queued') ? ' (Shape queued)' : '';
    return {
      state: 'synced',
      synced: true,
      status_sent: statusSent,
      fields_sent: fieldsSent,
      fields_count: fieldsSent.length,
      queued,
      message: statusSent
        ? `Status set to "${statusSent}" · ${fieldsSent.length} field(s) updated${queuedNote}`
        : `${fieldsSent.length} field(s) updated${queuedNote}`,
    };
  }

  return {
    state: 'failed',
    synced: false,
    message: shapeSync.error || 'Shape sync failed',
    http_status: shapeSync.http_status ?? null,
    update_url: shapeSync.update_url ?? null,
  };
}

export function buildTranscriptReviewFields(evaluation, shapeSync, extra = {}) {
  return {
    ...evaluation.fieldsPopulated,
    call_summary: evaluation.callSummary,
    sales_notes: evaluation.salesNotes,
    ray_coaching: evaluation.rayCoaching ?? null,
    ops_notes: evaluation.opsNotes,
    status_rationale: evaluation.statusRationale,
    questrock_analysis: evaluation.questrockAnalysis ?? null,
    call_intelligence: evaluation.callIntelligence ?? null,
    auto_flags: evaluation.autoFlags ?? [],
    shape_sync: summarizeShapeSync(shapeSync),
    ...extra,
  };
}

export function buildTranscriptReviewFieldsWithDealIntelligence(
  evaluation,
  shapeSync,
  dealIntelligence,
  extra = {},
) {
  return buildTranscriptReviewFields(evaluation, shapeSync, {
    deal_review: dealIntelligence?.deal_review ?? null,
    private_identity: dealIntelligence?.private_identity ?? null,
    deal_review_sync: dealIntelligence?.deal_review_sync ?? null,
    private_identity_sync: dealIntelligence?.private_identity_sync ?? null,
    deal_review_error: dealIntelligence?.deal_review_error ?? null,
    ...extra,
  });
}

export function listExtractedShapeFields(fieldsPopulated) {
  if (!fieldsPopulated || typeof fieldsPopulated !== 'object') {
    return [];
  }

  return Object.entries(fieldsPopulated)
    .filter(([key, value]) => !REVIEW_META_KEYS.has(key) && String(value ?? '').trim() !== '')
    .map(([field, value]) => ({ field, value: String(value) }))
    .sort((a, b) => a.field.localeCompare(b.field));
}

export function aiReviewFromTranscriptFields(fieldsPopulated) {
  const fields = fieldsPopulated ?? {};
  const shapeSyncRaw = fields.shape_sync;

  return {
    call_summary: fields.call_summary || null,
    sales_notes: fields.sales_notes || formatRayCoachingText(fields.ray_coaching) || null,
    ray_coaching: fields.ray_coaching || null,
    ops_notes: fields.ops_notes || null,
    status_rationale: fields.status_rationale || null,
    questrock_analysis: fields.questrock_analysis || null,
    call_intelligence: fields.call_intelligence || null,
    auto_flags: Array.isArray(fields.auto_flags) ? fields.auto_flags : [],
    deal_review: fields.deal_review || null,
    private_identity: fields.private_identity || null,
    deal_review_sync: fields.deal_review_sync && typeof fields.deal_review_sync === 'object'
      ? fields.deal_review_sync
      : null,
    private_identity_sync: fields.private_identity_sync && typeof fields.private_identity_sync === 'object'
      ? fields.private_identity_sync
      : null,
    extracted_fields: listExtractedShapeFields(fields),
    shape_sync: shapeSyncRaw && typeof shapeSyncRaw === 'object' ? shapeSyncRaw : null,
  };
}
