import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyDemoEvidence} from '../tools/verify-demo-evidence.mjs';
const read=name=>JSON.parse(readFileSync(new URL('../evidence/'+name,import.meta.url)));
function bundle(){return[read('kiln-demo-20260930.json'),read('demo-execution-20260930.json')];}
test('published demo evidence is internally consistent; no fresh chain/provider claim',()=>{
 const result=verifyDemoEvidence(...bundle());
 assert.equal(result.researchCalls,3);assert.equal(result.mainnetFills,3);assert.equal(result.devnetRecords,8);
 assert.equal(result.inputTokens,2655);assert.equal(result.outputTokens,2113);
 assert.match(result.scope,/not a fresh/);
});
const changes={
 'altered proposal':([k])=>k.runs[0].proposal.rebalance='weekly',
 'invented provider usage':([k])=>k.runs[0].model.inputTokens++,
 'wrong report linked to approval':([,e])=>e.policies[0].reportHash='0'.repeat(64),
 'changed receipt amount':([,e])=>e.trades[0].receipt.inputAtoms='999999',
 'fabricated token delivery':([,e])=>e.trades[0].mainnet.tokenBalances[1].postAtoms='999999',
 'devnet mislabeled as mainnet':([,e])=>e.trades[0].mainnet.cluster='devnet',
 'duplicate economic outcome':([,e])=>e.trades.push(structuredClone(e.trades[0])),
 'refusal silently approved':([k])=>k.runs[2].plans.push({id:'not-approved'}),
 'unfinalized devnet result':([,e])=>e.trades[0].result.finalized=false,
};
for(const [label,mutate] of Object.entries(changes))test('publication evidence rejects '+label,()=>{
 const b=bundle();mutate(b);assert.throws(()=>verifyDemoEvidence(...b));
});
