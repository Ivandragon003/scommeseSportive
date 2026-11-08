"""Six tree-block weights and exact raw-mixture 1X2 objective, without data access."""
from __future__ import annotations

import numpy as np
from scipy.optimize import minimize
from scipy.special import gammaln

BLOCKS = ((0, 40), (40, 80), (80, 120))
LOWER, UPPER = np.log(.05), np.log(8.)


def raw_probabilities(weights, blocks, biases, baseline, derivatives=False):
    weights = np.asarray(weights, dtype=float)
    blocks, biases, baseline = map(lambda x: np.asarray(x, dtype=float), (blocks, biases, baseline))
    if (weights.shape != (6,) or blocks.ndim != 3 or blocks.shape[1:] != (2, 3)
            or biases.shape != (2,) or baseline.shape != (len(blocks), 11, 11)
            or not all(np.all(np.isfinite(x)) for x in (weights, blocks, biases, baseline))
            or np.any(baseline < 0) or np.any(baseline.sum(axis=(1, 2)) <= 0)):
        raise ValueError('invalid_weight_objective_inputs')
    baseline = baseline / baseline.sum(axis=(1, 2), keepdims=True)
    raw = np.einsum('nsk,sk->ns', blocks, weights.reshape(2, 3)) + biases
    clamped = np.clip(raw, LOWER, UPPER)
    k = np.arange(11, dtype=float)
    # Normalizing each truncated marginal equals normalizing the original joint.
    logits = clamped[:, :, None] * k - gammaln(k + 1)
    logits -= logits.max(axis=2, keepdims=True)
    marginal = np.exp(logits)
    marginal /= marginal.sum(axis=2, keepdims=True)
    ml = marginal[:, 0, :, None] * marginal[:, 1, None, :]
    mixed = .25 * baseline + .75 * ml
    safe = np.maximum(1e-15, mixed)
    powered = safe ** (1 / .8)
    joint = powered / powered.sum(axis=(1, 2), keepdims=True)
    h, a = np.indices((11, 11))
    masks = np.array([h > a, h == a, h < a], dtype=float)
    probabilities = np.einsum('nha,cha->nc', joint, masks)
    if not derivatives:
        return probabilities
    expected = (marginal * k).sum(axis=2)
    pmf_derivative = marginal * (k - expected[:, :, None])
    # At either clamp boundary choose the inactive derivative, including ties.
    active = (raw > LOWER) & (raw < UPPER)
    dm = np.stack([pmf_derivative[:, 0, :, None] * marginal[:, 1, None, :],
                   marginal[:, 0, :, None] * pmf_derivative[:, 1, None, :]], axis=1)
    dm *= active[:, :, None, None]
    dlog = (1 / .8) * .75 * dm / safe[:, None, :, :]
    dlog *= (mixed > 1e-15)[:, None, :, :]
    centered = dlog - np.sum(joint[:, None, :, :] * dlog, axis=(2, 3), keepdims=True)
    dp = np.einsum('nsha,cha->nsc', joint[:, None, :, :] * centered, masks)
    return probabilities, dp


def metrics(probabilities, labels):
    probabilities, labels = np.asarray(probabilities), np.asarray(labels, dtype=int)
    if probabilities.shape != (len(labels), 3) or not len(labels) or np.any(labels < 0) or np.any(labels > 2):
        raise ValueError('invalid_metrics_inputs')
    return {'logLoss': float(-np.log(probabilities[np.arange(len(labels)), labels]).mean()),
            'brier': float(np.square(probabilities - np.eye(3)[labels]).sum(axis=1).mean()), 'n': len(labels)}


def objective_gradient(weights, blocks, biases, baseline, labels, ridge):
    labels = np.asarray(labels, dtype=int)
    if labels.shape != (len(blocks),) or not len(labels) or np.any(labels < 0) or np.any(labels > 2) or ridge < 0:
        raise ValueError('invalid_objective_labels_or_ridge')
    probabilities, dp = raw_probabilities(weights, blocks, biases, baseline, derivatives=True)
    actual = probabilities[np.arange(len(labels)), labels]
    side_derivative = -dp[np.arange(len(labels)), :, labels] / actual[:, None]
    gradient = np.einsum('ns,nsk->sk', side_derivative, blocks).reshape(6) / len(labels)
    delta = np.asarray(weights) - 1.
    loss = float(-np.log(actual).mean() + .5 * ridge * np.dot(delta, delta))
    return loss, gradient + ridge * delta


def fit_weights(blocks, biases, baseline, labels, ridge, optimizer):
    options = {key: optimizer[key] for key in ('maxiter', 'maxls', 'ftol', 'gtol')}
    result = minimize(objective_gradient, np.ones(6), args=(blocks, biases, baseline, labels, ridge),
                      method='L-BFGS-B', jac=True, bounds=[(0., 2.)] * 6, options=options)
    if not np.all(np.isfinite(result.x)) or np.any(result.x < 0) or np.any(result.x > 2):
        raise ValueError('invalid_optimizer_weights')
    return {'weights': result.x.tolist(), 'converged': bool(result.success),
            'optimizer': {'success': bool(result.success), 'status': int(result.status), 'message': str(result.message),
                          'iterations': int(result.nit), 'functionEvaluations': int(result.nfev),
                          'gradientEvaluations': int(result.njev), 'objective': float(result.fun),
                          'gradientInfinityNorm': float(np.max(np.abs(result.jac)))}}


def choose_fit(fits, identity):
    eligible_indices = []
    for index, fit in enumerate(fits):
        validation = fit['validationMetrics']
        eligible = (fit['converged'] and identity['logLoss'] - validation['logLoss'] > 1e-12
                    and validation['brier'] <= identity['brier'] + 1e-12)
        if eligible:
            eligible_indices.append(index)
    best = None
    if eligible_indices:
        minimum = min(fits[index]['validationMetrics']['logLoss'] for index in eligible_indices)
        tied = [index for index in eligible_indices if fits[index]['validationMetrics']['logLoss'] - minimum <= 1e-12]
        best = max(tied, key=lambda index: fits[index]['ridge'])
    return {'acceptedNonIdentity': best is not None, 'selectedFitIndex': best,
            'selectedRidge': None if best is None else fits[best]['ridge']}
