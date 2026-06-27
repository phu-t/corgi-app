# Corgi Claims

An AI-powered internal claims decision tool for security deposit insurance.

## What It Does

Runs security deposit claims through a three-layer decision engine:

1. **ML Model** — predicts payout amount based on historical claim patterns
2. **LLM (Claude)** — reads PM explanations to identify exclusions and adjust payout
3. **Document Processing (Claude Vision)** — reads scanned claim documents, extracts line items, determines eligibility

Each layer informs the final payout recommendation, always capped at the policy maximum.

## Tech Stack

- **Frontend** — React + TypeScript (Vite)
- **Backend** — Node.js + Express + TypeScript
- **Database** — PostgreSQL
- **ML Service** — Python + Flask + scikit-learn (Random Forest)
- **LLM** — Anthropic Claude API

## Project Structure
corgi-project/
├── backend/        Node.js + Express API
├── frontend/       React TypeScript UI
└── ml/             Python Flask ML service
## Setup

### Prerequisites
- Node.js
- Python 3.9+
- PostgreSQL

### Database
```bash
psql postgres
CREATE DATABASE corgi_claims;
```

Import the claims CSV:
```bash
psql corgi_claims -c "\copy claims FROM 'path/to/claims.csv' WITH (FORMAT csv, HEADER true, NULL '');"
```

### Environment Variables
Copy `backend/.env.example` to `backend/.env` and fill in your values:

```
PORT=3001
DB_HOST=localhost
DB_PORT=5432
DB_NAME=corgi_claims
DB_USER=your_username
DB_PASSWORD=your_password
ANTHROPIC_API_KEY=your_api_key_here
```

### Running The App

Three services need to run simultaneously:

**Backend:**
```bash
cd backend
npm install
npm run dev
```

**ML Service:**
```bash
cd ml
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

## Features

- **Claims Queue** — Kanban board showing which claims would have passed, failed, or need review
- **Model Performance** — MAPE, MAE, breakdowns by termination type, state, PM, retrospective analysis
- **PM Risk** — Property manager risk scoring, fraud signals, payout patterns
- **Document Upload** — Upload scanned claim documents for Claude vision analysis
- **Prediction Summary** — Plain English explanation of why each claim passed or failed

## Model Performance

- Training data: 677 usable claims
- Held-out test MAPE: 97.3%
- Held-out test MAE: $484
- Known limitation: overfitting on small dataset — accuracy improves with more data

## Next Steps

- Fix 220 Unknown termination types
- Cache Claude analysis in PostgreSQL
- PM name normalisation
- State legislation mapping
- Authentication for multiple adjusters
- Precompute model performance to fix load time