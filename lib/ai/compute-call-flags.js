import { normalizeAutoFlags } from './call-intelligence-schema.js';

const YES = /^(yes|true|y)$/i;
const HOT = /^(hot|high.?priority)$/i;
const WARM = /^(warm|medium)$/i;

function isYes(value) {
  return YES.test(String(value ?? '').trim());
}

function mergeFlags(existing, incoming) {
  const byCode = new Map();
  for (const flag of [...existing, ...incoming]) {
    if (!flag?.flag_code) continue;
    const current = byCode.get(flag.flag_code);
    if (!current || severityRank(flag.severity) > severityRank(current.severity)) {
      byCode.set(flag.flag_code, flag);
    }
  }
  return [...byCode.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(severity) {
  const value = String(severity ?? '').toLowerCase();
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  return 1;
}

function makeFlag(flagCode, severity, category, title, detail) {
  return { flag_code: flagCode, severity, category, title, detail };
}

/**
 * Deterministic flags layered on top of AI-generated auto_flags.
 */
export function computeCallFlags({ callIntelligence = {}, aiFlags = [], evaluation = null } = {}) {
  const intel = callIntelligence ?? {};
  const computed = [];

  const temperature = String(intel.lead_temperature ?? '').trim();
  const appointmentSet = String(intel.appointment_set ?? '').trim().toLowerCase();
  const followUpPromised = String(intel.follow_up_promised ?? '').trim().toLowerCase();
  const competitorMentioned = String(intel.competitor_mentioned ?? '').trim().toLowerCase();
  const competitorNames = String(intel.competitor_names ?? '').trim();
  const nextAction = String(intel.next_action ?? '').trim();
  const complianceConcerns = String(intel.compliance_concerns ?? '').trim();
  const rateDiscussed = String(intel.rate_payment_discussed ?? '').trim().toLowerCase();
  const rateSummary = String(intel.rate_payment_summary ?? intel.rate_payment_discussed ?? '').trim();
  const loanType = String(intel.loan_type ?? '').trim();
  const coaching = String(intel.lo_coaching_opportunities ?? '').trim();
  const timeline = String(intel.timeline ?? '').trim();
  const quickBrief = String(intel.quick_brief ?? '').trim();

  if (HOT.test(temperature) && appointmentSet !== 'yes') {
    computed.push(
      makeFlag(
        'hot_no_appointment',
        'high',
        'conversion',
        'Hot inbound lead — no appointment',
        [
          quickBrief || 'Borrower shows strong purchase/refi intent.',
          timeline ? `Timeline: ${timeline}.` : '',
          'No calendar appointment was set on this call.',
        ]
          .filter(Boolean)
          .join(' '),
      ),
    );
  }

  if (isYes(competitorMentioned) || competitorNames) {
    computed.push(
      makeFlag(
        'competitor_mentioned',
        'medium',
        'management',
        'Competitor mentioned',
        competitorNames
          ? `Borrower referenced: ${competitorNames}.`
          : 'Borrower mentioned another lender or offer on this call.',
      ),
    );
  }

  if (isYes(followUpPromised) && appointmentSet !== 'yes') {
    computed.push(
      makeFlag(
        'follow_up_unscheduled',
        'medium',
        'conversion',
        'Follow-up promised — nothing scheduled',
        String(intel.follow_up_details ?? '').trim() ||
          'LO promised to follow up but no specific appointment or callback time was locked.',
      ),
    );
  }

  if (!nextAction && appointmentSet !== 'yes' && (HOT.test(temperature) || WARM.test(temperature))) {
    computed.push(
      makeFlag(
        'no_next_action',
        'medium',
        'conversion',
        'Lead without clear next action',
        'Engaged borrower but no documented next action or scheduled follow-up.',
      ),
    );
  }

  if (complianceConcerns) {
    computed.push(
      makeFlag(
        'compliance_review',
        'high',
        'compliance',
        'Compliance review recommended',
        complianceConcerns,
      ),
    );
  } else if (isYes(rateDiscussed) && /rate|apr|point|fee|payment/i.test(rateSummary)) {
    const coachingFlags = String(evaluation?.rayCoaching?.non_negotiable_flags ?? '').trim();
    if (/missing|without|no (?:mention|context)|points|fees|compliance/i.test(coachingFlags)) {
      computed.push(
        makeFlag(
          'compliance_rate_review',
          'medium',
          'compliance',
          'Rate or payment discussed — review recommended',
          'LO discussed rate or payment; verify points, fees, and required disclosures were covered.',
        ),
      );
    }
  }

  if (/dscr|bank statement|non.?qm|investor/i.test(loanType) && /conventional|fha|va only|steer/i.test(coaching)) {
    computed.push(
      makeFlag(
        'management_product_mismatch',
        'medium',
        'management',
        'Product fit discussion needs review',
        coaching || `Borrower interest in ${loanType} may not have been fully addressed.`,
      ),
    );
  }

  if (/within\s*30\s*days|asap|urgent|closing soon|under contract/i.test(timeline) && appointmentSet !== 'yes') {
    computed.push(
      makeFlag(
        'urgent_no_appointment',
        'high',
        'conversion',
        'Urgent timeline — no appointment',
        `Timeline: ${timeline}. Consider immediate follow-up or calendar lock.`,
      ),
    );
  }

  return mergeFlags(normalizeAutoFlags(aiFlags), computed);
}
