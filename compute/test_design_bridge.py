"""Bridge contract tests. Real history is optional; no model/chain requests."""
import copy
import os
import unittest
from design_bridge import prompt, evaluate_designs

REQUEST = {
    'strategy': {'objective': 'Study semiconductors without promising returns.',
                 'instruments': ['NVDA','AMD','AVGO','ASML','TSM','MU','INTC','MRVL']},
    'goal': {'horizonDays':365, 'targetReturnBps':500, 'maxDrawdownBps':4500,
             'maxWeightBps':2500, 'minCashBps':1000, 'costBps':50},
    'proposal': {'designs': {'candidates': [{
        'name':'Measured trend', 'idea':'Follow established trends while retaining cash when markets weaken.',
        'design': {'score':[{'signal':'momentum','lookback':126,'skip':21,'weight':1}],
                   'filters':[], 'top_n':None, 'weighting':'equal', 'risk_off':None}}]}}
}

class BridgeTest(unittest.TestCase):
    def test_original_prompt_and_no_prices(self):
        messages=prompt(REQUEST)
        self.assertEqual([m['role'] for m in messages], ['system','user'])
        self.assertIn('ASML',messages[1]['content'])
        self.assertIn('never code',messages[0]['content'])

    def test_no_executable_model_code(self):
        body=copy.deepcopy(REQUEST)
        body['proposal']['designs']['candidates'][0]['design']={'python':'import os'}
        with self.assertRaisesRegex(ValueError, 'no usable candidate'):
            evaluate_designs(body,'/nonexistent')

    @unittest.skipUnless(os.environ.get('XTXC_TEST_PRICE_ROOT'), 'requires existing verified history')
    def test_real_history_through_original_pr07_executor(self):
        report=evaluate_designs(REQUEST,os.environ['XTXC_TEST_PRICE_ROOT'])
        self.assertEqual(report['engineVersion'],'sta-pr07-dsl-bridge/1')
        self.assertIn('ASML',report['dataset']['coverage'])
        candidate=report['candidates'][0]
        self.assertTrue(candidate['leakage']['passed'])
        self.assertTrue(candidate['curve'])
        self.assertLessEqual(sum(w['weightBps'] for w in candidate['weights']),9000)
        self.assertTrue(all(w['weightBps']<=2500 for w in candidate['weights']))
        self.assertGreaterEqual(candidate['windowCount'],3)

if __name__=='__main__':unittest.main()
