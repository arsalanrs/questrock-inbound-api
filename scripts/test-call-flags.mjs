import { computeCallFlags } from '../lib/ai/compute-call-flags.js';

const hotLead = computeCallFlags({
  callIntelligence: {
    lead_temperature: 'hot',
    timeline: 'within 30 days',
    appointment_set: 'no',
    follow_up_promised: 'yes',
    competitor_mentioned: 'yes',
    competitor_names: 'Rocket Mortgage',
    next_action: '',
    loan_type: 'DSCR',
    lo_coaching_opportunities: 'LO pushed conventional without explaining DSCR',
  },
  aiFlags: [],
});

const codes = hotLead.map((f) => f.flag_code).sort();
const expected = [
  'competitor_mentioned',
  'follow_up_unscheduled',
  'hot_no_appointment',
  'management_product_mismatch',
  'no_next_action',
  'urgent_no_appointment',
];

for (const code of expected) {
  if (!codes.includes(code)) {
    console.error(`Missing expected flag: ${code}`);
    process.exit(1);
  }
}

console.log('computeCallFlags OK:', codes.join(', '));
