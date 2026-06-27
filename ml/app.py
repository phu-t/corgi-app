from flask import Flask, request, jsonify
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
import psycopg2
import warnings
warnings.filterwarnings('ignore')

app = Flask(__name__)

def clean_money(val):
    if val is None:
        return None
    try:
        return float(str(val).replace('$', '').replace(',', '').strip())
    except ValueError:
        return None

def load_and_train():
    conn = psycopg2.connect(
        host='localhost',
        port=5432,
        database='corgi_claims',
        user='phu',
        password=''
    )
    
    df = pd.read_sql('SELECT * FROM claims', conn)
    conn.close()

    for col in ['monthly_rent', 'max_benefit', 'approved_benefit_amount', 'amount_of_claim']:
        df[col] = df[col].apply(clean_money)

    df['lease_start_date'] = pd.to_datetime(df['lease_start_date'], errors='coerce')
    df['lease_end_date'] = pd.to_datetime(df['lease_end_date'], errors='coerce')
    df['move_out_date'] = pd.to_datetime(df['move_out_date'], errors='coerce')
    df['lease_duration_days'] = (df['lease_end_date'] - df['lease_start_date']).dt.days
    df['early_exit_days'] = (df['lease_end_date'] - df['move_out_date']).dt.days

    le_term = LabelEncoder()
    le_state = LabelEncoder()
    le_pm = LabelEncoder()
    le_relationship = LabelEncoder()

    df['term_type_enc'] = le_term.fit_transform(df['termination_type'].fillna('Unknown'))
    df['state_enc'] = le_state.fit_transform(df['lease_state'].fillna('Unknown'))
    df['pm_enc'] = le_pm.fit_transform(df['property_management_company'].fillna('Unknown'))
    df['relationship_2nd_enc'] = le_relationship.fit_transform(df['relationship_2nd'].fillna('Unknown'))

    # How many claims this PM has filed historically — known regardless of
    # this claim's outcome, unlike collection_status/settlement/collected_amount
    # which only exist after a claim is already resolved (checked: 0% filled
    # in on any currently-active claim) and would be leakage if used here.
    pm_claim_counts = df['property_management_company'].fillna('Unknown').value_counts().to_dict()
    df['pm_claim_count'] = df['property_management_company'].fillna('Unknown').map(pm_claim_counts)

    features = ['monthly_rent', 'max_benefit', 'amount_of_claim', 'term_type_enc',
                'state_enc', 'pm_enc', 'lease_duration_days', 'early_exit_days',
                'relationship_2nd_enc', 'pm_claim_count']

    df_clean = df.dropna(subset=features + ['approved_benefit_amount'])
    df_clean = df_clean[df_clean['approved_benefit_amount'] > 0]

    X = df_clean[features]
    y = df_clean['approved_benefit_amount']
    max_benefit = df_clean['max_benefit']

    X_train, X_test, y_train, y_test, mb_train, mb_test = train_test_split(
        X, y, max_benefit, test_size=0.2, random_state=42
    )

    def capped_mae_mape(fitted_model, X_split, y_split, max_benefit_split):
        raw_pred = fitted_model.predict(X_split)
        capped_pred = np.minimum(raw_pred, max_benefit_split.values)
        abs_err = np.abs(capped_pred - y_split.values)
        mae = float(abs_err.mean())
        nonzero = y_split.values != 0
        mape = float((abs_err[nonzero] / y_split.values[nonzero]).mean() * 100) if nonzero.any() else 0.0
        return round(mae, 2), round(mape, 2)

    eval_model = RandomForestRegressor(n_estimators=200, random_state=42)
    eval_model.fit(X_train, y_train)

    train_mae, train_mape = capped_mae_mape(eval_model, X_train, y_train, mb_train)
    test_mae, test_mape = capped_mae_mape(eval_model, X_test, y_test, mb_test)

    model_metrics = {
        'train_count': len(X_train),
        'test_count': len(X_test),
        'train_mae': train_mae,
        'train_mape': train_mape,
        'test_mae': test_mae,
        'test_mape': test_mape,
    }
    print(f"Held-out test: MAE=${test_mae:.2f} MAPE={test_mape:.1f}% "
          f"(train: MAE=${train_mae:.2f} MAPE={train_mape:.1f}%)")

    # Production model serves /predict — fit on the full dataset so live
    # predictions aren't starved of the 20% held out for evaluation above.
    model = RandomForestRegressor(n_estimators=200, random_state=42)
    model.fit(X, y)

    return model, le_term, le_state, le_pm, le_relationship, pm_claim_counts, model_metrics

print('Training model...')
model, le_term, le_state, le_pm, le_relationship, pm_claim_counts, model_metrics = load_and_train()
print('Model ready')

@app.route('/predict', methods=['POST'])
def predict():
    data = request.json

    try:
        def encode_safe(le, val):
            val = val or 'Unknown'
            if val not in le.classes_:
                val = 'Unknown'
            return le.transform([val])[0]

        pm_name = data.get('property_management_company') or 'Unknown'

        features = [[
            clean_money(data.get('monthly_rent')) or 0,
            clean_money(data.get('max_benefit')) or 0,
            clean_money(data.get('amount_of_claim')) or 0,
            encode_safe(le_term, data.get('termination_type')),
            encode_safe(le_state, data.get('lease_state')),
            encode_safe(le_pm, pm_name),
            data.get('lease_duration_days') or 0,
            data.get('early_exit_days') or 0,
            encode_safe(le_relationship, data.get('relationship_2nd')),
            pm_claim_counts.get(pm_name, 0),
        ]]

        prediction = model.predict(features)[0]
        max_benefit = clean_money(data.get('max_benefit')) or 0
        capped = min(prediction, max_benefit)

        return jsonify({
            'predicted_payout': round(capped, 2),
            'confidence': 'high' if abs(prediction - capped) < 100 else 'review'
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/model-info', methods=['GET'])
def model_info():
    return jsonify(model_metrics)

if __name__ == '__main__':
    app.run(port=5001)