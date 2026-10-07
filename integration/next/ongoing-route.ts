import {requireRequesterSession,RequesterAuthError} from '@/lib/requester-auth';
import {stocklanaBody} from '@/lib/stocklana-execution';
import {AgentStore} from '@/lib/research-agent-core.mjs';
import {LISTED_STOCKS} from '@/lib/stock-listing-scope';
import {ResearchStoreError} from '@/lib/research-store.mjs';
import {operatingRequest} from '@/lib/research-ongoing-feed.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, X-Skew-Expected-Requester'};
let store:AgentStore|undefined;
function db(){const path=process.env.XTXC_RESEARCH_DB;if(!path?.startsWith('/var/lib/xtxc-research/'))throw Error('EXECUTION_UNAVAILABLE');return store??=new AgentStore(path,LISTED_STOCKS);}
async function owner(r:Request){const s=await requireRequesterSession(r);if(s.agentKeyId||!s.address.startsWith('solana:'))throw new RequesterAuthError('OWNER_SESSION_REQUIRED','Sign in with your personal Solana wallet.',403);return s.address;}
function failure(e:unknown){if(e instanceof RequesterAuthError||e instanceof ResearchStoreError)return Response.json({error:{message:e.message}},{status:e.status,headers});const code=e instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:'EXECUTION_UNAVAILABLE';return Response.json({error:{code,message:code==='LEGACY_AUTHORITY_STILL_RUNNING'?'Stop the previous allocation before starting continuous trading.':code==='DELEGATED_WALLET_NOT_CONNECTED'?'Connect your agent wallet first.':'The operation could not complete. Existing orders remain recorded.'}},{status:409,headers});}
function sync(address:string,execution:any){if(execution.authorized)db().operatingMonitor(address,execution);return execution;}
export async function GET(r:Request){try{
 const address=await owner(r),q=new URL(r.url).searchParams;
 if(q.get('id'))return Response.json({execution:sync(address,await operatingRequest(address.slice(7),'ONGOING_STATUS',{id:q.get('id')}))},{headers});
 const strategyId=q.get('strategyId')??'';db().get(db().owner(address),strategyId);
 const m=db().db.prepare('SELECT document FROM agent_monitors WHERE owner=? AND strategy=?').get(db().owner(address),strategyId) as {document:string}|undefined;
 const id=m?JSON.parse(m.document).mandateId:null;
 return Response.json({execution:id?sync(address,await operatingRequest(address.slice(7),'ONGOING_STATUS',{id})):null},{headers});
}catch(e){return failure(e);}}
export async function POST(r:Request){try{
 const address=await owner(r),b=await stocklanaBody(r,8000) as Record<string,any>;
 if(Object.keys(b).some(k=>!['operation','id','runId','limits','signature'].includes(k)))throw Error('INVALID_REQUEST');
 if(b.operation==='DRAFT') {
  const s=db(),run=s.db.prepare("SELECT * FROM agent_runs WHERE id=? AND owner=? AND status IN ('REVIEW','DECLINED')").get(b.runId,s.owner(address)) as {strategy:string;input:string;result:string;updated_at:number;id:string}|undefined;
  if(!run)throw Error('CURRENT_RESEARCH_REQUIRED');
  const research={owner:address.slice(7),strategy:s.get(s.owner(address),run.strategy),input:JSON.parse(run.input),result:JSON.parse(run.result),updatedAt:run.updated_at,runId:run.id};
  return Response.json({execution:await operatingRequest(address.slice(7),'ONGOING_DRAFT',{research,limits:b.limits})},{headers});
 }
 if(!['ACTIVATE','STATUS','PAUSE','RESUME','REVOKE'].includes(b.operation)||typeof b.id!=='string')throw Error('INVALID_REQUEST');
 const execution=await operatingRequest(address.slice(7),`ONGOING_${b.operation}`,{id:b.id,signature:b.signature});
 return Response.json({execution:sync(address,execution)},{headers});
}catch(e){return failure(e);}}
