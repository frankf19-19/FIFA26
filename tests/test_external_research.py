import importlib.util
from pathlib import Path
import sys
import unittest
import ast
import collections
import datetime
import math

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from temporal_selection import choose_on_training
spec=importlib.util.spec_from_file_location('benchmark',Path(__file__).resolve().parents[1]/'scripts'/'external-score-benchmark.py')
bench=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class TemporalTests(unittest.TestCase):
    def test_holdout_labels_cannot_select_rules(self):
        rows = [(1, 'A'), (2, 'A'), (3, 'B'), (4, 'B')]
        score = lambda c, past: [int(c == r[1]) for r in past]
        self.assertEqual(choose_on_training(['A', 'B'], rows, 2, score), 'A')
        changed = [(1, 'A'), (2, 'A'), (3, 'A'), (4, 'A')]
        self.assertEqual(choose_on_training(['A', 'B'], changed, 2, score), 'A')
        with self.assertRaises(ValueError):
            choose_on_training(['A'], [], 2, score)

    def test_same_day_and_previous_day_outcomes_do_not_enter_forecast(self):
        make = lambda d, score: dict(day=d,league='test',home='H',away='A',hs=score,as_=0)
        original = list(bench.forecasts([make(100, 0), make(101, 0), make(102, 0)], 120, 5))
        altered = list(bench.forecasts([make(100, 7), make(101, 7), make(102, 7)], 120, 5))
        self.assertEqual(original[0][1:], altered[0][1:])
        self.assertEqual(original[1][1:], altered[1][1:])
        self.assertNotEqual(original[2][1:], altered[2][1:])

    def test_dc_distribution_is_normalized(self):
        for h,a,r in [(1.5,1.1,0),(3,2,-.1),(.15,.15,-.05)]:
            dist=bench.distribution(h,a,r)
            self.assertAlmostEqual(sum(p for p,_,_ in dist),1)
            self.assertTrue(all(p>=0 for p,_,_ in dist))

    def test_real_autotuner_feature_builder_delays_results_and_player_updates(self):
        source=Path('scripts/autotune.py').read_text(encoding='utf-8')
        tree=ast.parse(source)
        fn=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='build')
        data=[];details={}
        for i in range(54):
            day=(datetime.date(2024,1,1)+datetime.timedelta(days=i)).isoformat()
            data.append((str(i),dict(d=day,lg='test',hid='H',aid='A',hs=1,as_=0)))
            # Production keys use 'as', which cannot be a keyword argument.
            data[-1][1]['as']=data[-1][1].pop('as_')
            players=[[[str(side*20+j),1,0,90,0,0,0,0,0] for j in range(11)] for side in range(2)]
            details[str(i)]={'ts':[[0]*8+[3],[0]*8+[1]],'pl':players}
        env=dict(collections=collections,math=math,datetime=datetime,dt=datetime.date.fromisoformat,
                 R=data,det=details,PRIOR=.12,K=6,G=7,A=8,SOT=8,SC=.321)
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'autotune-builder','exec'),env)
        original=env['build'](120)
        data[52][1]['hs']=7
        changed=env['build'](120)
        # Day 53 cannot use day 52. Compare numeric feature tuples, not result labels.
        self.assertEqual(original[-1][1:],changed[-1][1:])
        data[51][1]['hs']=7
        older=env['build'](120)
        self.assertNotEqual(original[-1][1:5],older[-1][1:5])


if __name__ == '__main__':
    unittest.main()
