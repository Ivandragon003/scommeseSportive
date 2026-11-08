import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np

SPEC = importlib.util.spec_from_file_location('minimax_math_tested', Path(__file__).with_name('minimax.py'))
minimax = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(minimax)
CHECKS = {'boundsTolerance': 1e-12, 'maximumConstraintViolation': 1e-8,
          'maximumObjectiveToAdmit': -1e-10, 'maximumWorstRelativeRegretToAdmit': -1e-8, 'maximumEpigraphToAdmit': -1e-8}


def risk_model(clamped=False):
    rng = np.random.default_rng(157)
    blocks = rng.normal(.1, .08, (15, 2, 3))
    biases = np.array([-7., .3]) if clamped else np.array([.1, -.2])
    return minimax.TrainingRisks(blocks, biases, rng.uniform(.001, 1, (15, 11, 11)), np.arange(15) % 3,
                                 [f'league{i // 3}' for i in range(15)])


class FakeRisks:
    def __init__(self, relative=-.01):
        self.regret = relative
    def evaluate(self, weights):
        return np.ones(10) * (1 + self.regret), np.zeros((10, 6))
    def relative(self, weights):
        return np.ones(10) * self.regret, np.zeros((10, 6))
    def records(self, weights):
        return [{'relativeRegret': self.regret}] * 10


def result(point=None, success=True):
    point = np.r_[np.ones(6), -.01] if point is None else np.asarray(point)
    return SimpleNamespace(x=point, success=success, fun=minimax.objective(point, 10.),
                           jac=minimax.objective_jacobian(point, 10.), status=0, message='synthetic', nit=1, nfev=1, njev=1)


class MinimaxTests(unittest.TestCase):
    def test_all_ten_ll_brier_gradients_and_constraint_jacobian_finite_differences(self):
        for clamped in (False, True):
            model = risk_model(clamped)
            point = np.array([.7, 1.2, 1.6, .8, 1.4, .6, -.03])
            _, analytic = model.evaluate(point[:6])
            numerical = np.zeros((10, 6))
            for index in range(6):
                plus, minus = point[:6].copy(), point[:6].copy()
                plus[index] += 1e-6
                minus[index] -= 1e-6
                # Independent metric values use predictions without any analytic derivative.
                def independent(w):
                    p = minimax.probability_math.raw_probabilities(w, model.blocks, model.biases, model.baseline)
                    return np.array([minimax.probability_math.metrics(p[indices], model.labels[indices])[metric]
                                     for _, metric, indices in model.groups])
                numerical[:, index] = (independent(plus) - independent(minus)) / 2e-6
            np.testing.assert_allclose(analytic, numerical, atol=2e-9, rtol=1e-6)
            constraint_jac = model.constraint_jacobian(point)
            for index in range(7):
                plus, minus = point.copy(), point.copy()
                plus[index] += 1e-6
                minus[index] -= 1e-6
                numerical_column = (model.constraints(plus) - model.constraints(minus)) / 2e-6
                np.testing.assert_allclose(constraint_jac[:, index], numerical_column, atol=3e-9, rtol=1e-6)

    def test_identity_is_feasible_and_group_order_is_fixed(self):
        model = risk_model()
        np.testing.assert_array_equal(model.constraints(np.r_[np.ones(6), 0.]), np.zeros(10))
        self.assertEqual([(league, metric) for league, metric, _ in model.groups],
                         [(f'league{i}', metric) for i in range(5) for metric in ('logLoss', 'brier')])

    def test_objective_analytic_gradient(self):
        point = np.array([.7, 1.2, 1.6, .8, 1.4, .6, -.03])
        analytic = minimax.objective_jacobian(point, .1)
        for index in range(7):
            plus, minus = point.copy(), point.copy()
            plus[index] += 1e-6
            minus[index] -= 1e-6
            self.assertAlmostEqual(analytic[index], (minimax.objective(plus, .1) - minimax.objective(minus, .1)) / 2e-6, places=9)

    def test_recomputed_solution_gates_are_strict_and_do_not_clip(self):
        receipt = minimax.solution_receipt(result(), FakeRisks(), 10., CHECKS)
        self.assertTrue(receipt['admissible'])
        cases = [(result(success=False), FakeRisks(), 'solver_did_not_converge'),
                 (result(np.r_[np.ones(6), -.1]), FakeRisks(), 'constraint_violation'),
                 (result(np.r_[np.ones(6), -1e-10]), FakeRisks(), 'penalized_objective_not_strictly_improved'),
                 (result(np.r_[np.ones(6), -1e-8]), FakeRisks(), 'epigraph_not_strictly_improved'),
                 (result(), FakeRisks(-1e-8), 'worst_relative_regret_not_strictly_improved')]
        for solver, risks, reason in cases:
            with self.subTest(reason=reason):
                checked = minimax.solution_receipt(solver, risks, 10., CHECKS)
                self.assertFalse(checked['admissible'])
                self.assertIn(reason, checked['failureReasons'])
        point = np.r_[2. + 2e-12, np.ones(5), -.01]
        checked = minimax.solution_receipt(result(point), FakeRisks(), 10., CHECKS)
        self.assertIn('bounds_violation', checked['failureReasons'])
        self.assertEqual(checked['weights'][0], point[0])

    def test_nonfinite_solution_is_recorded_without_nonfinite_json_numbers(self):
        solver = result()
        solver.x[0] = np.nan
        checked = minimax.solution_receipt(solver, FakeRisks(), 10., CHECKS)
        self.assertFalse(checked['admissible'])
        self.assertIsNone(checked['weights'][0])
        import json
        json.dumps(checked, allow_nan=False)

    def test_one_solver_start_with_exact_bounds_no_retry(self):
        model = risk_model()
        with patch.object(minimax, 'minimize', return_value=result()) as solve:
            minimax.fit(model, 10., {'maxiter': 500, 'ftol': 1e-12, 'display': False}, CHECKS)
        self.assertEqual(solve.call_count, 1)
        args, kwargs = solve.call_args
        np.testing.assert_array_equal(args[1], np.r_[np.ones(6), 0.])
        self.assertEqual(kwargs['bounds'], [(0., 2.)] * 6 + [(-1., 1.)])
        self.assertEqual(kwargs['method'], 'SLSQP')


if __name__ == '__main__':
    unittest.main()
