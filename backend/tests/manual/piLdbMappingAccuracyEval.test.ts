/**
 * PI-LDB AI mapping - LIVE accuracy eval, OLD payload (b828b8635) vs NEW payload (option D). Owner-approved
 * 2026-11-20 via b3 (~$0.01, follow-up, not a gate).
 *
 * MANUAL ONLY (jest.manual.config.js). Runs only when OPENAI_EVAL_API_KEY is supplied in the environment at run time.
 * It never reads an env FILE and never prints the key. Synthetic headers and FAKE sample values only (no tenant data);
 * the engine redacts them exactly as in production. Billing is bypassed: the proposer's billed call is replaced by a
 * direct chat-completions call with the SAME messages, model, temperature, response_format and max_tokens.
 *
 * Old module: a temporary copy of b828b8635's gatewayProposer.ts at
 * backend/services/leadMapping/__evalOldGatewayProposer.ts (written before the run, deleted after).
 *
 * STATUS: PARKED (b3, 2026-11-20). It runs only if the owner supplies a SEPARATE low-limit eval key. The production
 * key is never used: no agent loads or reads .env* values, and approving the eval did not extend to that.
 * L2 is not gated on this eval.
 *
 * DRY-RUN BASELINE (OPENAI_EVAL_DRYRUN=1, fake model, 2026-11-20):
 *   - deterministic scorer alone: 51/70 scorable columns right;
 *   - real input per request, measured at chars/4: old payload ~1,600 tokens, new ~1,100 (-32%).
 * The live run answers how many of the remaining 19 columns the model adds under each payload, and how many of its
 * hints are WRONG.
 *
 * To run:
 *   git show b828b8635:backend/services/leadMapping/gatewayProposer.ts > backend/services/leadMapping/__evalOldGatewayProposer.ts
 *   OPENAI_EVAL_API_KEY=<eval key> npx jest -c jest.manual.config.js backend/tests/manual/piLdbMappingAccuracyEval.test.ts
 *   rm backend/services/leadMapping/__evalOldGatewayProposer.ts
 */
import { proposeFieldMappings } from '../../services/leadMapping/mappingEngine';
import { createGatewayMappingProposer as createNew } from '../../services/leadMapping/gatewayProposer';

const KEY = process.env.OPENAI_EVAL_API_KEY;
/** OPENAI_EVAL_DRYRUN=1: wiring check with a fake model (no network, no cost). */
const DRY = process.env.OPENAI_EVAL_DRYRUN === '1';
const maybe = KEY || DRY ? it : it.skip;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadOld = () => require('../../services/leadMapping/__evalOldGatewayProposer').createGatewayMappingProposer;

type Col = { h: string; v: string[]; ok: string[] };
const S = (h: string, v: string[], ...ok: string[]): Col => ({ h, v, ok });

/** 10 header sets in common export styles. `ok` = acceptable targets (ambiguous headings accept both readings). */
const SETS: Array<{ name: string; cols: Col[] }> = [
  { name: 'apollo-like', cols: [
    S('First Name', ['Ada', 'Alan'], 'firstName'), S('Last Name', ['Lovelace', 'Turing'], 'lastName'),
    S('Title', ['Head of Analysis', 'VP Engineering'], 'jobTitle'), S('Company', ['Acme Ltd', 'Globex'], 'companyName'),
    S('Email', ['ada@example.test', 'alan@example.test'], 'email'), S('Website', ['acme.example', 'globex.example'], 'companyDomain'),
    S('# Employees', ['250', '1200'], 'employeeCount'), S('Industry', ['Software', 'Logistics'], 'industry'),
    S('City', ['London', 'Leeds'], 'city', 'companyCity'), S('Country', ['United Kingdom', 'Ireland'], 'countryCode', 'companyCountryCode'),
  ] },
  { name: 'hubspot-like', cols: [
    S('Contact ID', ['10293', '10294'], 'referenceId'), S('Full Name', ['Grace Hopper', 'Edsger Dijkstra'], 'fullName'),
    S('Job Title', ['CTO', 'Researcher'], 'jobTitle'), S('Phone Number', ['+44 20 7946 0000', '+44 20 7946 0001'], 'phone'),
    S('Associated Company', ['Initech', 'Hooli'], 'companyName'), S('Company Domain Name', ['initech.example', 'hooli.example'], 'companyDomain'),
    S('Annual Revenue', ['5000000', '120000000'], 'annualRevenue'), S('Create Date', ['2026-01-04', '2026-02-11'], 'observedAt'),
  ] },
  { name: 'salesforce-like', cols: [
    S('Lead Owner', ['Sam Rep', 'Kim Rep'] /* no destination */), S('Name', ['Barbara Liskov', 'John Backus'], 'fullName'),
    S('Account Name', ['Umbrella', 'Stark'], 'companyName'), S('Email', ['b@example.test', 'j@example.test'], 'email'),
    S('Mobile', ['+353 1 555 0100', '+353 1 555 0101'], 'phone'), S('Department', ['Engineering', 'Sales'], 'department'),
    S('Billing City', ['Dublin', 'Cork'], 'companyCity'), S('Billing Country', ['Ireland', 'Ireland'], 'companyCountryCode'),
  ] },
  { name: 'linkedin-export-like', cols: [
    S('First Name', ['Margaret'], 'firstName'), S('Last Name', ['Hamilton'], 'lastName'),
    S('Email Address', ['m@example.test'], 'email'), S('Company', ['Apollo Guidance'], 'companyName'),
    S('Position', ['Director of Software'], 'jobTitle'), S('Connected On', ['04 Jan 2026'], 'observedAt'),
  ] },
  { name: 'zoominfo-like', cols: [
    S('Company Name', ['Wayne Ent'], 'companyName'), S('Website', ['wayne.example'], 'companyDomain'),
    S('Revenue Range', ['$10M - $50M'], 'revenueBand'), S('Employee Range', ['100-249'], 'employeeBand'),
    S('Primary Industry', ['Manufacturing'], 'industry'), S('Founded Year', ['1998'], 'foundedYear'),
    S('Company HQ City', ['Gotham'], 'companyCity'), S('Company HQ Country', ['United States'], 'companyCountryCode'),
    S('Tech Stack', ['Salesforce; HubSpot'], 'technologies'), S('Last Funding Date', ['2025-06-01'], 'lastFundingAt'),
  ] },
  { name: 'generic-crm', cols: [
    S('name', ['Ada Lovelace'], 'fullName'), S('email_address', ['ada@example.test'], 'email'),
    S('tel', ['+44 20 7946 0000'], 'phone'), S('org', ['Acme Ltd'], 'companyName'),
    S('role', ['Head of Analysis'], 'jobTitle'), S('location', ['London, UK'], 'city', 'region', 'countryCode'),
  ] },
  { name: 'abbreviated', cols: [
    S('FN', ['Alan'], 'firstName'), S('LN', ['Turing'], 'lastName'), S('Co.', ['Bletchley'], 'companyName'),
    S('Ttl', ['Cryptanalyst'], 'jobTitle'), S('E-mail', ['alan@example.test'], 'email'), S('Dom', ['bletchley.example'], 'companyDomain'),
  ] },
  { name: 'funding-focus', cols: [
    S('Organization', ['Hooli'], 'companyName'), S('Funding Stage', ['Series B'], 'fundingStage'),
    S('Last Round Date', ['2025-09-30'], 'lastFundingAt'), S('Headcount', ['340'], 'employeeCount'),
    S('About', ['Builds compression software for enterprises.'], 'description'), S('HQ Region', ['California'], 'companyRegion'),
  ] },
  { name: 'non-english-ish', cols: [
    S('Vorname', ['Klaus'], 'firstName'), S('Nachname', ['Schmidt'], 'lastName'), S('Firma', ['Muster GmbH'], 'companyName'),
    S('Position', ['Geschäftsführer'], 'jobTitle'), S('E-Mail-Adresse', ['k@example.test'], 'email'), S('Telefon', ['+49 30 123456'], 'phone'),
  ] },
  { name: 'ambiguous-and-noise', cols: [
    S('Notes', ['Met at conference'] /* no destination */), S('Lead Score', ['87'] /* no destination */),
    S('Contact Email', ['x@example.test'], 'email'), S('Company Size', ['51-200'], 'employeeBand'),
    S('Size (employees)', ['120'], 'employeeCount'), S('Domain', ['example.example'], 'companyDomain'),
    S('Region', ['EMEA'], 'region', 'companyRegion'),
  ] },
];

async function callOpenAI(completion: any): Promise<{ text: string; inTok: number; outTok: number }> {
  if (DRY) {
    const chars = completion.messages.map((m: any) => m.content.length).reduce((a: number, b: number) => a + b, 0);
    return { text: '{"proposals":[]}', inTok: Math.ceil(chars / 4), outTok: 10 };
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: completion.model, temperature: completion.temperature, messages: completion.messages,
      response_format: completion.response_format, max_tokens: completion.max_tokens,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`); // status only - never the body or headers
  const j: any = await res.json();
  return { text: j.choices?.[0]?.message?.content ?? '', inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0 };
}

const ctx = { tenantId: '00000000-0000-4000-8000-0000000000e1', actorUserId: '00000000-0000-4000-8000-0000000000e2', sourceType: 'csv', schemaFingerprint: 'eval' };

async function runOne(create: any, set: { cols: Col[] }) {
  let usage = { inTok: 0, outTok: 0 };
  let modelOut: Array<{ sourceField: string; target: string }> = [];
  const run = async (args: any) => { const r = await callOpenAI(args.completion); usage = r; return { text: r.text }; };
  const base = create(ctx as any, { runCompletion: run as any });
  const proposer = async (req: any) => { const out = await base(req); modelOut = out as any; return out; };
  const headers = set.cols.map((c) => c.h);
  const result = await proposeFieldMappings({ sourceType: 'csv', tenantId: ctx.tenantId, headers,
    samples: Object.fromEntries(set.cols.map((c) => [c.h, c.v])) } as any, proposer as any);
  const refused = result.degraded.some((d: any) => d.sourceField === '*');
  let modelRight = 0; let modelWrong = 0; let modelNone = 0; let finalRight = 0; let scorable = 0;
  for (const c of set.cols) {
    const m = modelOut.find((p) => p.sourceField === c.h);
    const f = result.proposals.find((p: any) => p.sourceField === c.h) as any;
    const finalTarget = f?.candidate?.target ?? null;
    if (c.ok.length === 0) { // a column with no destination: right = no suggestion
      if (!m) modelRight++; else modelWrong++;
      continue;
    }
    scorable++;
    if (!m) modelNone++; else if (c.ok.includes(m.target)) modelRight++; else modelWrong++;
    if (finalTarget && c.ok.includes(finalTarget)) finalRight++;
  }
  return { refused, modelRight, modelWrong, modelNone, finalRight, scorable, cols: set.cols.length, ...usage, degraded: result.degraded };
}

describe('PI-LDB mapping accuracy, old vs new payload (LIVE)', () => {
  maybe('runs 10 header sets through both payloads and reports', async () => {
    const createOld = loadOld();
    const rows: string[] = [];
    const tot = { old: { r: 0, w: 0, n: 0, f: 0, s: 0, in: 0, out: 0, cols: 0 }, new: { r: 0, w: 0, n: 0, f: 0, s: 0, in: 0, out: 0, cols: 0 } };
    for (const set of SETS) {
      for (const [label, create] of [['old', createOld], ['new', createNew]] as const) {
        const r = await runOne(create, set);
        const t = (tot as any)[label];
        t.r += r.modelRight; t.w += r.modelWrong; t.n += r.modelNone; t.f += r.finalRight; t.s += r.scorable; t.in += r.inTok; t.out += r.outTok; t.cols += r.cols;
        rows.push(`EVAL ${set.name} ${label}: refused=${r.refused} model right/wrong/none=${r.modelRight}/${r.modelWrong}/${r.modelNone} of ${r.cols} cols; final right ${r.finalRight}/${r.scorable}; tokens in/out ${r.inTok}/${r.outTok}`);
      }
    }
    for (const r of rows) console.log(r);
    for (const k of ['old', 'new'] as const) {
      const t = tot[k];
      console.log(`EVAL TOTAL ${k}: model right ${t.r}/${t.cols}, wrong ${t.w}, none ${t.n}; final right ${t.f}/${t.s}; tokens in ${t.in} out ${t.out}; cost $${((t.in * 0.00015 + t.out * 0.0006) / 1000).toFixed(5)} (published) / $${((t.in * 0.0003 + t.out * 0.0006) / 1000).toFixed(5)} (llm_model_pricing)`);
    }
  }, 300_000);
});
