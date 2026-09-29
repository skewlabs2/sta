import { createHash, randomUUID } from 'node:crypto';
import { ResearchStore, ResearchStoreError } from './research-store.mjs';

export const AGENT_VERSION = 'xtxc-research-agent/1';
export const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
export const hash = x => createHash('sha256').update(canonical(x)).digest('hex');
export const reject = (message, status=422) => { throw new ResearchStoreError(message,status); };
const integer = (v,min,max,name) => Number.isSafeInteger(v)&&v>=min&&v<=max?v:reject(`Check ${name}.`);
export function validateGoal(v) {
  if(!v||typeof v!=='object')reject('Set a return target, time horizon and loss limit.');
  return {
    targetReturnBps:integer(v.targetReturnBps,0,1000000,'target return'),
    horizonDays:integer(v.horizonDays,7,365,'time horizon'),
    maxDrawdownBps:integer(v.maxDrawdownBps,100,8000,'maximum drawdown'),
    maxWeightBps:integer(v.maxWeightBps,100,10000,'position limit'),
    minCashBps:integer(v.minCashBps,0,9500,'cash reserve'),
    costBps:integer(v.costBps,1,500,'assumed one-way trading cost'),
  };
}
export const briefHash = s => hash({name:s.name,objective:s.objective,budget:s.budget,instruments:s.instruments,weights:s.weights,cashBps:s.cashBps});
export function budgetAtoms(value) {
  if(typeof value!=='string'||!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(value)||Number(value)<=0)reject('Check the USDC budget.');
  const [a,b='']=value.split('.'); return (BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'))).toString();
}
export function allocateBudget(total, weights) {
  let sum=0; const rows=weights.map(w=>{sum+=integer(w.weightBps,0,10000,'allocation');return{instrument:w.instrument,inputAtoms:(BigInt(total)*BigInt(w.weightBps)/10000n).toString()};});
  if(sum>10000||new Set(rows.map(r=>r.instrument)).size!==rows.length)reject('Invalid strategy allocation.');
  // Rounding remains cash, never an extra debit; economic amounts stay integers.
  return {legs:rows.filter(r=>BigInt(r.inputAtoms)>0n),cashAtoms:(BigInt(total)-rows.reduce((n,r)=>n+BigInt(r.inputAtoms),0n)).toString()};
}

export class AgentStore extends ResearchStore {
  constructor(path,allowed) {
    super(path,allowed);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,strategy TEXT NOT NULL,brief_hash TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner,request_id));
      CREATE INDEX IF NOT EXISTS agent_queue ON agent_runs(status,created_at);
      CREATE INDEX IF NOT EXISTS agent_owner ON agent_runs(owner,strategy,created_at);
      CREATE TABLE IF NOT EXISTS agent_plans(id TEXT PRIMARY KEY,owner TEXT NOT NULL,strategy TEXT NOT NULL,run_id TEXT NOT NULL,document TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(owner,run_id));
      CREATE TABLE IF NOT EXISTS agent_steps(plan_id TEXT NOT NULL,step INTEGER NOT NULL,phase TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(plan_id,step));
      CREATE TABLE IF NOT EXISTS agent_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,strategy TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_monitors(owner TEXT NOT NULL,strategy TEXT NOT NULL,document TEXT NOT NULL,next_at INTEGER NOT NULL,PRIMARY KEY(owner,strategy));
      CREATE TABLE IF NOT EXISTS agent_usage(day TEXT PRIMARY KEY,reserved INTEGER NOT NULL DEFAULT 0,actual INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_rebalance_drafts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,run_id TEXT NOT NULL,candidate_id TEXT NOT NULL,report_hash TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_autonomy_claims(plan_id TEXT PRIMARY KEY,policy_id TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);
    `);
  }
  transaction(fn) {this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  event(owner,strategy,kind,document={}) {this.db.prepare('INSERT INTO agent_events(owner,strategy,kind,document,created_at) VALUES(?,?,?,?,?)').run(owner,strategy,kind,JSON.stringify(document),Date.now());}
  enqueue(address,strategyId,goal,requestId) {
    const owner=this.owner(address),s=this.get(owner,strategyId),g=validateGoal(goal);
    if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))reject('Invalid run request.');
    const input={version:AGENT_VERSION,owner:address,strategy:s,goal:g,briefHash:briefHash(s)};
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM agent_runs WHERE owner=? AND request_id=?').get(owner,requestId);
      if(previous){if(hash(JSON.parse(previous.input))!==hash(input))reject('This run request was already used.',409);return previous.id;}
      if(this.db.prepare("SELECT count(*) n FROM agent_runs WHERE owner=? AND status IN ('QUEUED','RUNNING','WAITING_DATA','WAITING_MODEL')").get(owner).n>=3)reject('Finish or cancel an active research run first.',429);
      if(this.db.prepare('SELECT count(*) n FROM agent_runs WHERE owner=? AND created_at>?').get(owner,Date.now()-3600000).n>=12)reject('Research capacity reached for this hour.',429);
      const id=randomUUID(),now=Date.now();
      this.db.prepare('INSERT INTO agent_runs(id,owner,strategy,brief_hash,request_id,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,owner,s.id,input.briefHash,requestId,JSON.stringify(input),'QUEUED',now,now);
      this.event(owner,s.id,'QUEUED',{runId:id});return id;
    });
  }
  view(address,strategyId,after=0) {
    const owner=this.owner(address);this.get(owner,strategyId);integer(after,0,Number.MAX_SAFE_INTEGER,'event cursor');
    const runs=this.db.prepare('SELECT id,input,status,result,error,created_at,updated_at FROM agent_runs WHERE owner=? AND strategy=? ORDER BY created_at DESC LIMIT 20').all(owner,strategyId).map(r=>({id:r.id,goal:JSON.parse(r.input).goal,status:r.status,result:r.result?JSON.parse(r.result):null,error:r.error,createdAt:r.created_at,updatedAt:r.updated_at}));
    const plans=this.db.prepare('SELECT * FROM agent_plans WHERE owner=? AND strategy=? ORDER BY created_at DESC LIMIT 20').all(owner,strategyId).map(p=>({...JSON.parse(p.document),status:p.status,executionMode:this.db.prepare('SELECT 1 FROM agent_autonomy_claims WHERE plan_id=?').get(p.id)?'AGENT_WALLET':'MANUAL',steps:this.db.prepare('SELECT step,phase,document FROM agent_steps WHERE plan_id=? ORDER BY step').all(p.id).map(s=>({index:s.step,phase:s.phase,...JSON.parse(s.document)}))}));
    const events=this.db.prepare('SELECT cursor,kind,document,created_at FROM agent_events WHERE owner=? AND strategy=? AND cursor>? ORDER BY cursor LIMIT 200').all(owner,strategyId,after).map(e=>({cursor:e.cursor,kind:e.kind,...JSON.parse(e.document),at:e.created_at}));
    const monitor=this.db.prepare('SELECT document FROM agent_monitors WHERE owner=? AND strategy=?').get(owner,strategyId);
    return {owner:address,runs,plans,events,cursor:events.at(-1)?.cursor??after,monitor:monitor?JSON.parse(monitor.document):null};
  }
  cancel(address,id) {
    const owner=this.owner(address),r=this.db.prepare('SELECT * FROM agent_runs WHERE id=? AND owner=?').get(id,owner);if(!r)reject('Run not found.',404);
    if(!['QUEUED','RUNNING','WAITING_DATA','WAITING_MODEL'].includes(r.status))return;
    this.db.prepare("UPDATE agent_runs SET status='CANCELLED',lease_token=NULL,updated_at=? WHERE id=? AND owner=?").run(Date.now(),id,owner);this.event(owner,r.strategy,'CANCELLED',{runId:id});
  }
  claim(now=Date.now()) {
    return this.transaction(()=>{
      // A wait is not a data acquisition job. Never occupy all of an owner's
      // run slots forever while retrying the same absent file/provider.
      this.db.prepare("UPDATE agent_runs SET status='FAILED',error=COALESCE(error,'Research dependency unavailable.') || ' Retry after the dependency is restored.',lease_token=NULL,updated_at=? WHERE status IN ('WAITING_DATA','WAITING_MODEL') AND lease_until<? AND attempts>=3").run(now,now);
      this.db.prepare("UPDATE agent_runs SET status='FAILED',error='Worker interrupted repeatedly. Start a new run.',lease_token=NULL WHERE status='RUNNING' AND lease_until<? AND attempts>=3").run(now);
      const r=this.db.prepare("SELECT * FROM agent_runs WHERE status='QUEUED' OR (status='RUNNING' AND lease_until<? AND attempts<3) OR (status IN ('WAITING_DATA','WAITING_MODEL') AND lease_until<?) ORDER BY created_at LIMIT 1").get(now,now);
      if(!r)return null;
      const token=randomUUID();this.db.prepare("UPDATE agent_runs SET status='RUNNING',lease_until=?,lease_token=?,attempts=attempts+1,updated_at=? WHERE id=?").run(now+300000,token,now,r.id);
      this.event(r.owner,r.strategy,'RUNNING',{runId:r.id});return {...r,leaseToken:token,input:JSON.parse(r.input)};
    });
  }
  finish(run,status,result=null,error=null) {
    return this.transaction(()=>{
      const r=this.db.prepare("SELECT * FROM agent_runs WHERE id=? AND status='RUNNING' AND lease_token=?").get(run.id,run.leaseToken);if(!r)return false;
      const s=this.get(r.owner,r.strategy);if(briefHash(s)!==r.brief_hash){status='SUPERSEDED';error='The research brief changed. Run the updated version.';}
      if(result)result={...result,reportHash:hash(result)};
      this.db.prepare('UPDATE agent_runs SET status=?,result=?,error=?,lease_until=?,lease_token=NULL,updated_at=? WHERE id=?').run(status,result?JSON.stringify(result):null,error,Date.now()+300000,Date.now(),r.id);
      this.event(r.owner,r.strategy,status,{runId:r.id,message:error});return true;
    });
  }
  reviewCandidate(address,runId,candidateId,reportHash) {
    const owner=this.owner(address),r=this.db.prepare('SELECT * FROM agent_runs WHERE id=? AND owner=?').get(runId,owner);
    if(!r||r.status!=='REVIEW')reject('A completed, eligible research run is required.',409);
    const input=JSON.parse(r.input),strategy=this.get(owner,r.strategy),result=JSON.parse(r.result),candidate=result.candidates.find(c=>c.id===candidateId);
    if(result.reportHash!==reportHash||briefHash(strategy)!==r.brief_hash||Date.now()-r.updated_at>86400000||candidate?.verdict!=='ELIGIBLE')reject('Review a current eligible result.',409);
    return{strategy,candidate,input};
  }
  saveRebalanceDraft(address,runId,candidateId,reportHash,allocation) {
    this.reviewCandidate(address,runId,candidateId,reportHash);
    const id=randomUUID(),document={...allocation,id,runId,candidateId,reportHash};
    this.db.prepare('INSERT INTO agent_rebalance_drafts VALUES(?,?,?,?,?,?,?)').run(id,this.owner(address),runId,candidateId,reportHash,JSON.stringify(document),Date.now());return document;
  }
  approve(address,runId,candidateId,reportHash,draftId=null) {
    const owner=this.owner(address);
    return this.transaction(()=>{
      const r=this.db.prepare('SELECT * FROM agent_runs WHERE id=? AND owner=?').get(runId,owner);
      if(!r||r.status!=='REVIEW')reject('A completed, eligible research run is required.',409);
      const input=JSON.parse(r.input),s=this.get(owner,r.strategy),result=JSON.parse(r.result);
      if(result.reportHash!==reportHash||briefHash(s)!==r.brief_hash)reject('The plan changed. Run and review the latest version.',409);
      if(Date.now()-r.updated_at>86400000)reject('Refresh this research before approving it.',409);
      const c=result.candidates.find(c=>c.id===candidateId);if(!c||c.verdict!=='ELIGIBLE')reject('This strategy did not pass the target and risk checks.',409);
      if(!Array.isArray(c.weights)||!c.weights.length||c.weights.some(w=>!s.instruments.includes(w.instrument)||!Number.isSafeInteger(w.weightBps)||w.weightBps<0||w.weightBps>input.goal.maxWeightBps)||c.weights.reduce((n,w)=>n+w.weightBps,0)>10000-input.goal.minCashBps)reject('The strategy exceeds the approved universe or allocation limits.',409);
      const previous=this.db.prepare('SELECT * FROM agent_plans WHERE owner=? AND run_id=?').get(owner,runId);
      if(previous){const p=JSON.parse(previous.document);if(p.candidateId!==candidateId||(p.rebalanceDraftId??null)!==draftId)reject('This run already has a different approved allocation.',409);return p;}
      const unresolved=this.db.prepare("SELECT p.id FROM agent_plans p JOIN agent_steps s ON s.plan_id=p.id WHERE p.owner=? AND s.phase IN ('UNKNOWN','SUBMITTED','FINALIZED') LIMIT 1").get(owner);
      if(unresolved)reject('Check the previous trade outcome before approving another plan.',409);
      const active=this.db.prepare("SELECT id FROM agent_plans WHERE owner=? AND status IN ('APPROVED','PARTIAL','UNKNOWN')").get(owner);
      if(active)reject('Finish or revoke the previous plan before approving another.',409);
      const total=budgetAtoms(s.budget);let a=allocateBudget(total,c.weights),rebalance=null;
      if(draftId){const draft=this.db.prepare('SELECT * FROM agent_rebalance_drafts WHERE id=? AND owner=?').get(draftId,owner);if(!draft||draft.run_id!==runId||draft.candidate_id!==candidateId||draft.report_hash!==reportHash)reject('Review the matching holdings allocation.',409);rebalance=JSON.parse(draft.document);if(rebalance.expiresAt<Date.now())reject('Refresh the holdings review before approving.',409);a=rebalance;}
      const document={schema:'xtxc.research-plan/v1',owner:address,strategyId:s.id,briefHash:r.brief_hash,runId,candidateId,reportHash,goal:input.goal,budgetAtoms:total,budgetAsset:'USDC',budgetScope:rebalance?'SELECTED_HOLDINGS_PLUS_NEW_CASH':'NEW_CAPITAL',universe:s.instruments,legs:a.legs.map(l=>({side:'BUY',inputDecimals:6,...l})),cashAtoms:a.cashAtoms,...(rebalance?{rebalanceDraftId:draftId,snapshot:rebalance.snapshot,heldValueAtoms:rebalance.heldValueAtoms,portfolioValueAtoms:rebalance.portfolioValueAtoms,cashFloorAtoms:rebalance.cashFloorAtoms}:{}),maxSlippageBps:20,createdAt:Date.now(),expiresAt:Date.now()+3600000,nonce:randomUUID()};
      const id=hash(document),plan={...document,id};
      this.db.prepare('INSERT INTO agent_plans VALUES(?,?,?,?,?,?,?)').run(id,owner,s.id,runId,JSON.stringify(plan),'APPROVED',Date.now());this.event(owner,s.id,'APPROVED',{planId:id,runId});return plan;
    });
  }
  plan(address,id) {
    const owner=this.owner(address),p=this.db.prepare('SELECT * FROM agent_plans WHERE id=? AND owner=?').get(id,owner);if(!p)reject('Plan not found.',404);
    return {...JSON.parse(p.document),status:p.status};
  }
  claimAutonomy(address,id,policyId) {
    return this.transaction(()=>{
      const p=this.plan(address,id);
      if(!/^[a-f0-9]{64}$/.test(policyId))reject('Invalid approval.',409);
      const old=this.db.prepare('SELECT policy_id FROM agent_autonomy_claims WHERE plan_id=?').get(id);
      if(old){if(old.policy_id!==policyId)reject('This allocation already has a wallet approval.',409);return;}
      if(p.status!=='APPROVED'||p.expiresAt<Date.now()||briefHash(this.get(this.owner(address),p.strategyId))!==p.briefHash||this.db.prepare('SELECT 1 FROM agent_steps WHERE plan_id=?').get(id))reject('Review a current, unused allocation before connecting an agent wallet.',409);
      this.db.prepare('INSERT INTO agent_autonomy_claims VALUES(?,?,?)').run(id,policyId,Date.now());
      this.event(this.owner(address),p.strategyId,'AGENT_WALLET_BOUND',{planId:id,policyId});
    });
  }
  assertManual(id){if(this.db.prepare('SELECT 1 FROM agent_autonomy_claims WHERE plan_id=?').get(id))reject('This allocation is assigned to your agent wallet. Use its execution controls.',409);}
  syncAutonomy(address,id,execution){
    return this.transaction(()=>{
      const p=this.plan(address,id),claim=this.db.prepare('SELECT policy_id FROM agent_autonomy_claims WHERE plan_id=?').get(id);
      if(!claim||execution.id!==claim.policy_id||execution.planId!==id)reject('Execution binding changed.',409);
      for(const o of execution.orders){
        if(!Number.isSafeInteger(o.index)||!p.legs[o.index]||o.instrument!==p.legs[o.index].instrument)reject('Execution leg changed.',409);
        const phase=o.phase==='RECONCILED'&&o.receipt?'RECONCILED':o.phase==='EXPIRED_UNSIGNED'?'EXPIRED_UNSENT':o.phase==='FAILED_FINALIZED'?'FAILED':'UNKNOWN';
        this.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?) ON CONFLICT(plan_id,step) DO UPDATE SET phase=excluded.phase,document=excluded.document').run(id,o.index,phase,JSON.stringify({leg:p.legs[o.index],observation:{signature:o.signature,receipt:o.receipt,wallet:execution.wallet,autonomyOrderId:o.id}}));
      }
      const status=execution.phase==='COMPLETE'?'COMPLETE':execution.phase==='STOPPED'?'REVOKED':execution.orders.some(o=>o.phase!=='RECONCILED')?'UNKNOWN':execution.orders.length?'PARTIAL':'APPROVED';
      this.db.prepare('UPDATE agent_plans SET status=? WHERE id=?').run(status,id);
    });
  }
  reserveStep(address,id,index) {
    return this.transaction(()=>{
      this.assertManual(id);
      const p=this.plan(address,id),owner=this.owner(address),s=this.get(owner,p.strategyId);
      if(!['APPROVED','PARTIAL'].includes(p.status)||briefHash(s)!==p.briefHash||Date.now()>p.expiresAt)reject('This approval is no longer current.',409);
      integer(index,0,p.legs.length-1,'trade step');
      if(index>0&&this.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=? AND step=?').get(id,index-1)?.phase!=='RECONCILED')reject('Wait for the previous trade receipt.',409);
      const old=this.db.prepare('SELECT phase,document FROM agent_steps WHERE plan_id=? AND step=?').get(id,index);
      if(old){const doc=JSON.parse(old.document);if(old.phase==='PREPARED'&&Date.parse(doc.prepared.expiresAt)>Date.now())return{plan:p,existing:doc.prepared};reject('Check this trade before preparing another. No automatic replay.',409);}
      this.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?)').run(id,index,'PREPARING',JSON.stringify({leg:p.legs[index],at:Date.now()}));return{plan:p,existing:null};
    });
  }
  bindPrepared(address,id,index,prepared,quote) {
    const p=this.plan(address,id),rawOwner=address.slice(7),leg=p.legs[index];
    if(!['APPROVED','PARTIAL'].includes(p.status)||Date.now()>p.expiresAt||briefHash(this.get(this.owner(address),p.strategyId))!==p.briefHash)reject('This approval changed during preparation.',409);
    const match=leg.side==='SELL'?quote.schema==='skew.stockmesh.liquidation-quote/v1'&&quote.side==='SELL'&&quote.inputProduct?.mint===leg.productMint&&quote.inputProduct?.inputAtoms===leg.inputAtoms&&quote.output?.symbol==='USDC'&&BigInt(quote.output.minimumAtoms)>=BigInt(leg.minimumCashAtoms):quote.schema==='skew.stockmesh.exposure-quote/v2'&&quote.inAmountAtoms===leg.inputAtoms&&quote.inputSymbol==='USDC';
    if(prepared.owner!==rawOwner||prepared.quoteId!==quote.quoteId||quote.instrument!==leg.instrument||!match)reject('The prepared trade does not match the approved allocation.',409);
    const count=this.db.prepare("UPDATE agent_steps SET phase='PREPARED',document=? WHERE plan_id=? AND step=? AND phase='PREPARING'").run(JSON.stringify({leg:p.legs[index],prepared,at:Date.now()}),id,index).changes;
    if(!count)reject('Trade preparation lost its reservation.',409);
  }
  releaseUnsignedPreparation(address,id,index) {
    this.plan(address,id);
    // No bytes have been returned or signed in this branch. A retry may quote afresh.
    this.db.prepare("DELETE FROM agent_steps WHERE plan_id=? AND step=? AND phase='PREPARING'").run(id,index);
  }
  step(address,id,index) {
    const p=this.plan(address,id),r=this.db.prepare('SELECT * FROM agent_steps WHERE plan_id=? AND step=?').get(id,index);if(!r)reject('Trade not prepared.',409);
    return{plan:p,phase:r.phase,...JSON.parse(r.document)};
  }
  authorizeSubmit(address,id,index) {
    this.assertManual(id);
    const row=this.step(address,id,index),s=this.get(this.owner(address),row.plan.strategyId);
    if(!['APPROVED','PARTIAL','UNKNOWN'].includes(row.plan.status)||briefHash(s)!==row.plan.briefHash||Date.now()>row.plan.expiresAt||!['PREPARED','UNKNOWN','SUBMITTED'].includes(row.phase))reject('This trade approval is no longer valid.',409);
    return row;
  }
  recordStep(address,id,index,phase,observation={}) {
    const row=this.step(address,id,index);
    if(row.phase==='RECONCILED')return;
    this.db.prepare('UPDATE agent_steps SET phase=?,document=? WHERE plan_id=? AND step=?').run(phase,JSON.stringify({...row,plan:undefined,phase:undefined,observation}),id,index);
    const completed=this.db.prepare("SELECT count(*) n FROM agent_steps WHERE plan_id=? AND phase='RECONCILED'").get(id).n;
    const status=row.plan.status==='REVOKED'?'REVOKED':completed===row.plan.legs.length?'COMPLETE':phase==='UNKNOWN'?'UNKNOWN':completed?'PARTIAL':'APPROVED';
    this.db.prepare('UPDATE agent_plans SET status=? WHERE id=?').run(status,id);this.event(this.owner(address),row.plan.strategyId,'TRADE_STATUS',{planId:id,index,phase});
  }
  revoke(address,id) {
    const p=this.plan(address,id);this.db.prepare("UPDATE agent_plans SET status='REVOKED' WHERE id=?").run(id);this.event(this.owner(address),p.strategyId,'REVOKED',{planId:id});
    // Existing signed/submitted orders are not cancelled by changing this local plan.
  }
  monitor(address,strategyId,goal,enabled) {
    const owner=this.owner(address),s=this.get(owner,strategyId),g=validateGoal(goal);
    if(enabled&&this.db.prepare('SELECT count(*) n FROM agent_monitors WHERE owner=? AND strategy<>? AND json_extract(document,\'$.enabled\')=1').get(owner,strategyId).n>=3)reject('Monitor up to three research portfolios at a time.',429);
    const doc={enabled:enabled===true,mode:'RESEARCH_AND_ALERT',goal:g,briefHash:briefHash(s),owner:address,expiresAt:Date.now()+7*86400000,lastRelease:null,lastRunId:null,watch:null};
    this.db.prepare('INSERT INTO agent_monitors VALUES(?,?,?,?) ON CONFLICT(owner,strategy) DO UPDATE SET document=excluded.document,next_at=excluded.next_at').run(owner,strategyId,JSON.stringify(doc),Date.now());this.event(owner,strategyId,enabled?'MONITOR_ENABLED':'MONITOR_STOPPED');return doc;
  }
  reserveTokens(maximum,cap=100000) {
    const day=new Date().toISOString().slice(0,10);
    return this.transaction(()=>{this.db.prepare('INSERT OR IGNORE INTO agent_usage(day) VALUES(?)').run(day);const r=this.db.prepare('SELECT * FROM agent_usage WHERE day=?').get(day);if(r.reserved+r.actual+maximum>cap)return null;this.db.prepare('UPDATE agent_usage SET reserved=reserved+? WHERE day=?').run(maximum,day);return{day,maximum};});
  }
  tokenResult(ticket,actual=null) {this.db.prepare('UPDATE agent_usage SET reserved=reserved-?,actual=actual+? WHERE day=?').run(ticket.maximum,actual??ticket.maximum,ticket.day);}
}

// This checks a delegated authority supplied by a wallet adapter, not a login cookie.
// No production signer is installed by this module. A monitor can never promote itself.
export function checkDelegatedAuthority(m,order,usage,now=Date.now()) {
  if(!m||m.verifiedByWalletAdapter!==true||m.revoked||m.expiresAt<=now||m.owner!==order.owner||m.planHash!==order.planHash||m.chain!=='solana:mainnet')reject('A current wallet-enforced trading mandate is required.',403);
  if(!m.allowedMints.includes(order.inputMint)||!m.allowedMints.includes(order.outputMint)||order.receiver!==m.owner||order.maxSlippageBps>m.maxSlippageBps)reject('Order exceeds delegated asset or price limits.',403);
  if(BigInt(order.cashDebitAtoms)+BigInt(usage.cashDebitAtoms)>BigInt(m.maxCashDebitAtoms)||usage.turnoverBps+order.turnoverBps>m.maxDailyTurnoverBps||usage.lossBps>=m.maxLossBps)reject('Delegated budget or loss limit reached.',403);
  return true;
}
