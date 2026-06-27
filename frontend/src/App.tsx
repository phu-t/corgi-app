import { useEffect, useState } from 'react'
import axios from 'axios'
import './App.css'

interface Evaluation {
  decision: 'Yes' | 'No' | 'Review'
  reason: string
  payout: number | null
  factors: string[]
  flags: string[]
  reasoning_steps?: string[]
  pm_explanation_review?: {
    adjusted_payout: number
    reason: string
  }
}

interface ClaimCard {
  tracking_number: string
  amount_of_claim: number
  status: string
  max_benefit: number
  approved_benefit_amount: number | null
  pm_explanation: string | null
  pending_docs: string | null
  termination_type: string | null
  monthly_rent: number | null
  property_management_company: string
  lease_state: string
  is_historical: boolean
  predicted_payout?: number
  confidence?: string
  evaluation: Evaluation
}

interface Board {
  approved: ClaimCard[]
  needs_review: ClaimCard[]
  hard_rejection: ClaimCard[]
}

const COLUMNS: { key: keyof Board; title: string; className: string }[] = [
  { key: 'approved', title: 'Approved', className: 'col-approved' },
  { key: 'needs_review', title: 'Needs Review', className: 'col-review' },
  { key: 'hard_rejection', title: 'Hard Rejection', className: 'col-rejected' },
]

function formatCurrency(amount: number | null) {
  if (amount === null) return 'N/A'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

function loadClaim(trackingNumber: string) {
  return axios.get<ClaimCard>(`http://localhost:3001/api/claims/${trackingNumber}`).then(res => res.data)
}

interface DocumentLineItem {
  category: string
  description: string
  amount: number
  likely_eligible: boolean
  reason: string
}

interface DocumentAnalysis {
  tenant_name: string
  property_address: string
  move_out_date: string
  line_items: DocumentLineItem[]
  total_claimed: number
}

function analyzeDocument(file: File) {
  const formData = new FormData()
  formData.append('file', file)
  return axios.post<DocumentAnalysis>('http://localhost:3001/api/claims/analyze-document', formData).then(res => res.data)
}

interface PredictionSummaryContext {
  amount_of_claim: number
  ml_baseline: number
  llm_adjusted_payout: number | null
  final_payout: number | null
  mape: string
  reasoning_steps: string[]
  document_line_items: DocumentLineItem[] | null
}

function loadPredictionSummary(context: PredictionSummaryContext) {
  return axios.post<{ summary: string }>('http://localhost:3001/api/claims/prediction-summary', context).then(res => res.data.summary)
}

function ClaimModal({ claim, onClose }: { claim: ClaimCard; onClose: () => void }) {
  const [livePrediction, setLivePrediction] = useState<{ predicted_payout: number; confidence: string; evaluation: Evaluation } | null>(null)
  const [predicting, setPredicting] = useState(false)
  const [docAnalysis, setDocAnalysis] = useState<DocumentAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)

  const runPrediction = () => {
    setPredicting(true)
    loadClaim(claim.tracking_number)
      .then(result => setLivePrediction({ predicted_payout: result.predicted_payout!, confidence: result.confidence!, evaluation: result.evaluation }))
      .catch(() => {})
      .finally(() => setPredicting(false))
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAnalyzing(true)
    setDocError(null)
    analyzeDocument(file)
      .then(setDocAnalysis)
      .catch(() => setDocError('Failed to analyze document'))
      .finally(() => setAnalyzing(false))
  }

  // Once a document is uploaded, its eligible total becomes the final payout
  // (capped at max benefit), overriding the ML/LLM-adjusted figure.
  const totalEligible = docAnalysis
    ? docAnalysis.line_items.filter(item => item.likely_eligible).reduce((sum, item) => sum + item.amount, 0)
    : null

  const llmAdjustedPayout = livePrediction?.evaluation.pm_explanation_review?.adjusted_payout ?? null

  const finalPayout = livePrediction
    ? (totalEligible !== null ? Math.min(totalEligible, claim.max_benefit) : livePrediction.predicted_payout)
    : null

  const decisionOpeningSentence = livePrediction
    ? livePrediction.evaluation.decision === 'Yes'
      ? 'This claim would have passed.'
      : livePrediction.evaluation.decision === 'No'
        ? 'This claim would have failed.'
        : 'This claim would have been flagged for review.'
    : ''

  // MAPE = the model's absolute percentage error on this claim (ML baseline vs
  // the recorded benefit), matching the Performance tab's definition. The
  // underlying benefit dollar amount is never surfaced — only this percentage.
  const mape = livePrediction && claim.approved_benefit_amount !== null && claim.approved_benefit_amount !== 0
    ? `${(Math.abs((livePrediction.predicted_payout - claim.approved_benefit_amount) / claim.approved_benefit_amount) * 100).toFixed(1)}%`
    : 'N/A'

  // After the prediction resolves (and whenever a document scan changes the
  // picture), ask Claude for a plain-English narrative of how it was reached.
  useEffect(() => {
    if (!livePrediction) return
    queueMicrotask(() => setSummarizing(true))
    loadPredictionSummary({
      amount_of_claim: claim.amount_of_claim,
      ml_baseline: livePrediction.predicted_payout,
      llm_adjusted_payout: llmAdjustedPayout,
      final_payout: finalPayout,
      mape: mape,
      reasoning_steps: livePrediction.evaluation.reasoning_steps ?? [],
      document_line_items: docAnalysis?.line_items ?? null,
    })
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setSummarizing(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrediction, docAnalysis])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Claim #{claim.tracking_number}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="kanban-stats">
          <div className="kanban-stat">
            <label>Status</label>
            <span>{claim.status}</span>
          </div>
          <div className="kanban-stat">
            <label>Termination Type</label>
            <span>{claim.termination_type || 'N/A'}</span>
          </div>
          <div className="kanban-stat">
            <label>Monthly Rent</label>
            <span>{claim.monthly_rent ? formatCurrency(claim.monthly_rent) : 'N/A'}</span>
          </div>
          <div className="kanban-stat">
            <label>Property Manager</label>
            <span>{claim.property_management_company}</span>
          </div>
          <div className="kanban-stat">
            <label>Lease State</label>
            <span>{claim.lease_state}</span>
          </div>
          <div className="kanban-stat">
            <label>Claim Amount</label>
            <span>{formatCurrency(claim.amount_of_claim)}</span>
          </div>
          <div className="kanban-stat">
            <label>Actual Paid</label>
            <span>{formatCurrency(claim.approved_benefit_amount)}</span>
          </div>
        </div>

        {claim.pm_explanation && (
          <div className="explanation">
            <label>PM Notes</label>
            <p>{claim.pm_explanation}</p>
          </div>
        )}

        {!livePrediction && (
          <button className="run-prediction" onClick={runPrediction} disabled={predicting}>
            {predicting ? 'Running model...' : 'Run Prediction'}
          </button>
        )}

        {livePrediction && (
          <div className="kanban-detail">
            <div className="kanban-stats">
              <div className="kanban-stat">
                <label>Predicted Payout</label>
                <span className="highlight">{formatCurrency(finalPayout)}</span>
                {docAnalysis && <small>Source: Document scan</small>}
              </div>
            </div>

            <div className="explanation">
              <label>Prediction Summary</label>
              {summarizing ? (
                <p>{decisionOpeningSentence} Generating summary...</p>
              ) : summary ? (
                <p>{decisionOpeningSentence} {summary}</p>
              ) : (
                <p>{decisionOpeningSentence} Summary unavailable.</p>
              )}
            </div>
          </div>
        )}

        <div className="document-analysis">
          <label className="upload-label">
            {analyzing ? 'Analyzing document...' : 'Upload supporting document'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
              onChange={handleFileSelect}
              disabled={analyzing}
              style={{ display: 'none' }}
            />
          </label>

          {docError && <p className="error">{docError}</p>}

          {docAnalysis && (
            <div className="doc-result">
              <div className="kanban-stats">
                <div className="kanban-stat">
                  <label>Tenant</label>
                  <span>{docAnalysis.tenant_name}</span>
                </div>
                <div className="kanban-stat">
                  <label>Property</label>
                  <span>{docAnalysis.property_address}</span>
                </div>
                <div className="kanban-stat">
                  <label>Move-Out Date</label>
                  <span>{docAnalysis.move_out_date}</span>
                </div>
                <div className="kanban-stat">
                  <label>Total Claimed</label>
                  <span>{formatCurrency(docAnalysis.total_claimed)}</span>
                </div>
              </div>

              <ul className="doc-line-items">
                {docAnalysis.line_items.map((item, i) => (
                  <li key={i} className={item.likely_eligible ? 'eligible' : 'ineligible'}>
                    <strong>{formatCurrency(item.amount)}</strong> — {item.description} ({item.category.replace('_', ' ')})
                    <br />
                    <small>{item.likely_eligible ? 'Likely eligible' : 'Likely ineligible'}: {item.reason}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ClaimCardView({ claim }: { claim: ClaimCard }) {
  const [showModal, setShowModal] = useState(false)

  return (
    <div className="kanban-card" onClick={() => setShowModal(true)}>
      {showModal && <ClaimModal claim={claim} onClose={() => setShowModal(false)} />}

      <div className="kanban-card-header">
        <span className="tracking">Claim #{claim.tracking_number}</span>
        <span className="badge historical">{claim.status}</span>
      </div>

      <div className="kanban-stats">
        <div className="kanban-stat">
          <label>Claimed</label>
          <span>{formatCurrency(claim.amount_of_claim)}</span>
        </div>
        <div className="kanban-stat">
          <label>Actual Paid</label>
          <span className="highlight">{formatCurrency(claim.approved_benefit_amount)}</span>
        </div>
        <div className="kanban-stat">
          <label>Property Manager</label>
          <span>{claim.property_management_company}</span>
        </div>
        <div className="kanban-stat">
          <label>Lease State</label>
          <span>{claim.lease_state}</span>
        </div>
      </div>
    </div>
  )
}

function loadBoard() {
  return axios.get<Board>('http://localhost:3001/api/claims/board').then(res => res.data)
}

interface GroupStat {
  key: string
  count: number
  totalActual: number
  totalPredicted: number
  totalDelta: number
  mae: number
  mape: number
}

interface OutlierRow {
  tracking_number: string
  status: string
  termination_type: string | null
  lease_state: string
  risk_tier: string
  tenant_count: string
  property_management_company: string
  amount_of_claim: number
  max_benefit: number
  actual: number
  predicted: number
  error: number
}

interface Performance {
  overall: Omit<GroupStat, 'key'>
  overallFiltered: Omit<GroupStat, 'key'>
  byTerminationType: GroupStat[]
  byRiskTier: GroupStat[]
  byTenantCount: GroupStat[]
  byPropertyManager: GroupStat[]
  topOutliers: OutlierRow[]
}

function loadPerformance() {
  return axios.get<Performance>('http://localhost:3001/api/claims/performance').then(res => res.data)
}

interface ModelMetrics {
  train_count: number
  test_count: number
  train_mae: number
  train_mape: number
  test_mae: number
  test_mape: number
}

function loadModelMetrics() {
  return axios.get<ModelMetrics>('http://localhost:3001/api/claims/model-metrics').then(res => res.data)
}

interface Retrospective {
  overall: {
    total: number
    wouldPass: number
    wouldFail: number
    wouldReview: number
    actualPass: number
    actualFail: number
  }
  byState: { key: string; wouldFail: number; total: number }[]
  byPropertyManager: { key: string; wouldFail: number; total: number }[]
}

function loadRetrospective() {
  return axios.get<Retrospective>('http://localhost:3001/api/claims/retrospective').then(res => res.data)
}

function GroupTable({ title, groups }: { title: string; groups: GroupStat[] }) {
  return (
    <div className="metric-table">
      <h3>{title}</h3>
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>Count</th>
            <th>Actual Paid</th>
            <th>Predicted</th>
            <th>Delta</th>
            <th>MAPE</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(g => (
            <tr key={g.key}>
              <td>{g.key}</td>
              <td>{g.count}</td>
              <td>{formatCurrency(g.totalActual)}</td>
              <td>{formatCurrency(g.totalPredicted)}</td>
              <td className={g.totalDelta > 0 ? 'over' : 'under'}>
                {g.totalDelta > 0 ? '+' : ''}{formatCurrency(g.totalDelta)}
              </td>
              <td>{g.mape.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PerformanceView() {
  const [data, setData] = useState<Performance | null>(null)
  const [metrics, setMetrics] = useState<ModelMetrics | null>(null)
  const [retrospective, setRetrospective] = useState<Retrospective | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    Promise.all([loadPerformance(), loadModelMetrics(), loadRetrospective()])
      .then(([performance, modelMetrics, retro]) => {
        if (!ignore) {
          setData(performance)
          setMetrics(modelMetrics)
          setRetrospective(retro)
        }
      })
      .catch(() => { if (!ignore) setError('Failed to load model performance') })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [])

  if (loading) {
    return <p className="empty-state">Backtesting model against historical claims — this can take ~20s...</p>
  }

  if (error || !data) {
    return <p className="error">{error || 'Failed to load model performance'}</p>
  }

  return (
    <div>
      <h2 className="view-title">Model Performance</h2>

      {metrics && (
        <div className="metric-table held-out">
          <h3>Held-Out Test Performance (claims the model never trained on)</h3>
          <p className="subtitle">
            Trained on {metrics.train_count} claims, validated against {metrics.test_count} it never saw.
            This is the honest measure of how well it'll predict a brand-new claim.
          </p>
          <table>
            <thead>
              <tr>
                <th>Split</th>
                <th>Claims</th>
                <th>MAE</th>
                <th>MAPE</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Train (seen)</td>
                <td>{metrics.train_count}</td>
                <td>{formatCurrency(metrics.train_mae)}</td>
                <td>{metrics.train_mape.toFixed(1)}%</td>
              </tr>
              <tr>
                <td>Test (held out)</td>
                <td>{metrics.test_count}</td>
                <td>{formatCurrency(metrics.test_mae)}</td>
                <td className={metrics.test_mape > metrics.train_mape * 1.3 ? 'over' : ''}>
                  {metrics.test_mape.toFixed(1)}%
                </td>
              </tr>
            </tbody>
          </table>
          {metrics.test_mape > metrics.train_mape * 1.3 && (
            <p className="warning">
              Test error is notably worse than train error — a sign the model is overfitting to
              claims it has already seen, not just learning generalizable patterns.
            </p>
          )}
        </div>
      )}

      <p className="subtitle">
        Backtest below is in-sample — the production model trained on these same {data.overall.count} historical
        claims, so this number is optimistic. The held-out numbers above are the more honest read.
      </p>

      <div className="overall-stats">
        <div className="overall-stat">
          <label>Total Actually Paid</label>
          <span>{formatCurrency(data.overall.totalActual)}</span>
        </div>
        <div className="overall-stat">
          <label>Total Model Predicted</label>
          <span>{formatCurrency(data.overall.totalPredicted)}</span>
        </div>
        <div className="overall-stat">
          <label>Net Delta (Predicted − Actual)</label>
          <span className={data.overall.totalDelta > 0 ? 'over' : 'under'}>
            {data.overall.totalDelta > 0 ? '+' : ''}{formatCurrency(data.overall.totalDelta)}
          </span>
        </div>
        <div className="overall-stat">
          <label>MAE</label>
          <span>{formatCurrency(data.overall.mae)}</span>
        </div>
        <div className="overall-stat">
          <label>MAPE</label>
          <span>{data.overall.mape.toFixed(1)}%</span>
        </div>
        <div className="overall-stat">
          <label>MAPE (complete data only)</label>
          <span>{data.overallFiltered.mape.toFixed(1)}%</span>
          <small>{data.overallFiltered.count} of {data.overall.count} claims</small>
        </div>
      </div>

      <GroupTable title="By Termination Type" groups={data.byTerminationType} />
      <GroupTable title="By State Risk Tier" groups={data.byRiskTier} />
      <GroupTable title="By Tenant Count" groups={data.byTenantCount} />
      <GroupTable title="By Property Manager (Top 15 by Volume)" groups={data.byPropertyManager} />

      {retrospective && (
        <div className="metric-table">
          <h3>Retrospective Decision Analysis</h3>
          <p className="subtitle">
            What our decision engine would have done across {retrospective.overall.total} historical claims,
            compared to what actually happened in the data.
          </p>

          <div className="overall-stats">
            <div className="overall-stat">
              <label>Would Have Passed</label>
              <span>{retrospective.overall.wouldPass}</span>
            </div>
            <div className="overall-stat">
              <label>Would Have Failed</label>
              <span>{retrospective.overall.wouldFail}</span>
            </div>
            <div className="overall-stat">
              <label>Would Have Reviewed</label>
              <span>{retrospective.overall.wouldReview}</span>
            </div>
            <div className="overall-stat">
              <label>Actually Passed</label>
              <span>{retrospective.overall.actualPass}</span>
            </div>
            <div className="overall-stat">
              <label>Actually Failed</label>
              <span>{retrospective.overall.actualFail}</span>
            </div>
          </div>

          <div className="board" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div className="metric-table">
              <h3>States with Most Would-Have-Failed</h3>
              <table>
                <thead>
                  <tr>
                    <th>State</th>
                    <th>Would Fail</th>
                    <th>Total Claims</th>
                  </tr>
                </thead>
                <tbody>
                  {retrospective.byState.map(row => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td className="over">{row.wouldFail}</td>
                      <td>{row.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="metric-table">
              <h3>PMs with Most Would-Have-Failed</h3>
              <table>
                <thead>
                  <tr>
                    <th>Property Manager</th>
                    <th>Would Fail</th>
                    <th>Total Claims</th>
                  </tr>
                </thead>
                <tbody>
                  {retrospective.byPropertyManager.map(row => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td className="over">{row.wouldFail}</td>
                      <td>{row.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="metric-table">
        <h3>Biggest Misses (Top 20 by Absolute Error)</h3>
        <table>
          <thead>
            <tr>
              <th>Claim</th>
              <th>PM</th>
              <th>State</th>
              <th>Actual</th>
              <th>Predicted</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {data.topOutliers.map(row => (
              <tr key={row.tracking_number}>
                <td>#{row.tracking_number}</td>
                <td>{row.property_management_company}</td>
                <td>{row.lease_state}</td>
                <td>{formatCurrency(row.actual)}</td>
                <td>{formatCurrency(row.predicted)}</td>
                <td className={row.error > 0 ? 'over' : 'under'}>
                  {row.error > 0 ? '+' : ''}{formatCurrency(row.error)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const PAGE_SIZE = 25

function QueueView() {
  const [board, setBoard] = useState<Board | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [visibleCounts, setVisibleCounts] = useState<Record<keyof Board, number>>({
    approved: PAGE_SIZE,
    needs_review: PAGE_SIZE,
    hard_rejection: PAGE_SIZE,
  })

  const refresh = () => {
    setLoading(true)
    setError(null)
    setVisibleCounts({ approved: PAGE_SIZE, needs_review: PAGE_SIZE, hard_rejection: PAGE_SIZE })
    loadBoard()
      .then(setBoard)
      .catch(() => setError('Failed to load claims board'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let ignore = false
    loadBoard()
      .then(data => { if (!ignore) setBoard(data) })
      .catch(() => { if (!ignore) setError('Failed to load claims board') })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [])

  const query = search.trim()
  const isSearching = query !== ''

  const showMore = (key: keyof Board) => {
    setVisibleCounts(prev => ({ ...prev, [key]: prev[key] + PAGE_SIZE }))
  }

  return (
    <div>
      <div className="page-header">
        <h2 className="view-title">Claims Queue</h2>
        <div className="queue-actions">
          <input
            className="search-input"
            type="text"
            placeholder="Search by claim ID..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="refresh" onClick={refresh} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {!error && (
        <div className="board">
          {COLUMNS.map(col => {
            const all = board ? board[col.key] : []
            const filtered = isSearching ? all.filter(c => c.tracking_number.includes(query)) : all
            const visible = isSearching ? filtered : filtered.slice(0, visibleCounts[col.key])
            const hasMore = !isSearching && filtered.length > visibleCounts[col.key]

            return (
              <div className={`column ${col.className}`} key={col.key}>
                <div className="column-header">
                  <h2>{col.title}</h2>
                  <span className="count">{filtered.length}</span>
                </div>
                <div className="column-body">
                  {loading && !board && <p className="empty-state">Loading...</p>}
                  {board && filtered.length === 0 && (
                    <p className="empty-state">{isSearching ? 'No matching claims' : 'No claims'}</p>
                  )}
                  {visible.map(claim => (
                    <ClaimCardView key={claim.tracking_number} claim={claim} />
                  ))}
                  {hasMore && (
                    <button className="show-more" onClick={() => showMore(col.key)}>
                      Show more ({filtered.length - visibleCounts[col.key]} remaining)
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface PMStat {
  property_management_company: string
  claim_count: number
  pct_hit_max_benefit: number | null
  avg_claim_amount: number | null
  avg_payout: number | null
  payout_to_claim_ratio: number | null
  pct_missing_docs: number
  top_explanation: { text: string; count: number } | null
}

function loadPMRisk() {
  return axios.get<{ pms: PMStat[] }>('http://localhost:3001/api/claims/pm-risk').then(res => res.data.pms)
}

function PMRiskView() {
  const [pms, setPMs] = useState<PMStat[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    loadPMRisk()
      .then(result => { if (!ignore) setPMs(result) })
      .catch(() => { if (!ignore) setError('Failed to load PM risk data') })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [])

  if (loading) return <p className="empty-state">Loading...</p>
  if (error || !pms) return <p className="error">{error || 'Failed to load PM risk data'}</p>

  return (
    <div>
      <h2 className="view-title">PM Risk</h2>
      <p className="subtitle">
        Per property manager, across all {pms.reduce((sum, p) => sum + p.claim_count, 0)} claims (5+ claims minimum).
        Sorted by how often they hit max benefit — the strongest single red flag.
      </p>

      <div className="metric-table">
        <table>
          <thead>
            <tr>
              <th>Property Manager</th>
              <th>Claims</th>
              <th>% Hit Max Benefit</th>
              <th>Avg Claim</th>
              <th>Avg Payout</th>
              <th>Payout:Claim Ratio</th>
              <th>% Missing Docs</th>
              <th>Repeated Explanation</th>
            </tr>
          </thead>
          <tbody>
            {pms.map(pm => (
              <tr key={pm.property_management_company}>
                <td>{pm.property_management_company}</td>
                <td>{pm.claim_count}</td>
                <td className={pm.pct_hit_max_benefit !== null && pm.pct_hit_max_benefit >= 70 ? 'over' : ''}>
                  {pm.pct_hit_max_benefit !== null ? `${pm.pct_hit_max_benefit}%` : 'N/A'}
                </td>
                <td>{formatCurrency(pm.avg_claim_amount)}</td>
                <td>{formatCurrency(pm.avg_payout)}</td>
                <td className={pm.payout_to_claim_ratio !== null && pm.payout_to_claim_ratio >= 3 ? 'over' : ''}>
                  {pm.payout_to_claim_ratio !== null ? `${pm.payout_to_claim_ratio}x` : 'N/A'}
                </td>
                <td className={pm.pct_missing_docs >= 20 ? 'over' : ''}>{pm.pct_missing_docs}%</td>
                <td className="explanation-cell">
                  {pm.top_explanation ? `"${pm.top_explanation.text}" (×${pm.top_explanation.count})` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function App() {
  const [view, setView] = useState<'queue' | 'performance' | 'pm-risk'>('queue')

  return (
    <div className="container">
      <div className="page-header">
        <h1>Corgi Claims</h1>
        <div className="tabs">
          <button className={view === 'queue' ? 'tab active' : 'tab'} onClick={() => setView('queue')}>
            Queue
          </button>
          <button className={view === 'performance' ? 'tab active' : 'tab'} onClick={() => setView('performance')}>
            Model Performance
          </button>
          <button className={view === 'pm-risk' ? 'tab active' : 'tab'} onClick={() => setView('pm-risk')}>
            PM Risk
          </button>
        </div>
      </div>

      {view === 'queue' && <QueueView />}
      {view === 'performance' && <PerformanceView />}
      {view === 'pm-risk' && <PMRiskView />}
    </div>
  )
}

export default App
