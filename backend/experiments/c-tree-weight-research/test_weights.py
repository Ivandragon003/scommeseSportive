import importlib.util
import unittest
from pathlib import Path

import numpy as np

SPEC = importlib.util.spec_from_file_location('weight_math', Path(__file__).with_name('weights.py'))
weights = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(weights)


def inputs():
    rng = np.random.default_rng(194)
    return rng.normal(.12, .17, (7, 2, 3)), np.array([.11, -.2]), rng.uniform(.001, 1, (7, 11, 11)), np.arange(7) % 3


class WeightMathTests(unittest.TestCase):
    def gradient_check(self, blocks, biases, baseline, labels, point):
        loss, analytic = weights.objective_gradient(point, blocks, biases, baseline, labels, .3)
        numerical = []
        for index in range(6):
            plus, minus = point.copy(), point.copy()
            plus[index] += 1e-6
            minus[index] -= 1e-6
            a = weights.objective_gradient(plus, blocks, biases, baseline, labels, .3)[0]
            b = weights.objective_gradient(minus, blocks, biases, baseline, labels, .3)[0]
            numerical.append((a - b) / 2e-6)
        self.assertTrue(np.isfinite(loss))
        np.testing.assert_allclose(analytic, numerical, atol=3e-9, rtol=1e-6)

    def test_gradient_nonidentity_interior(self):
        blocks, biases, baseline, labels = inputs()
        self.gradient_check(blocks, biases, baseline, labels, np.array([.6, 1.5, .8, 1.2, .7, 1.7]))

    def test_gradient_in_clamped_regions_and_mixture_floor(self):
        blocks, _, baseline, labels = inputs()
        biases = np.array([-8., 7.])
        baseline[:] = 0
        baseline[:, 0, 0] = 1
        point = np.array([.6, 1.5, .8, 1.2, .7, 1.7])
        self.gradient_check(blocks, biases, baseline, labels, point)
        _, dp = weights.raw_probabilities(point, blocks, biases, baseline, derivatives=True)
        np.testing.assert_array_equal(dp, np.zeros_like(dp))

    def test_gradient_with_active_small_intensities_and_floored_tail_cells(self):
        blocks, _, baseline, labels = inputs()
        blocks *= .05
        baseline[:] = 0
        baseline[:, 0, 0] = 1
        self.gradient_check(blocks, np.array([-2.5, -2.6]), baseline, labels,
                            np.array([.6, 1.5, .8, 1.2, .7, 1.7]))

    def test_identity_matches_independent_poisson_mixer(self):
        blocks, biases, baseline, _ = inputs()
        actual = weights.raw_probabilities(np.ones(6), blocks, biases, baseline)
        expected = []
        import math
        for contributions, base in zip(blocks, baseline):
            raw = contributions.sum(axis=1) + biases
            lams = np.clip(np.exp(raw), .05, 8)
            pmf = [[math.exp(-lam) * lam ** k / math.factorial(k) for k in range(11)] for lam in lams]
            joint = np.outer(*pmf)
            joint /= joint.sum()
            mixed = (.25 * base / base.sum() + .75 * joint)
            powered = np.maximum(1e-15, mixed) ** 1.25
            powered /= powered.sum()
            expected.append([np.tril(powered, -1).sum(), powered.trace(), np.triu(powered, 1).sum()])
        np.testing.assert_allclose(actual, expected, atol=1e-15, rtol=0)

    def test_selection_eligibility_and_higher_ridge_tie(self):
        identity = {'logLoss': 1., 'brier': .6}
        def fit(ridge, ll, brier=.59, converged=True):
            return {'ridge': ridge, 'converged': converged, 'validationMetrics': {'logLoss': ll, 'brier': brier}}
        fits = [fit(.1, .9), fit(10., .9 + 5e-13), fit(1., .8, .61), fit(.01, .7, converged=False)]
        self.assertEqual(weights.choose_fit(fits, identity)['selectedFitIndex'], 1)
        self.assertFalse(weights.choose_fit([fit(10., 1. - 5e-13)], identity)['acceptedNonIdentity'])
        chain = [fit(10., .9 + 1.5e-12), fit(1., .9 + .9e-12), fit(.1, .9)]
        self.assertEqual(weights.choose_fit(chain, identity)['selectedFitIndex'], 1)

    def test_bound_optimizer_deterministic_and_records_success(self):
        blocks, biases, baseline, labels = inputs()
        options = {'maxiter': 500, 'maxls': 30, 'ftol': 1e-12, 'gtol': 1e-9}
        a = weights.fit_weights(blocks, biases, baseline, labels, 10., options)
        b = weights.fit_weights(blocks, biases, baseline, labels, 10., options)
        self.assertEqual(a, b)
        self.assertTrue(a['converged'])
        self.assertTrue(all(0 <= value <= 2 for value in a['weights']))


if __name__ == '__main__':
    unittest.main()
