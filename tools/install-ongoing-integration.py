"""Install the ongoing route and panel into an existing XTXC Next.js tree.

This only copies source files. It neither builds nor starts any service.
"""
from pathlib import Path
import argparse
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("web", type=Path)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1]
web = args.web.resolve()
panel = web / "app/exchange/research-agent-panel.tsx"
declaration = web / "lib/research-agent-core.d.mts"
if not panel.is_file() or not declaration.is_file():
    parser.error("An existing XTXC research application is required.")

route = web / "app/api/v1/stocklana/research/ongoing/route.ts"
route.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(source / "integration/next/ongoing-route.ts", route)
shutil.copy2(source / "integration/next/research-ongoing-panel.tsx", panel.with_name("research-ongoing-panel.tsx"))
for p in (source / "lib").glob("research-ongoing-*.mjs"):
    shutil.copy2(p, web / "lib" / p.name)
for name in ["research-agent-core.mjs", "research-autonomy-control.mjs", "research-autonomy-privy.mjs"]:
    shutil.copy2(source / "lib" / name, web / "lib" / name)
shutil.copy2(source / "scripts/research-autonomy-service.mjs", web / "scripts/research-autonomy-service.mjs")

text = "\n".join(line for line in panel.read_text().splitlines()
                 if "ResearchOngoingPanel" not in line) + "\n"
anchor = "import {ResearchAutonomyPanel} from './research-autonomy-panel';"
assert anchor in text, "Missing existing autonomy panel import"
text = text.replace(anchor, anchor + "\nimport {ResearchOngoingPanel} from './research-ongoing-panel';")
anchor = '{run?.result&&<button className="ra-run-note" onClick={onResults}><b>{labels[run.status]}</b><span>{run.result.explanation}</span></button>}'
assert anchor in text, "Missing research controls mount point"
mount = "{run?.result&&['REVIEW','DECLINED'].includes(run.status)&&<ResearchOngoingPanel wallet={agent.data?.owner.replace(/^solana:/,'')??null} strategyId={strategy.id} runId={run.id} budget={strategy.budget} goal={run.goal}/>}"
panel.write_text(text.replace(anchor, anchor + "\n    " + mount))

text = declaration.read_text()
if "operatingMonitor(" not in text:
    anchor = "  monitor(address:string,strategyId:string,goal:unknown,enabled:boolean):unknown;"
    assert anchor in text, "Missing AgentStore declaration mount point"
    text = text.replace(anchor, anchor + "\n  operatingMonitor(address:string,execution:unknown):unknown;")
    declaration.write_text(text)
print("Ongoing source, route, wallet-signing panel and declarations installed.")
