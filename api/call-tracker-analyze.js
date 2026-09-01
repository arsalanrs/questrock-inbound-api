import { getSupabaseClient } from '../lib/supabase.js';
import { assertInboundSession } from '../lib/request-auth.js';
import { readJsonBody, sendJson } from '../lib/http.js';
import { analyzeCallTranscript } from '../lib/call-tracker/analyze-call.js';
import { CALL_EVALUATION_SCHEMA_VERSION } from '../lib/ai/evaluate-call.js';

/**
 * POST /api/call-tracker-analyze — run AI summary, coaching, status, and Shape sync.
 * Body: { call_id: "7652451507461830788" }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
  }

  try {
    assertInboundSession(req, { requireCallTracker: true });

    const body = readJsonBody(req);
    const callId = String(body?.call_id ?? body?.callId ?? req.query?.call_id ?? '').trim();

    if (!callId) {
      return sendJson(res, 400, { ok: false, error: 'call_id is required.' });
    }

    console.info('[call-tracker-analyze] schema', CALL_EVALUATION_SCHEMA_VERSION);
    const result = await analyzeCallTranscript(getSupabaseClient(), callId);
    return sendJson(res, 200, result);
  } catch (error) {
    console.error('[call-tracker-analyze] failed:', error);

    const statusCode = error.statusCode ?? 500;
    const message = error.message ?? 'Request failed';

    return sendJson(res, statusCode, {
      ok: false,
      error: statusCode === 500 ? message : message,
      details: error.details ?? (statusCode === 500 ? String(error.stack ?? '').split('\n').slice(0, 3).join(' ') : undefined),
    });
  }
}

export const config = {
  maxDuration: 300,
};
