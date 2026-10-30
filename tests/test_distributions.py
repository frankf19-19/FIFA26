import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('distributions',Path('scripts/distribution-benchmark.py'))
model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)


class DistributionTests(unittest.TestCase):
    def test_families_are_finite_normalized_and_deterministic(self):
        for family in model.FAMILIES:
            p=model.cells(1.7,1.1,family)
            self.assertAlmostEqual(float(p.sum()),1)
            self.assertTrue(np.all(p>=0))
            self.assertTrue(np.array_equal(p,model.cells(1.7,1.1,family)))

    def test_negative_binomial_marginal_preserves_mean_and_adds_variance(self):
        p=model.marginal(1.2,.1);k=np.arange(16)
        self.assertAlmostEqual(float(k@p),1.2,places=5)
        self.assertGreater(float(((k-1.2)**2)@p),1.2)

    def test_fit_uses_opponents_and_refuses_unavailable_outcomes(self):
        rows=[dict(day=d,home='H',away='A',hs=2,as_=1) for d in range(100,160)]
        fit=model.fit(rows,162,10)
        h,a=model.predict(fit,'H','A')
        self.assertGreater(h,a);self.assertEqual(fit['trainN'],60)
        self.assertTrue(all(np.isfinite(model.predict(fit,'Unseen','A'))))
        with self.assertRaises(ValueError):model.fit(rows,160,10)

    def test_loader_accepts_unplayed_and_alternate_score_schema(self):
        self.assertEqual(model.base.final_score({'score':{'ft':[1,0]}}),[1,0])
        self.assertEqual(model.base.final_score({'score':[1,0]}),[1,0])
        self.assertIsNone(model.base.final_score({'score':[]}))
        self.assertIsNone(model.base.final_score({'score':None}))


if __name__=='__main__':unittest.main()
