const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1500, 3500, 7000];

export const LEAD_TYPES = [
  'active_buyer',
  'problem_need',
  'researching',
  'life_event',
  'competitor_dissatisfaction',
  'business_prospect',
  'unknown',
];

export const ACTIVE_NEED_VALUES = ['yes', 'no', 'unknown'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a campaign-aware search prompt. The model is explicitly told that
 * finding an old mention of a need is not enough to qualify a lead.
 */
export function buildIntentSearchPrompt({
  offer,
  idealCustomer,
  location,
  radius = '',
  leadTypes = [],
  freshnessDays = 7,
  minLeadScore = 70,
  maxResults = 15,
}) {
  const types = leadTypes.length ? leadTypes.join(', ') : LEAD_TYPES.join(', ');

  return [
    `You are an evidence-first local sales prospecting researcher.`,
    `Find up to ${maxResults} REAL prospects for this campaign:`,
    `Offer: ${offer}`,
    `Ideal customer: ${idealCustomer}`,
    `Target location: ${location}`,
    radius ? `Target radius: ${radius}` : '',
    `Allowed lead types: ${types}`,
    `Maximum acceptable evidence age: ${freshnessDays} days`,
    `Minimum desired lead score: ${minLeadScore}/100`,
    '',
    `CORE RULE: We want people or organizations that are likely to need the offer NOW, not people who merely needed it in the past.`,
    `Search the web for recent, public evidence of buying intent, a current problem/need, active research, a relevant life event, or dissatisfaction with an existing provider.`,
    `Prefer evidence from the last ${freshnessDays} days. If older evidence exists, only keep it when newer evidence clearly indicates the need is still active.`,
    `Reject evidence that indicates the need was already solved, such as "found someone", "got it fixed", "already bought", "problem solved", or an equivalent outcome.`,
    `Do not infer that a person currently needs something without evidence. If current intent cannot be supported, mark active_need as unknown or reject the lead.`,
    `Do not invent names, contact details, dates, quotes, sources, or URLs.`,
    `Use only publicly accessible information returned by web search/context. Do not bypass logins, private groups, paywalls, CAPTCHAs, or access controls.`,
    '',
    `For every candidate, return the factual evidence supporting the lead, the source URL, the date of that evidence when known, and a concise explanation of why the need appears current.`,
    `Score each candidate from 0-100 for intent, freshness, active need, location match, and overall lead priority.`,
    `A high intent score does NOT compensate for stale evidence. A lead with old evidence and no sign of continued need should be rejected or marked stale.`,
  ].filter(Boolean).join('\n');
}

export const intentLeadSchema = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          website: { type: 'string' },
          address: { type: 'string' },
          city: { type: 'string' },
          lead_type: { type: 'string' },
          need: { type: 'string' },
          intent_score: { type: 'number' },
          freshness_score: { type: 'number' },
          active_need_score: { type: 'number' },
          location_match_score: { type: 'number' },
          lead_score: { type: 'number' },
          urgency: { type: 'string' },
          source: { type: 'string' },
          source_url: { type: 'string' },
          evidence: { type: 'string' },
          evidence_date: { type: 'string' },
          evidence_age_days: { type: 'number' },
          active_need: { type: 'string' },
          ai_reasoning: { type: 'string' },
          recommended_action: { type: 'string' },
          verification_status: { type: 'string' },
        },
        required: ['name', 'lead_type', 'need', 'intent_score', 'freshness_score', 'active_need_score', 'lead_score', 'evidence', 'active_need', 'verification_status'],
      },
    },
  },
  required: ['leads'],
};

/** Retry transient integration failures instead of turning one network error
 * into a failed campaign. The caller supplies the Base44 InvokeLLM function.
 */
export async function invokeIntentSearch(invokeLLM, args) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await invokeLLM(args);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function clamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Defense-in-depth scoring. The model supplies component scores, but the
 * application calculates the final score so stale leads cannot be rescued by
 * an inflated intent score.
 */
export function calculateLeadScore(lead) {
  const intent = clamp(lead.intent_score);
  const freshness = clamp(lead.freshness_score);
  const active = clamp(lead.active_need_score);
  const location = clamp(lead.location_match_score);

  // Freshness and active need carry more weight than generic intent.
  const score = Math.round(
    intent * 0.30 +
    freshness * 0.25 +
    active * 0.30 +
    location * 0.15,
  );

  if (String(lead.active_need).toLowerCase() === 'no') return 0;
  if (String(lead.verification_status).toLowerCase() === 'rejected') return 0;
  if (freshness < 20 && active < 80) return Math.min(score, 35);
  return score;
}

export function normalizeIntentLead(raw, campaign) {
  const lead = { ...raw };
  const now = new Date();
  const evidenceDate = lead.evidence_date ? new Date(lead.evidence_date) : null;
  const ageDays = Number.isFinite(Number(lead.evidence_age_days))
    ? Number(lead.evidence_age_days)
    : evidenceDate && !Number.isNaN(evidenceDate.getTime())
      ? Math.max(0, (now.getTime() - evidenceDate.getTime()) / 86400000)
      : null;

  if (ageDays != null && ageDays > campaign.freshnessDays && String(lead.active_need).toLowerCase() !== 'yes') {
    lead.verification_status = 'needs_review';
  }

  lead.intent_score = clamp(lead.intent_score);
  lead.freshness_score = clamp(lead.freshness_score);
  lead.active_need_score = clamp(lead.active_need_score);
  lead.location_match_score = clamp(lead.location_match_score);
  lead.lead_score = calculateLeadScore(lead);
  lead.evidence_age_days = ageDays == null ? null : Math.round(ageDays * 10) / 10;
  lead.target_offer = campaign.offer;
  lead.niche = campaign.offer;
  lead.city = lead.city || campaign.location;
  lead.status = lead.verification_status === 'rejected' ? 'stale' : lead.lead_score >= campaign.minLeadScore ? 'qualified' : 'unverified';
  lead.scraped_at = now.toISOString();

  return lead;
}
