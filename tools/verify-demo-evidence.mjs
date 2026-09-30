// Offline integrity/linkage checks only. No network, provider, signer or DB writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {hash as researchHash} from '../lib/research-agent-core.mjs';
import {hash,canonical,MAINNET} from '../lib/research-autonomy-policy.mjs';

export function verifyDemoEvidence(kiln,execution){
 assert.equal(kiln.schema,'sta.kiln-demo-observation/v1');
 assert.equal(execution.schema,'sta.demo-execution-observation/v1');
 assert.equal(kiln.apiOrigin,'https://api.bricksum.com/v1');
 assert.equal(kiln.inferenceCalls,kiln.runs.length);
 const unique=(xs)=>assert.equal(new Set(xs).size,xs.length,'duplicate evidence identity');
 unique(kiln.runs.map(r=>r.runId));unique(execution.policies.map(p=>p.id));
 unique(execution.trades.map(t=>t.orderId));unique(execution.trades.map(t=>t.mainnet.signature));
 const totals={inputTokens:0,outputTokens:0};
 for(const run of kiln.runs){
  assert.equal(run.model.provider,kiln.provider);assert.equal(run.model.model,kiln.model);
  assert.equal(researchHash(run.proposal),run.model.responseHash,'proposal hash');
  for(const field of Object.keys(totals)){
   assert.ok(Number.isSafeInteger(run.model[field])&&run.model[field]>=0);totals[field]+=run.model[field];
  }
  assert.match(run.model.promptHash,/^[0-9a-f]{64}$/);assert.match(run.reportHash,/^[0-9a-f]{64}$/);
  if(run.decision==='DECLINED'){
   assert.equal(run.plans.length,0);assert.equal(run.noApprovedPlan,true);
   assert.ok(!execution.trades.some(t=>t.runId===run.runId));
   assert.ok(run.candidates.every(c=>c.verdict==='DECLINED'));
  }
 }
 assert.deepEqual(totals,kiln.totals,'provider usage total');
 const devnetSignatures=[];
 function devnet(record,operation){
  assert.equal(record.cluster,'devnet');assert.equal(record.operation,operation);
  assert.equal(record.finalized,true);assert.equal(record.err,null);
  assert.equal(record.exactInstructionMatched,true);
  assert.equal(record.explorer,`https://explorer.solana.com/tx/${record.signature}?cluster=devnet`);
  devnetSignatures.push(record.signature);
 }
 for(const policy of execution.policies){
  const run=kiln.runs.find(r=>r.plans.some(p=>p.id===policy.planId));assert.ok(run,'policy run');
  const plan=run.plans.find(p=>p.id===policy.planId);
  assert.equal(policy.reportHash,run.reportHash);assert.equal(plan.policyId,policy.id);
  assert.equal(plan.approvalHash,policy.approvalHash);
  assert.equal(plan.filledLegsObserved,execution.trades.filter(t=>t.policyId===policy.id).length);
  devnet(policy.approval,'APPROVE');
 }
 for(const trade of execution.trades){
  const policy=execution.policies.find(p=>p.id===trade.policyId);assert.ok(policy);
  const run=kiln.runs.find(r=>r.runId===trade.runId);assert.ok(run);
  assert.equal(policy.planId,trade.planId);assert.equal(policy.reportHash,run.reportHash);
  assert.equal(trade.mainnet.cluster,'mainnet-beta');assert.equal(trade.mainnet.finalized,true);assert.equal(trade.mainnet.err,null);
  assert.equal(trade.receipt.genesisHash,MAINNET);assert.equal(trade.receipt.phase,'RECONCILED');
  assert.equal(trade.receipt.signature,trade.mainnet.signature);
  assert.equal(trade.mainnet.explorer,`https://solscan.io/tx/${trade.mainnet.signature}`);
  assert.equal(hash(canonical(trade.receipt)),trade.receiptHash,'receipt hash');
  assert.equal(trade.engineReconciled.signature,trade.mainnet.signature);assert.equal(trade.engineReconciled.phase,'RECONCILED');
  const source=trade.mainnet.tokenBalances.find(b=>b.role==='source'),destination=trade.mainnet.tokenBalances.find(b=>b.role==='destination');
  assert.equal(source.mint,trade.receipt.sourceMint);assert.equal(destination.mint,trade.receipt.destinationMint);
  assert.equal(BigInt(source.preAtoms)-BigInt(source.postAtoms),BigInt(trade.receipt.inputAtoms),'debit');
  assert.equal(BigInt(destination.postAtoms)-BigInt(destination.preAtoms),BigInt(trade.receipt.outputAtoms),'delivery');
  devnet(trade.reservation,'RESERVE');devnet(trade.result,'SETTLE');
 }
 unique(devnetSignatures);
 const refusal=kiln.runs.find(r=>r.runId===execution.refusal.runId);assert.ok(refusal);
 assert.equal(refusal.decision,'DECLINED');assert.equal(refusal.reportHash,execution.refusal.reportHash);
 return{schema:'sta.demo-evidence-integrity/v1',scope:'Offline hashes and references, not a fresh provider or chain observation',
  researchCalls:kiln.runs.length,mainnetFills:execution.trades.length,devnetRecords:devnetSignatures.length,...totals};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const read=name=>JSON.parse(readFileSync(new URL('../evidence/'+name,import.meta.url)));
 console.log(JSON.stringify(verifyDemoEvidence(read('kiln-demo-20260930.json'),read('demo-execution-20260930.json')),null,2));
}
