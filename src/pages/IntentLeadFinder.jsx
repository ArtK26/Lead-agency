import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Search, Loader2, MapPin, Target, Clock3, Flame, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

const MAX_RESULTS = 25;

const leadTypes = [
  ['active_buyer', 'Active buyer'],
  ['problem_need', 'Problem / need'],
  ['researching', 'Researching options'],
  ['life_event', 'Life event'],
  ['competitor_dissatisfaction', 'Unhappy with current provider'],
  ['business_prospect', 'Business prospect'],
];

function scoreLead(item, maxAgeDays, location) {
  const intent = Math.max(0, Math.min(100, Number(item.intent_score) || 0));
  const active = Math.max(0, Math.min(100, Number(item.active_need_score) || 0));
  const age = Number(item.evidence_age_days);
  let freshness = Number(item.freshness_score);
  if (!Number.isFinite(freshness)) {
    freshness = Number.isFinite(age) ? Math.max(0, 100 - (age / Math.max(1, maxAgeDays)) * 100) : 0;
  }
  const locationScore = Number.isFinite(Number(item.location_match_score)) ? Number(item.location_match_score) : 50;
  const overall = Math.round(intent * 0.35 + active * 0.35 + freshness * 0.20 + locationScore * 0.10);
  return { ...item, freshness_score: Math.round(freshness), lead_score: Math.max(0, Math.min(100, overall)), city: location };
}

async function invokeWithRetry(payload, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await base44.integrations.Core.InvokeLLM(payload);
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, 1200 * (i + 1)));
    }
  }
  throw lastError;
}

export default function IntentLeadFinder() {
  const [offer, setOffer] = useState('');
  const [idealCustomer, setIdealCustomer] = useState('');
  const [location, setLocation] = useState('');
  const [maxAgeDays, setMaxAgeDays] = useState(7);
  const [minScore, setMinScore] = useState(70);
  const [maxResults, setMaxResults] = useState(15);
  const [selectedTypes, setSelectedTypes] = useState(['active_buyer', 'problem_need', 'researching']);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [leads, setLeads] = useState([]);

  const toggleType = (type) => setSelectedTypes(current => current.includes(type) ? current.filter(x => x !== type) : [...current, type]);

  const findLeads = async () => {
    if (!offer.trim() || !idealCustomer.trim() || !location.trim()) {
      toast.error('Enter the offer, ideal customer, and location.');
      return;
    }
    if (!selectedTypes.length) {
      toast.error('Select at least one lead type.');
      return;
    }
    setStatus('searching');
    setError('');
    setLeads([]);
    try {
      const want = Math.min(Math.max(Number(maxResults) || 15, 1), MAX_RESULTS);
      const prompt = `You are an evidence-first local intent lead researcher. Find up to ${want} real prospects in ${location.trim()} for this offer: ${offer.trim()}. Ideal customer: ${idealCustomer.trim()}. Allowed lead types: ${selectedTypes.join(', ')}. Maximum acceptable evidence age: ${maxAgeDays} days. Minimum requested overall score: ${minScore}.

IMPORTANT: Find CURRENT buying intent, not people who needed the service in the distant past. Search the public web and use multiple search strategies. Prefer recent evidence. A lead is only qualified when there is concrete evidence that the person or business currently has the need or has very recently shown intent.

Reject evidence that clearly says the problem was solved, a provider was already hired, an item was already purchased, or the person is no longer looking. If the evidence date is unknown, set active_need to unknown and verification_status to needs_review; do not pretend it is recent. Never invent names, dates, locations, contact details, quotes, source URLs, or evidence.

For every candidate return the source URL and a concise factual evidence summary explaining exactly why it is a lead. Return only prospects supported by web evidence. The application will calculate the final lead score, so provide component scores only.`;
      const response = await invokeWithRetry({
        prompt,
        add_context_from_internet: true,
        response_json_schema: {
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
                  lead_type: { type: 'string' },
                  need: { type: 'string' },
                  intent_score: { type: 'number' },
                  freshness_score: { type: 'number' },
                  active_need_score: { type: 'number' },
                  location_match_score: { type: 'number' },
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
                required: ['name', 'need', 'intent_score', 'active_need_score', 'evidence', 'verification_status'],
              },
            },
          },
          required: ['leads'],
        },
      });

      const raw = Array.isArray(response?.leads) ? response.leads : [];
      const scored = raw.map(item => scoreLead(item, Number(maxAgeDays), location.trim()))
        .filter(item => item.verification_status !== 'rejected')
        .filter(item => item.lead_score >= Number(minScore))
        .sort((a, b) => b.lead_score - a.lead_score);

      setLeads(scored);
      setStatus('complete');
      toast.success(`Found ${scored.length} qualified leads.`);
    } catch (e) {
      setError(e?.message || 'The search failed.');
      setStatus('failed');
      toast.error(`Search failed: ${e?.message || 'Unknown error'}`);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-6xl mx-auto px-6 py-10 space-y-8">
        <header>
          <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/30 bg-orange-500/10 px-3 py-1 text-sm text-orange-300 mb-4">
            <Target className="w-4 h-4" /> AI Intent Lead Generator
          </div>
          <h1 className="text-4xl font-bold">Find people who need what you sell <span className="text-orange-400">right now.</span></h1>
          <p className="mt-3 text-slate-400 max-w-3xl">The system looks for recent evidence of buying intent, checks whether the need still appears active, and only keeps evidence-backed leads.</p>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 space-y-6">
          <div className="grid md:grid-cols-2 gap-5">
            <label className="space-y-2"><span className="text-sm font-medium">What are you selling?</span><textarea value={offer} onChange={e => setOffer(e.target.value)} placeholder="Example: residential HVAC repair and replacement" className="w-full min-h-24 rounded-xl bg-slate-950 border border-slate-700 p-3 outline-none focus:border-orange-500" /></label>
            <label className="space-y-2"><span className="text-sm font-medium">Who is your ideal customer?</span><textarea value={idealCustomer} onChange={e => setIdealCustomer(e.target.value)} placeholder="Example: homeowners whose AC is broken or who need a replacement" className="w-full min-h-24 rounded-xl bg-slate-950 border border-slate-700 p-3 outline-none focus:border-orange-500" /></label>
          </div>

          <div className="grid md:grid-cols-4 gap-4">
            <label className="space-y-2 md:col-span-2"><span className="text-sm font-medium flex items-center gap-2"><MapPin className="w-4 h-4" /> Location</span><input value={location} onChange={e => setLocation(e.target.value)} placeholder="Sarasota, FL" className="w-full rounded-xl bg-slate-950 border border-slate-700 p-3 outline-none focus:border-orange-500" /></label>
            <label className="space-y-2"><span className="text-sm font-medium flex items-center gap-2"><Clock3 className="w-4 h-4" /> Max evidence age</span><input type="number" min="1" max="90" value={maxAgeDays} onChange={e => setMaxAgeDays(e.target.value)} className="w-full rounded-xl bg-slate-950 border border-slate-700 p-3 outline-none focus:border-orange-500" /></label>
            <label className="space-y-2"><span className="text-sm font-medium">Minimum score</span><input type="number" min="0" max="100" value={minScore} onChange={e => setMinScore(e.target.value)} className="w-full rounded-xl bg-slate-950 border border-slate-700 p-3 outline-none focus:border-orange-500" /></label>
          </div>

          <div>
            <div className="text-sm font-medium mb-3">Lead types</div>
            <div className="flex flex-wrap gap-2">
              {leadTypes.map(([value, label]) => <button key={value} type="button" onClick={() => toggleType(value)} className={`rounded-full px-3 py-2 text-sm border ${selectedTypes.includes(value) ? 'border-orange-500 bg-orange-500/15 text-orange-300' : 'border-slate-700 text-slate-400'}`}>{selectedTypes.includes(value) ? '✓ ' : ''}{label}</button>)}
            </div>
          </div>

          <button onClick={findLeads} disabled={status === 'searching'} className="w-full md:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-50 px-6 py-3 font-semibold">
            {status === 'searching' ? <><Loader2 className="w-4 h-4 animate-spin" /> Searching and verifying...</> : <><Search className="w-4 h-4" /> Find Current Leads</>}
          </button>
          {status === 'searching' && <p className="text-sm text-slate-400">Searching the web, checking evidence freshness, and filtering stale or solved needs. Temporary failures are retried automatically.</p>}
          {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"><AlertTriangle className="inline w-4 h-4 mr-2" />{error}</div>}
        </section>

        {status === 'complete' && <section className="space-y-4"><div className="flex items-center justify-between"><h2 className="text-2xl font-bold">Qualified leads</h2><span className="text-sm text-slate-400">{leads.length} passed the minimum score</span></div>
          {leads.length === 0 ? <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">No leads met the current freshness, active-need, evidence, and score requirements. Try a wider evidence window or lower the minimum score.</div> : leads.map((lead, index) => <article key={`${lead.source_url || lead.name}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="text-xl font-semibold">{lead.name}</h3><span className="rounded-full bg-orange-500/15 text-orange-300 px-2 py-1 text-xs font-bold flex items-center gap-1"><Flame className="w-3 h-3" /> {lead.lead_score}/100</span></div><p className="text-slate-400 mt-1">{lead.need} · {lead.urgency || 'urgency unknown'}</p></div>{lead.verification_status === 'verified' ? <span className="text-emerald-400 text-sm flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Evidence verified</span> : <span className="text-amber-400 text-sm">Needs review</span>}</div>
            <div className="grid sm:grid-cols-4 gap-3 text-sm"><div className="rounded-xl bg-slate-950 p-3"><div className="text-slate-500">Intent</div><b>{lead.intent_score}/100</b></div><div className="rounded-xl bg-slate-950 p-3"><div className="text-slate-500">Freshness</div><b>{lead.freshness_score}/100</b></div><div className="rounded-xl bg-slate-950 p-3"><div className="text-slate-500">Active need</div><b>{lead.active_need_score}/100</b></div><div className="rounded-xl bg-slate-950 p-3"><div className="text-slate-500">Evidence age</div><b>{Number.isFinite(Number(lead.evidence_age_days)) ? `${lead.evidence_age_days} days` : 'Unknown'}</b></div></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-4"><div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Why this is a lead</div><p className="text-slate-200">{lead.evidence}</p><div className="mt-2 text-xs text-slate-500">{lead.evidence_date || 'Evidence date unknown'} · {lead.source || 'Web source'}</div>{lead.source_url && <a href={lead.source_url} target="_blank" rel="noreferrer" className="text-orange-400 text-sm break-all hover:underline">{lead.source_url}</a>}</div>
            {lead.recommended_action && <p className="text-sm text-slate-300"><b>Recommended action:</b> {lead.recommended_action}</p>}
          </article>)}
        </section>}
      </div>
    </div>
  );
}
