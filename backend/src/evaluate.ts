import Anthropic from '@anthropic-ai/sdk'

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface Claim {
    tracking_number: string
    amount_of_claim: number
    max_benefit: number
    approved_benefit_amount: number
    status: string
    termination_type: string | null
    monthly_rent: number | null
    property_management_company: string
    lease_state: string
    pm_explanation: string | null
    pending_docs: string | null
    has_2nd_tenant: string | null
    has_3rd_tenant: string | null
    lease_start_date: string | null
    lease_end_date: string | null
    move_out_date: string | null
    predicted_payout: number
  }
  
  interface EvaluationResult {
    decision: 'Yes' | 'No' | 'Review'
    reason: string
    payout: number | null
    factors: string[]
    flags: string[]
    reasoning_steps: string[]
    pm_explanation_review?: {
      adjusted_payout: number
      reason: string
    }
  }
  
  const HIGH_RISK_STATES = ['GA', 'SC', 'CA', 'TX']
  const LOW_RISK_STATES = ['NE', 'IA', 'KS']

  // lease_state is free-text in the source data — full names, mixed case, and at
  // least one typo ("Teaxs") all show up alongside two-letter abbreviations.
  const STATE_NAME_TO_ABBR: Record<string, string> = {
    ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
    COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
    HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
    KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
    MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO',
    MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
    'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH',
    OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
    'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', TEAXS: 'TX', UTAH: 'UT', VERMONT: 'VT',
    VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
    'DISTRICT OF COLUMBIA': 'DC',
  }

  export function normalizeState(state: string | null): string | null {
    if (!state) return null
    const trimmed = state.trim().toUpperCase()
    if (!trimmed) return null
    if (trimmed.length === 2) return trimmed
    return STATE_NAME_TO_ABBR[trimmed] || trimmed
  }

  export function getStateRiskTier(state: string | null): 'high' | 'low' | 'medium' {
    const normalized = normalizeState(state)
    if (!normalized) return 'medium'
    if (HIGH_RISK_STATES.includes(normalized)) return 'high'
    if (LOW_RISK_STATES.includes(normalized)) return 'low'
    return 'medium'
  }

  export async function evaluateClaim(claim: Claim): Promise<EvaluationResult> {
    const factors: string[] = []
    const flags: string[] = []
    const reasoningSteps: string[] = []
  
    // ---- HARD CHECKS ----
  
    // Duplicate check
    if (claim.status === 'Declined' && claim.pm_explanation?.toLowerCase().includes('duplicate')) {
      return {
        decision: 'No',
        reason: 'Duplicate claim',
        payout: null,
        factors: [],
        flags: ['Duplicate detected'],
        reasoning_steps: []
      }
    }
  
    // No valid policy
    if (!claim.max_benefit || claim.max_benefit === 0) {
      return {
        decision: 'No',
        reason: 'No valid policy found',
        payout: null,
        factors: [],
        flags: ['Missing policy'],
        reasoning_steps: []
      }
    }
  
    // Missing docs — blocked on PM, not a permanent rejection
    if (claim.pending_docs && claim.pending_docs.trim() !== '') {
      return {
        decision: 'Review',
        reason: 'Pending documents from PM',
        payout: null,
        factors: [],
        flags: [`Missing: ${claim.pending_docs}`],
        reasoning_steps: []
      }
    }
  
    // No amount of claim
    if (!claim.amount_of_claim || claim.amount_of_claim === 0) {
      return {
        decision: 'No',
        reason: 'No claim amount submitted',
        payout: null,
        factors: [],
        flags: ['Missing claim amount'],
        reasoning_steps: []
      }
    }
  
    // ---- DATA POINTS ASSESSMENT ----
  
    let payout = claim.predicted_payout
  
    // Termination type
    if (claim.termination_type === 'Eviction') {
      factors.push('Eviction — higher risk, full payout weighted')
      payout = Math.min(payout * 1.1, claim.max_benefit)
      reasoningSteps.push(`Eviction termination — increased payout by 10% to ${payout.toFixed(2)} (capped at max benefit)`)
    } else if (claim.termination_type === 'Move-Out') {
      factors.push('Move-Out — standard termination')
    }

    // Claim amount vs predicted — flag big gaps
    const claimRatio = claim.predicted_payout / claim.amount_of_claim
    if (claimRatio > 5) {
      flags.push(`Predicted payout (${claim.predicted_payout}) is ${claimRatio.toFixed(1)}x the claim amount (${claim.amount_of_claim}) — review recommended`)
      payout = Math.min(claim.amount_of_claim * 2, claim.max_benefit)
      reasoningSteps.push('Claim amount appears unusually low relative to the predicted payout — flagged for manual review')
    }

    // Number of tenants
    if (claim.has_2nd_tenant === 'Yes' && claim.has_3rd_tenant === 'Yes') {
      factors.push('3+ tenants — increased wear and tear risk')
      payout = Math.min(payout * 1.05, claim.max_benefit)
      reasoningSteps.push(`3+ tenants on the lease — increased payout by 5% to ${payout.toFixed(2)} (capped at max benefit)`)
    } else if (claim.has_2nd_tenant === 'Yes') {
      factors.push('2 tenants — moderate risk')
      reasoningSteps.push('2 tenants on the lease — moderate risk, no payout adjustment')
    }
  
    // Monthly rent context
    if (claim.monthly_rent) {
      if (claim.monthly_rent > 2000) {
        factors.push('High rent property — higher value at risk')
      } else if (claim.monthly_rent < 1000) {
        factors.push('Lower rent property')
      }
    }
  
    // PM explanation present
    let pmExplanationReview: { adjusted_payout: number; reason: string } | undefined
    let pmReasonOverride: string | undefined
    if (claim.pm_explanation) {
      factors.push('PM explanation provided — see notes')
      pmExplanationReview = await reviewPmExplanation(claim.pm_explanation, claim.amount_of_claim, claim.predicted_payout, claim.max_benefit)
      reasoningSteps.push(`Claude PM explanation review: ${pmExplanationReview.reason}`)

      if (pmExplanationReview.adjusted_payout < claim.predicted_payout * 0.2) {
        flags.push('Claude adjustment unusually low — falling back to ML baseline')
        pmReasonOverride = 'ML baseline used — Claude adjustment below threshold'
        payout = claim.predicted_payout
      } else {
        payout = pmExplanationReview.adjusted_payout
        pmReasonOverride = 'Payout adjusted by PM explanation review'
      }
    }

    // Cap at max benefit — always
    payout = Math.min(payout, claim.max_benefit)

    // Round to 2dp
    payout = Math.round(payout * 100) / 100

    // Final decision
    const decision = flags.length > 0 ? 'Review' : 'Yes'

    return {
      decision,
      reason: pmReasonOverride ?? (decision === 'Yes' ? 'Claim passes all checks' : 'Claim flagged for manual review'),
      payout,
      factors,
      flags,
      reasoning_steps: reasoningSteps,
      ...(pmExplanationReview ? { pm_explanation_review: pmExplanationReview } : {})
    }
  }

  async function reviewPmExplanation(
    pmExplanation: string,
    claimAmount: number,
    currentPayout: number,
    maxBenefit: number
  ): Promise<{ adjusted_payout: number; reason: string }> {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              adjusted_payout: { type: 'number' },
              reason: { type: 'string' }
            },
            required: ['adjusted_payout', 'reason'],
            additionalProperties: false
          }
        }
      },
      messages: [
        {
          role: 'user',
          content: `An ML model estimated a baseline payout of $${currentPayout} for this rental claim, based on historical patterns from similar claims (rent, state, termination type, tenant count, etc.). The ML model cannot read text and has no knowledge of the property manager's explanation below — it only ever sees numeric and categorical claim attributes. Treat this baseline as context only, not a hard ceiling on the adjusted payout.

The submitted claim amount is $${claimAmount}. The policy's max benefit is $${maxBenefit} — this is the hard ceiling; the adjusted payout must never exceed it.

The property manager provided this explanation:
"""
${pmExplanation}
"""

Your job is to read the explanation and adjust the payout to reflect only the eligible portion of the claim:
- If the explanation indicates the claim is fully ineligible, return an adjusted payout of 0.
- If the explanation indicates the claim is partially ineligible, return the eligible portion of the claim amount, capped at the max benefit of $${maxBenefit} (never exceed it). This may be higher or lower than the ML baseline.
- If the explanation has no bearing on eligibility, return the ML baseline of $${currentPayout} unchanged.

Respond with the adjusted payout amount and your reason for the adjustment.`
        }
      ]
    })

    const textBlock = response.content.find((block) => block.type === 'text')
    const parsed = JSON.parse(textBlock!.text)
    return { adjusted_payout: parsed.adjusted_payout, reason: parsed.reason }
  }