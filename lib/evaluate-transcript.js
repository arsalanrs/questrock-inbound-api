import { evaluateCallWithAi } from './ai/evaluate-call.js';
import { buildAdminOutcomeEmail } from './admin-email.js';
import { updateLeadFromAi, findLeadByShapeId } from './leads.js';
import { getTranscriptHistory } from './transcripts.js';
import { loadStatusDefinitions } from './status-definitions.js';
import { fetchShapeLead, syncShapeLeadFromEvaluation } from './shape/client.js';
import { getSupabaseClient } from './supabase.js';
import { buildTranscriptReviewFieldsWithDealIntelligence } from './transcript-ai-review.js';
import { runDealIntelligencePipeline } from './deal-review/run-deal-intelligence.js';

/**
 * Runs OpenAI evaluation for an existing transcript row (no insert).
 */
export async function evaluateExistingTranscript(supabase, { lead, transcript, shapeLeadId }) {
  const transcriptText = String(transcript.transcript_text ?? '').trim();

  if (!transcriptText) {
    const error = new Error('Transcript row has no transcript_text to evaluate.');
    error.statusCode = 422;
    throw error;
  }

  const [history, statusDefinitions, shapeSnapshot] = await Promise.all([
    getTranscriptHistory(supabase, lead.lead_id),
    loadStatusDefinitions(supabase),
    fetchShapeLead(shapeLeadId),
  ]);

  const evaluation = await evaluateCallWithAi({
    lead,
    shapeLead: shapeSnapshot.lead,
    transcriptHistory: history,
    latestTranscriptText: transcriptText,
    statusDefinitions,
  });

  return { evaluation, shapeSnapshot };
}

/**
 * Persists AI outcome on a transcript row; updates lead + Shape when this is the lead's latest transcript.
 */
export async function persistEvaluationResult(
  supabase,
  {
    lead,
    transcript,
    evaluation,
    shapeLeadId,
    loName = null,
    updateLead = true,
  },
) {
  let updatedLead = lead;
  let shapeSync = { synced: false, skipped: true };

  if (updateLead) {
    updatedLead = await updateLeadFromAi(supabase, lead.lead_id, evaluation);
    shapeSync = await syncShapeLeadFromEvaluation(shapeLeadId, evaluation);
  }

  const dealIntelligence = await runDealIntelligencePipeline({
    shapeLeadId,
    transcriptText: transcript.transcript_text,
    lead: updatedLead,
    shapeLead: {},
    evaluation,
  });

  await supabase
    .from('transcripts')
    .update({
      ai_status_label: evaluation.status.status_label,
      ai_status_color: evaluation.status.color,
      fields_populated: buildTranscriptReviewFieldsWithDealIntelligence(
        evaluation,
        shapeSync,
        dealIntelligence,
      ),
    })
    .eq('transcript_id', transcript.transcript_id);

  const notification = buildAdminOutcomeEmail({
    lead: updatedLead,
    evaluation,
    transcript,
    loName,
    shapeSync,
  });

  return {
    lead_id: updatedLead.lead_id,
    transcript_id: transcript.transcript_id,
    shape_lead_id: shapeLeadId,
    ai_status_label: evaluation.status.status_label,
    ai_status_color: evaluation.status.color,
    status_rationale: evaluation.statusRationale,
    call_summary: evaluation.callSummary,
    questrock_analysis: evaluation.questrockAnalysis ?? null,
    call_intelligence: evaluation.callIntelligence ?? null,
    auto_flags: evaluation.autoFlags ?? [],
    fields_populated: evaluation.fieldsPopulated,
    shape_sync: shapeSync,
    deal_intelligence: dealIntelligence,
    lead_updated: updateLead,
    notification,
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function getLatestTextTranscriptForLead(supabase, leadId) {
  const { data, error } = await supabase
    .from('transcripts')
    .select('*')
    .eq('lead_id', leadId)
    .not('transcript_text', 'is', null)
    .neq('transcript_text', '')
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Re-runs AI on one transcript. Updates lead + Shape only if it is the newest text transcript.
 */
export async function reEvaluateTranscriptById(supabase, transcriptId, { loName = null } = {}) {
  const { data: transcript, error } = await supabase
    .from('transcripts')
    .select('*')
    .eq('transcript_id', transcriptId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!transcript) {
    const error = new Error(`Transcript not found: ${transcriptId}`);
    error.statusCode = 404;
    throw error;
  }

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('*')
    .eq('lead_id', transcript.lead_id)
    .maybeSingle();

  if (leadError) {
    throw leadError;
  }

  if (!lead?.shape_lead_id) {
    const error = new Error('Lead has no shape_lead_id — cannot sync Shape.');
    error.statusCode = 422;
    throw error;
  }

  const latest = await getLatestTextTranscriptForLead(supabase, lead.lead_id);
  const isLatest = latest?.transcript_id === transcript.transcript_id;

  const { evaluation } = await evaluateExistingTranscript(supabase, {
    lead,
    transcript,
    shapeLeadId: lead.shape_lead_id,
  });

  return persistEvaluationResult(supabase, {
    lead,
    transcript,
    evaluation,
    shapeLeadId: lead.shape_lead_id,
    loName,
    updateLead: isLatest,
  });
}

/**
 * Re-runs AI on the lead's newest transcript with full history; always updates lead + Shape.
 */
export async function reEvaluateLatestForLead(
  supabase,
  { leadId = null, shapeLeadId = null, loName = null } = {},
) {
  let lead = null;

  if (shapeLeadId != null) {
    lead = await findLeadByShapeId(supabase, shapeLeadId);
  } else if (leadId) {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('lead_id', leadId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    lead = data;
  } else {
    const error = new Error('Provide leadId or shapeLeadId.');
    error.statusCode = 400;
    throw error;
  }

  if (!lead) {
    const error = new Error(
      shapeLeadId ? `No lead for shape_lead_id ${shapeLeadId}` : `No lead for lead_id ${leadId}`,
    );
    error.statusCode = 404;
    throw error;
  }

  if (!lead.shape_lead_id) {
    const error = new Error('Lead has no shape_lead_id.');
    error.statusCode = 422;
    throw error;
  }

  const transcript = await getLatestTextTranscriptForLead(supabase, lead.lead_id);

  if (!transcript) {
    const error = new Error('No transcript with text found for this lead.');
    error.statusCode = 404;
    throw error;
  }

  const { evaluation } = await evaluateExistingTranscript(supabase, {
    lead,
    transcript,
    shapeLeadId: lead.shape_lead_id,
  });

  return persistEvaluationResult(supabase, {
    lead,
    transcript,
    evaluation,
    shapeLeadId: lead.shape_lead_id,
    loName,
    updateLead: true,
  });
}

export { getSupabaseClient };
