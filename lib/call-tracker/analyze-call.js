import { findTranscriptByExternalCallId, ensureCallAnsweredRow } from '../transcripts.js';
import { resolveLeadContextForCall } from '../lead-resolve.js';
import { reEvaluateTranscriptById } from '../evaluate-transcript.js';
import { notifyAdminOutcome, runBackgroundTranscriptJob } from '../process-transcript-pipeline.js';
import { isShapeTrackerCallId, shapeLeadIdFromCallId, callAnchorSuffix } from './call-id.js';

function isQuestMailCall(context, answeredMeta) {
  return Boolean(
    context?.questmailPending ||
      context?.callChannel === 'questmail' ||
      context?.lead?.lead_source === 'questmail' ||
      answeredMeta?.call_channel === 'questmail' ||
      answeredMeta?.questmail_hold ||
      answeredMeta?.questmail_toll,
  );
}

/**
 * Run AI summary, status, coaching notes, and Shape sync for a call that already has transcript text.
 */
export async function analyzeCallTranscript(supabase, callId) {
  const normalizedCallId = String(callId ?? '').trim();
  if (!normalizedCallId) {
    const error = new Error('call_id is required');
    error.statusCode = 400;
    throw error;
  }

  const shapeCall = isShapeTrackerCallId(normalizedCallId);
  const transcriptRow = await findTranscriptByExternalCallId(supabase, `${normalizedCallId}:transcript`);
  const transcriptText = transcriptRow?.transcript_text?.trim();

  if (!transcriptText) {
    const error = new Error(
      shapeCall
        ? 'No transcript text saved yet. Paste the call transcript first.'
        : 'No transcript text saved for this call yet. Use Re-fetch from Zoom first.',
    );
    error.statusCode = 404;
    throw error;
  }

  const anchor = await findTranscriptByExternalCallId(
    supabase,
    `${normalizedCallId}${callAnchorSuffix(normalizedCallId)}`,
  );
  let anchorMeta = anchor?.fields_populated ?? {};

  const context = await resolveLeadContextForCall(supabase, {
    callId: normalizedCallId,
    callerPhone: null,
  });

  if (!context?.lead) {
    const error = new Error(
      shapeCall
        ? `No lead linked to ${normalizedCallId}.`
        : `No lead linked to call ${normalizedCallId}. Call-answered row may be missing.`,
    );
    error.statusCode = 404;
    throw error;
  }

  const loName = anchorMeta.lo_name ?? null;

  if (!anchor?.lead_id && !shapeCall) {
    const ensured = await ensureCallAnsweredRow(supabase, {
      callId: normalizedCallId,
      lead: context.lead,
      timestamp: transcriptRow.timestamp ?? new Date().toISOString(),
      callSource: context.lead.lead_source === 'questmail' ? 'QuestMail' : 'Zoom Phone',
      callMeta: {
        call_channel: context.questmailPending || context.lead.lead_source === 'questmail' ? 'questmail' : 'inbound_zoom',
        backfilled_from: 'call_tracker_analyze',
        shape_lead_id: context.shapeLeadId ?? context.lead.shape_lead_id ?? null,
        reference_code: context.lead.reference_code ?? null,
      },
    });
    anchorMeta = ensured.transcript?.fields_populated ?? anchorMeta;
  }

  const shapeLeadId =
    shapeLeadIdFromCallId(normalizedCallId) || context.shapeLeadId || context.lead.shape_lead_id || null;
  const questMail = isQuestMailCall(context, anchorMeta);

  if (questMail) {
    const result = await runBackgroundTranscriptJob({
      lead: context.lead,
      questmailPending: context.questmailPending ?? !shapeLeadId,
      questmailHold: anchorMeta.questmail_hold,
      callChannel: anchorMeta.call_channel,
      answeredMeta: anchorMeta,
      shapeLeadId,
      callId: normalizedCallId,
      transcriptText,
      timestamp: transcriptRow.timestamp,
      loName,
      formattedPhone: context.lead.phone_number,
      fullName: context.lead.full_name,
      referenceCodeHint:
        context.lead.reference_code ||
        anchorMeta.reference_code ||
        null,
      mailerLeadIdHint: anchorMeta.mailer_lead_id ?? null,
    });

    return {
      ok: true,
      analyzed: true,
      pipeline: result.pipeline ?? 'questmail_transcript',
      call_id: normalizedCallId,
      shape_lead_id: result.shape_lead_id ?? shapeLeadId,
      ai_status_label: result.ai_status_label,
      status_rationale: result.status_rationale,
      call_summary: result.call_summary,
      questrock_analysis: result.questrock_analysis ?? null,
      call_intelligence: result.call_intelligence ?? null,
      auto_flags: result.auto_flags ?? [],
      sales_notes: result.notification?.sales_notes ?? null,
      ops_notes: result.notification?.ops_notes ?? null,
      shape_sync: result.shape_sync,
      transcript_id: result.transcript_id,
      notify_sent: result.notify?.sent ?? false,
      message: 'QuestRock AI analysis, coaching, and Shape sync completed.',
    };
  }

  if (!shapeLeadId) {
    const error = new Error(
      'This call has no Shape lead linked yet. Run call-answered first or link the lead in Supabase.',
    );
    error.statusCode = 422;
    throw error;
  }

  const result = await reEvaluateTranscriptById(supabase, transcriptRow.transcript_id, { loName });
  const notify = await notifyAdminOutcome(result);

  return {
    ok: true,
    analyzed: true,
    pipeline: 're_evaluate',
    call_id: normalizedCallId,
    shape_lead_id: result.shape_lead_id,
    ai_status_label: result.ai_status_label,
    status_rationale: result.status_rationale,
    call_summary: result.call_summary,
    questrock_analysis: result.questrock_analysis ?? null,
    call_intelligence: result.call_intelligence ?? null,
    auto_flags: result.auto_flags ?? [],
    sales_notes: result.notification?.sales_notes ?? null,
    ops_notes: result.notification?.ops_notes ?? null,
    shape_sync: result.shape_sync,
    transcript_id: result.transcript_id,
    notify_sent: notify.sent ?? false,
    message: 'QuestRock AI analysis, coaching, and Shape sync completed.',
  };
}
