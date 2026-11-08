"""Single-start, regularized minimax training risks; no global-optimum claim."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import numpy as np
from scipy.optimize import minimize

WEIGHT_MATH_PATH = Path(__file__).resolve().parents[1] / 'c-tree-weight-research/weights.py'
SPEC = importlib.util.spec_from_file_location('frozen_minimax_probability_math', WEIGHT_MATH_PATH)
probability_math = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probability_math)


class TrainingRisks:
    def __init__(self, blocks, biases, baseline, labels, leagues):
        self.blocks, self.biases, self.baseline = blocks, biases, baseline
        self.labels = np.asarray(labels, dtype=int)
        self.leagues = np.asarray(leagues)
        names = sorted(set(leagues))
        if len(names) != 5 or len(self.labels) != len(blocks) or len(leagues) != len(blocks):
            raise ValueError('five_training_leagues_and_matching_rows_required')
        self.groups = [(league, metric, np.flatnonzero(self.leagues == league)) for league in names for metric in ('logLoss', 'brier')]
        self.last_weights, self.last_value = None, None
        self.identity, _ = self.evaluate(np.ones(6))
        if not np.all(np.isfinite(self.identity)) or np.any(self.identity <= 0):
            raise ValueError('positive_finite_identity_group_risks_required')

    def evaluate(self, weights):
        weights = np.asarray(weights, dtype=float)
        if self.last_weights is not None and np.array_equal(weights, self.last_weights):
            return self.last_value
        p, dp_side = probability_math.raw_probabilities(weights, self.blocks, self.biases, self.baseline, derivatives=True)
        dp = np.einsum('nsc,nsk->ncsk', dp_side, self.blocks).reshape(len(p), 3, 6)
        y = np.eye(3)[self.labels]
        actual = p[np.arange(len(p)), self.labels]
        row_losses = {'logLoss': -np.log(actual), 'brier': np.square(p - y).sum(axis=1)}
        row_gradients = {'logLoss': -dp[np.arange(len(p)), self.labels] / actual[:, None],
                         'brier': 2 * np.einsum('nc,nck->nk', p - y, dp)}
        values = np.array([row_losses[metric][indices].mean() for _, metric, indices in self.groups])
        jacobian = np.array([row_gradients[metric][indices].mean(axis=0) for _, metric, indices in self.groups])
        self.last_weights, self.last_value = weights.copy(), (values, jacobian)
        return values, jacobian

    def relative(self, weights):
        value, jacobian = self.evaluate(weights)
        return value / self.identity - 1., jacobian / self.identity[:, None]

    def constraints(self, point):
        relative, _ = self.relative(point[:6])
        return point[6] - relative

    def constraint_jacobian(self, point):
        _, jacobian = self.relative(point[:6])
        return np.column_stack((-jacobian, np.ones(10)))

    def records(self, weights):
        values, _ = self.evaluate(weights)
        return [{'league': league, 'metric': metric, 'identity': float(base), 'value': float(value),
                 'relativeRegret': float(value / base - 1.)}
                for (league, metric, _), base, value in zip(self.groups, self.identity, values)]


def objective(point, ridge):
    delta = point[:6] - 1.
    return float(point[6] + .5 * ridge * np.dot(delta, delta))


def objective_jacobian(point, ridge):
    return np.r_[ridge * (point[:6] - 1.), 1.]


def finite_number(value):
    return float(value) if value is not None and np.isfinite(value) else None


def solution_receipt(result, risks, ridge, checks):
    point = np.asarray(result.x, dtype=float)
    reported_gradient = np.asarray(result.jac, dtype=float)
    failures = []
    finite = (point.shape == (7,) and np.all(np.isfinite(point)) and np.isfinite(result.fun)
              and reported_gradient.shape == (7,) and np.all(np.isfinite(reported_gradient)))
    if not result.success:
        failures.append('solver_did_not_converge')
    if not finite:
        failures.append('nonfinite_or_malformed_solution')
    receipt = {'ridge': ridge, 'weights': [finite_number(value) for value in point[:6]],
               'epigraph': finite_number(point[6]) if len(point) > 6 else None,
               'optimizer': {'success': bool(result.success), 'status': int(result.status), 'message': str(result.message),
                             'iterations': int(result.nit), 'functionEvaluations': int(result.nfev),
                             'gradientEvaluations': int(result.njev), 'reportedObjective': finite_number(result.fun),
                             'pointShape': list(point.shape), 'reportedGradientShape': list(reported_gradient.shape),
                             'reportedGradient': [finite_number(value) for value in reported_gradient.reshape(-1)]},
               'objective': None, 'worstRelativeRegret': None, 'maximumConstraintViolation': None,
               'trainingRisks': None}
    if finite:
        values, jacobian = risks.evaluate(point[:6])
        relative, _ = risks.relative(point[:6])
        finite = np.all(np.isfinite(values)) and np.all(np.isfinite(jacobian)) and np.all(np.isfinite(relative))
        if not finite:
            failures.append('nonfinite_recomputed_risks')
        else:
            tolerance = checks['boundsTolerance']
            if (np.any(point[:6] < -tolerance) or np.any(point[:6] > 2 + tolerance)
                    or point[6] < -1 - tolerance or point[6] > 1 + tolerance):
                failures.append('bounds_violation')
            value, worst = objective(point, ridge), float(np.max(relative))
            violation = float(max(0., np.max(relative - point[6])))
            if violation > checks['maximumConstraintViolation']:
                failures.append('constraint_violation')
            if not value < checks['maximumObjectiveToAdmit']:
                failures.append('penalized_objective_not_strictly_improved')
            if not worst < checks['maximumWorstRelativeRegretToAdmit']:
                failures.append('worst_relative_regret_not_strictly_improved')
            if not point[6] < checks['maximumEpigraphToAdmit']:
                failures.append('epigraph_not_strictly_improved')
            receipt.update({'objective': value, 'worstRelativeRegret': worst, 'maximumConstraintViolation': violation,
                            'trainingRisks': risks.records(point[:6])})
    receipt.update({'admissible': not failures, 'failureReasons': failures})
    return receipt


def fit(risks, ridge, optimizer, checks):
    # Exactly one solver invocation, one identity start and the frozen bounds.
    try:
        result = minimize(objective, np.r_[np.ones(6), 0.], args=(ridge,), method='SLSQP', jac=objective_jacobian,
                          bounds=[(0., 2.)] * 6 + [(-1., 1.)],
                          constraints=[{'type': 'ineq', 'fun': risks.constraints, 'jac': risks.constraint_jacobian}],
                          options={'maxiter': optimizer['maxiter'], 'ftol': optimizer['ftol'], 'disp': optimizer['display']})
    except (ValueError, RuntimeError, FloatingPointError) as error:
        return {'ridge': ridge, 'weights': None, 'epigraph': None, 'admissible': False,
                'failureReasons': ['solver_exception'], 'optimizer': {'success': False, 'message': str(error)},
                'objective': None, 'worstRelativeRegret': None, 'maximumConstraintViolation': None, 'trainingRisks': None}
    return solution_receipt(result, risks, ridge, checks)
