import { Router, Request, Response } from 'express';
import multer from 'multer';
import pool from '../db';
import { evaluateClaim, getStateRiskTier, normalizeState, anthropic } from '../evaluate';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ACCEPTED_DOCUMENT_TYPES = ['application/pdf'];
const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_DOCUMENT_TYPES];

const ACTIVE_STATUSES = ['New', 'In Process', 'HOLD', 'Pending Docs from PM'];
const GROUND_TRUTH_STATUSES = ['Posted', 'Declined', 'Approved', 'Approved Revised'];

function moneyCast(col: string) {
  const cleaned = `TRIM(REPLACE(REPLACE(${col}, '$', ''), ',', ''))`;
  return `(CASE WHEN ${cleaned} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${cleaned}::NUMERIC ELSE NULL END) AS ${col}`;
}

const CLAIM_FIELDS_SQL = `
  tracking_number,
  ${moneyCast('amount_of_claim')},
  status,
  ${moneyCast('approved_benefit_amount')},
  ${moneyCast('max_benefit')},
  pm_explanation,
  pending_docs,
  has_2nd_tenant,
  has_3rd_tenant,
  relationship_2nd,
  termination_type,
  ${moneyCast('monthly_rent')},
  property_management_company,
  lease_state,
  lease_start_date,
  lease_end_date,
  move_out_date
`;

function historicalEvaluation(claim: any): { bucket: 'approved' | 'hard_rejection'; evaluation: any } {
  if (claim.status === 'Declined') {
    return {
      bucket: 'hard_rejection',
      evaluation: { decision: 'No', reason: 'Declined historically', payout: null, factors: [], flags: [], reasoning_steps: [] },
    };
  }
  return {
    bucket: 'approved',
    evaluation: { decision: 'Yes', reason: `Recorded as ${claim.status}`, payout: null, factors: [], flags: [], reasoning_steps: [] },
  };
}

function parseDate(value: string | null) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// new Date(null) silently evaluates to epoch (1970-01-01), so a missing date
// would otherwise produce a nonsense ~-19000-day duration instead of "unknown".
function daysBetween(a: Date | null, b: Date | null) {
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

async function predictForClaim(claim: any) {
  const leaseStart = parseDate(claim.lease_start_date);
  const leaseEnd = parseDate(claim.lease_end_date);
  const moveOut = parseDate(claim.move_out_date);
  const leaseDurationDays = daysBetween(leaseStart, leaseEnd);
  const earlyExitDays = daysBetween(leaseEnd, moveOut);

  const mlResponse = await fetch('http://localhost:5001/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      monthly_rent: claim.monthly_rent,
      max_benefit: claim.max_benefit,
      amount_of_claim: claim.amount_of_claim,
      termination_type: claim.termination_type,
      lease_state: claim.lease_state,
      property_management_company: claim.property_management_company,
      lease_duration_days: leaseDurationDays,
      early_exit_days: earlyExitDays,
      relationship_2nd: claim.relationship_2nd,
    }),
  });

  return mlResponse.json() as Promise<{ predicted_payout: number; confidence: string }>;
}

function tenantCountLabel(claim: any) {
  if (claim.has_2nd_tenant === 'Yes' && claim.has_3rd_tenant === 'Yes') return '3+'
  if (claim.has_2nd_tenant === 'Yes') return '2'
  return '1'
}

function summarize(rows: { actual: number; predicted: number }[]) {
  const count = rows.length;
  if (count === 0) return { count: 0, totalActual: 0, totalPredicted: 0, totalDelta: 0, mae: 0, mape: 0 };

  let totalActual = 0, totalPredicted = 0, totalAbsError = 0, totalAbsPctError = 0, pctCount = 0;
  for (const { actual, predicted } of rows) {
    totalActual += actual;
    totalPredicted += predicted;
    totalAbsError += Math.abs(predicted - actual);
    if (actual !== 0) {
      totalAbsPctError += Math.abs((predicted - actual) / actual);
      pctCount++;
    }
  }

  return {
    count,
    totalActual: Math.round(totalActual * 100) / 100,
    totalPredicted: Math.round(totalPredicted * 100) / 100,
    totalDelta: Math.round((totalPredicted - totalActual) * 100) / 100,
    mae: Math.round((totalAbsError / count) * 100) / 100,
    mape: pctCount > 0 ? Math.round((totalAbsPctError / pctCount) * 10000) / 100 : 0,
  };
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return groups;
}

router.get('/board', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT ${CLAIM_FIELDS_SQL} FROM claims WHERE status != 'Test Claim'`
    );

    const board = { approved: [] as any[], needs_review: [] as any[], hard_rejection: [] as any[] };

    for (const claim of result.rows) {
      if (ACTIVE_STATUSES.includes(claim.status)) {
        const prediction = await predictForClaim(claim);
        const evaluation = await evaluateClaim({ ...claim, predicted_payout: prediction.predicted_payout });

        const card = {
          ...claim,
          is_historical: false,
          predicted_payout: prediction.predicted_payout,
          confidence: prediction.confidence,
          evaluation,
        };

        if (evaluation.decision === 'Yes') board.approved.push(card);
        else if (evaluation.decision === 'Review') board.needs_review.push(card);
        else board.hard_rejection.push(card);
      } else {
        const { bucket, evaluation } = historicalEvaluation(claim);
        board[bucket].push({ ...claim, is_historical: true, evaluation });
      }
    }

    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/analyze-document', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!ACCEPTED_FILE_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
    }

    const base64 = file.buffer.toString('base64');
    const isPdf = file.mimetype === 'application/pdf';

    const fileContentBlock = isPdf
      ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 } }
      : { type: 'image' as const, source: { type: 'base64' as const, media_type: file.mimetype as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64 } };

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              tenant_name: { type: 'string' },
              property_address: { type: 'string' },
              move_out_date: { type: 'string' },
              line_items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: {
                      type: 'string',
                      enum: ['damages', 'cleaning', 'unpaid_rent', 'late_fees', 'reletting', 'utilities', 'pet_charges', 'key_replacement', 'other'],
                    },
                    description: { type: 'string' },
                    amount: { type: 'number' },
                    likely_eligible: { type: 'boolean' },
                    reason: { type: 'string' },
                  },
                  required: ['category', 'description', 'amount', 'likely_eligible', 'reason'],
                  additionalProperties: false,
                },
              },
              total_claimed: { type: 'number' },
            },
            required: ['tenant_name', 'property_address', 'move_out_date', 'line_items', 'total_claimed'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: 'user',
          content: [
            fileContentBlock,
            {
              type: 'text',
              text: `This file is a security deposit claim document (e.g. a move-out statement or itemized deduction sheet) submitted by a property manager.

Extract the tenant name, property address, and move-out date.

Then extract every itemized deduction line you can find, categorizing each into exactly one of: damages, cleaning, unpaid_rent, late_fees, reletting, utilities, pet_charges, key_replacement, or other. For each line item, give a short description, the dollar amount, and assess whether it is likely_eligible under a standard security deposit program — normal wear and tear is NOT eligible, but actual damage beyond normal wear and tear, unpaid rent, necessary cleaning beyond normal, late fees per the lease terms, reletting/re-rental costs, unpaid utilities, pet damage beyond a pet deposit, and key/lock replacement are typically eligible. Give a brief reason for each eligibility assessment.

Finally, report the total claimed amount as stated or summed on the document.`,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const parsed = JSON.parse(textBlock!.text);
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/prediction-summary', async (req: Request, res: Response) => {
  try {
    const {
      amount_of_claim,
      ml_baseline,
      llm_adjusted_payout,
      final_payout,
      mape,
      reasoning_steps,
      document_line_items,
    } = req.body;

    const llmLine = llm_adjusted_payout !== null && llm_adjusted_payout !== undefined
      ? `- LLM-adjusted payout (after Claude read the property manager's explanation): $${llm_adjusted_payout}\n`
      : '';

    const docSection = Array.isArray(document_line_items) && document_line_items.length > 0
      ? `\nA supporting document was uploaded and scanned. Itemized line items:\n${document_line_items
          .map((i: any) => `- ${i.description}: $${i.amount} (${i.likely_eligible ? 'eligible' : 'ineligible'} — ${i.reason})`)
          .join('\n')}\n`
      : '';

    const stepsSection = Array.isArray(reasoning_steps) && reasoning_steps.length > 0
      ? reasoning_steps.map((s: string) => `  - ${s}`).join('\n')
      : '  - (none)';

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `You are explaining how a rental security-deposit claim payout prediction was reached, for an internal claims-adjuster tool. Write a short plain-English paragraph of 2-3 sentences. Do not use bullet points, markdown, or headings — just prose.

Context:
- Submitted claim amount: $${amount_of_claim}
- ML baseline prediction (raw model output, before any adjustment): $${ml_baseline}
${llmLine}- Final predicted payout (after all caps, fallbacks, and any document scan): $${final_payout}
- Model error on this claim (MAPE — the model's absolute percentage error against the recorded benefit): ${mape}
- Internal reasoning steps the system recorded:
${stepsSection}${docSection}

Explain how the final predicted payout was reached and what the MAPE indicates about how accurate the model was on this claim. When referring to the engine's decision on the claim, phrase it as the claim "would have passed", "would have failed", or "would have been flagged for review" — do not use the words "approved" or "declined". IMPORTANT: do not state, quote, or estimate the actual/approved/paid benefit dollar amount — refer to the model's accuracy only through the MAPE percentage. Keep it to 2-3 sentences.`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    res.json({ summary: textBlock!.text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/model-metrics', async (_req: Request, res: Response) => {
  try {
    const mlResponse = await fetch('http://localhost:5001/model-info');
    const data = await mlResponse.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/pm-risk', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT ${CLAIM_FIELDS_SQL} FROM claims WHERE status != 'Test Claim'`
    );

    const byPM = groupBy(result.rows, r => r.property_management_company || 'Unknown');

    const pmStats = Array.from(byPM.entries())
      .filter(([, rows]) => rows.length >= 5)
      .map(([pm, rows]) => {
        const withOutcome = rows.filter(r => r.approved_benefit_amount != null && r.max_benefit != null && r.max_benefit > 0);
        const hitMaxCount = withOutcome.filter(r => r.approved_benefit_amount >= r.max_benefit * 0.98).length;

        const claimAmounts = rows.filter(r => r.amount_of_claim != null).map(r => Number(r.amount_of_claim));
        const payouts = rows.filter(r => r.approved_benefit_amount != null).map(r => Number(r.approved_benefit_amount));
        const avgClaim = claimAmounts.length ? claimAmounts.reduce((a, b) => a + b, 0) / claimAmounts.length : null;
        const avgPayout = payouts.length ? payouts.reduce((a, b) => a + b, 0) / payouts.length : null;

        const missingDocsCount = rows.filter(r => r.pending_docs && String(r.pending_docs).trim() !== '').length;

        const explanationCounts = new Map<string, number>();
        for (const r of rows) {
          const text = r.pm_explanation && String(r.pm_explanation).trim();
          if (text) explanationCounts.set(text, (explanationCounts.get(text) || 0) + 1);
        }
        let topExplanation: { text: string; count: number } | null = null;
        for (const [text, count] of explanationCounts.entries()) {
          if (count >= 2 && (!topExplanation || count > topExplanation.count)) topExplanation = { text, count };
        }

        return {
          property_management_company: pm,
          claim_count: rows.length,
          pct_hit_max_benefit: withOutcome.length ? Math.round((hitMaxCount / withOutcome.length) * 1000) / 10 : null,
          avg_claim_amount: avgClaim !== null ? Math.round(avgClaim * 100) / 100 : null,
          avg_payout: avgPayout !== null ? Math.round(avgPayout * 100) / 100 : null,
          payout_to_claim_ratio: avgClaim && avgPayout ? Math.round((avgPayout / avgClaim) * 100) / 100 : null,
          pct_missing_docs: Math.round((missingDocsCount / rows.length) * 1000) / 10,
          top_explanation: topExplanation,
        };
      })
      .sort((a, b) => (b.pct_hit_max_benefit ?? 0) - (a.pct_hit_max_benefit ?? 0));

    res.json({ pms: pmStats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/performance', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM (
        SELECT ${CLAIM_FIELDS_SQL} FROM claims WHERE status = ANY($1)
      ) t
      WHERE approved_benefit_amount > 0`,
      [GROUND_TRUTH_STATUSES]
    );

    const rows: any[] = [];
    const completeRows: any[] = [];
    for (const claim of result.rows) {
      const prediction = await predictForClaim(claim);
      const row = {
        tracking_number: claim.tracking_number,
        status: claim.status,
        termination_type: claim.termination_type,
        lease_state: claim.lease_state,
        risk_tier: getStateRiskTier(claim.lease_state),
        tenant_count: tenantCountLabel(claim),
        property_management_company: claim.property_management_company,
        amount_of_claim: Number(claim.amount_of_claim),
        max_benefit: Number(claim.max_benefit),
        actual: Number(claim.approved_benefit_amount),
        predicted: Number(prediction.predicted_payout),
        error: Math.round((Number(prediction.predicted_payout) - Number(claim.approved_benefit_amount)) * 100) / 100,
      };
      rows.push(row);

      const hasCompleteData = !!claim.termination_type && claim.termination_type !== 'Unknown'
        && !!claim.lease_end_date && claim.monthly_rent !== null;
      if (hasCompleteData) completeRows.push(row);
    }

    const overall = summarize(rows);
    const overallFiltered = summarize(completeRows);

    const byGroup = (keyFn: (r: typeof rows[number]) => string) =>
      Array.from(groupBy(rows, keyFn).entries())
        .map(([key, groupRows]) => ({ key, ...summarize(groupRows) }))
        .sort((a, b) => b.count - a.count);

    const topOutliers = [...rows]
      .sort((a, b) => Math.abs(b.error) - Math.abs(a.error))
      .slice(0, 20);

    res.json({
      overall,
      overallFiltered,
      byTerminationType: byGroup(r => r.termination_type || 'Unknown'),
      byRiskTier: byGroup(r => r.risk_tier),
      byTenantCount: byGroup(r => r.tenant_count),
      byPropertyManager: byGroup(r => r.property_management_company || 'Unknown').slice(0, 15),
      topOutliers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sync port of evaluateClaim's hard-check decision path, for the retrospective
// "what would the engine have decided" analysis. We deliberately skip the two
// expensive/LLM-dependent steps — the ML ratio check and the Claude PM review —
// so this runs instantly across every historical claim instead of firing a
// model call per row. Those steps only ever push a claim into the *review*
// bucket, so the pass/fail outcomes (and the by-state / by-PM would-fail
// breakdowns) are exact; only ratio-flagged reviews are folded back into pass.
function retrospectiveDecision(claim: any): 'pass' | 'fail' | 'review' {
  if (claim.status === 'Declined' && typeof claim.pm_explanation === 'string' && claim.pm_explanation.toLowerCase().includes('duplicate')) return 'fail';
  if (!claim.max_benefit || Number(claim.max_benefit) === 0) return 'fail';
  if (claim.pending_docs && String(claim.pending_docs).trim() !== '') return 'review';
  if (!claim.amount_of_claim || Number(claim.amount_of_claim) === 0) return 'fail';
  return 'pass';
}

router.get('/retrospective', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT ${CLAIM_FIELDS_SQL} FROM claims WHERE status = ANY($1)`,
      [GROUND_TRUTH_STATUSES]
    );

    const overall = { total: 0, wouldPass: 0, wouldFail: 0, wouldReview: 0, actualPass: 0, actualFail: 0 };
    const stateFails = new Map<string, { fails: number; total: number }>();
    const pmFails = new Map<string, { fails: number; total: number }>();

    for (const claim of result.rows) {
      const decision = retrospectiveDecision(claim);
      const actual: 'pass' | 'fail' = claim.status === 'Declined' ? 'fail' : 'pass';

      overall.total++;
      if (decision === 'pass') overall.wouldPass++;
      else if (decision === 'fail') overall.wouldFail++;
      else overall.wouldReview++;
      if (actual === 'pass') overall.actualPass++;
      else overall.actualFail++;

      const state = normalizeState(claim.lease_state) || 'Unknown';
      const stateEntry = stateFails.get(state) || { fails: 0, total: 0 };
      stateEntry.total++;
      if (decision === 'fail') stateEntry.fails++;
      stateFails.set(state, stateEntry);

      const pm = claim.property_management_company || 'Unknown';
      const pmEntry = pmFails.get(pm) || { fails: 0, total: 0 };
      pmEntry.total++;
      if (decision === 'fail') pmEntry.fails++;
      pmFails.set(pm, pmEntry);
    }

    const byState = Array.from(stateFails.entries())
      .map(([state, v]) => ({ key: state, wouldFail: v.fails, total: v.total }))
      .filter(r => r.wouldFail > 0)
      .sort((a, b) => b.wouldFail - a.wouldFail)
      .slice(0, 10);

    const byPropertyManager = Array.from(pmFails.entries())
      .map(([pm, v]) => ({ key: pm, wouldFail: v.fails, total: v.total }))
      .filter(r => r.wouldFail > 0)
      .sort((a, b) => b.wouldFail - a.wouldFail)
      .slice(0, 10);

    res.json({ overall, byState, byPropertyManager });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT ${CLAIM_FIELDS_SQL} FROM claims WHERE tracking_number = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Claim not found' });
    }

    const claim = result.rows[0];

    const prediction = await predictForClaim(claim);
    const evaluation = await evaluateClaim({ ...claim, predicted_payout: prediction.predicted_payout });

    res.json({
      ...claim,
      predicted_payout: prediction.predicted_payout,
      confidence: prediction.confidence,
      evaluation,
      pm_explanation_review: evaluation.pm_explanation_review,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;