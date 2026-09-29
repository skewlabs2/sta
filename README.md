# STA — Stock Token Agent

**Research a stock allocation. Test the idea. Approve a version. Account for what actually happened.**

STA turns a plain-language stock-investing goal into measured strategy candidates and owner-approved, policy-gated execution through XTXC.

An agent can write a convincing investment thesis without having a viable strategy. It can also produce a valid transaction without having permission to spend. STA treats those as two different problems, and makes neither one the model's decision.

The model interprets the request and proposes a small research configuration. Deterministic code evaluates returns, drawdown, concentration and execution costs. The user approves a particular version. A separate execution service checks the actual transaction, reserves the approved allowance, requests a signature and reconciles delivery.

[Read the architecture](docs/ARCHITECTURE.md) · [Inspect the evidence](docs/EVIDENCE.md) · [Review the trust boundary](docs/SECURITY.md) · [See what is new](docs/PROVENANCE.md)

## One request, several boundaries

> “Research semiconductors for one year with 100 USDC. Test a 5% target.”

```text
Plain-language request + optional stock selection
       │
       ▼
Kiln / Qwen ── typed research draft; no executable code or signing tools
       │
       ▼
Sealed data release → deterministic backtests → independent result checks
       │                                       │
       │                                       └─ unsupported goal → DECLINED
       ▼
Candidate report → owner approves exact plan version → explicit Start
       │
       ▼
StockMesh quote → inspect exact transaction → simulate
       │
       ▼
Devnet policy reservation → isolated Privy signer → mainnet StockMesh
       │                                                 │
       └──────────── result commitment ◀── finalized debit + delivery
```

**Mainnet is the execution chain. Devnet is the policy-recording and evidence chain.** Devnet cannot enforce a mainnet spending limit by itself. The isolated signer gate is a trusted component, not a cross-chain proof. A hash is not a fill. A test pass is not a trade.

## What is in this repository

This is the **GWDC 2026 Challenge A hackathon source snapshot**, separated from the existing XTXC exchange. XTXC/StockMesh remains the external execution system; its older router is [credited separately](https://github.com/xtxctrade/xtxc), not presented as new work.

| Component | Implementation | Boundary worth reading |
| --- | --- | --- |
| Natural-language intake | [research-intake.mjs](lib/research-intake.mjs) | Numerical goals must be grounded in the user's words; stock clicks are optional |
| Model invocation | [research-kiln.mjs](lib/research-kiln.mjs) | Typed proposal, bounded response, metered tokens, no trading tools |
| Data releases | [quantstore.py](agent/xtxc_agent/research/quantstore.py), [marketdata.py](agent/xtxc_agent/research/marketdata.py) | Content hashes, coverage checks, synthetic-history quarantine |
| Strategy engine | [strategy_lang.py](agent/xtxc_agent/research/strategy_lang.py), [backtest.py](agent/xtxc_agent/research/backtest.py) | Restricted strategy language, next-session execution, post-cost equity |
| Candidate acceptance | [evaluate.py](compute/evaluate.py), [research-evaluation-audit.mjs](lib/research-evaluation-audit.mjs) | Held-out windows, doubled-cost stress, independent boundary checks |
| Execution economics | [execution_costs.py](agent/xtxc_agent/research/execution_costs.py), [exectape.py](agent/xtxc_agent/research/exectape.py) | Token atoms, stock-share exposure and observed costs remain distinct |
| Approval and execution | [research-autonomy-control.mjs](lib/research-autonomy-control.mjs), [research-autonomy-runtime.mjs](lib/research-autonomy-runtime.mjs) | Exact approved version; owner Start; no generic signing endpoint |
| Transaction inspection | [research-autonomy-wire.mjs](lib/research-autonomy-wire.mjs) | StockMesh opcode, wallet accounts, minimum output, fees and ALT state |
| Recovery journal | [research-autonomy-journal.mjs](lib/research-autonomy-journal.mjs) | Persist before signing; unresolved exposure survives restarts and policy changes |
| On-chain policy | [Rust program](programs/xtxc-demo-policy/src/lib.rs) | Generic budget, per-order amount, count, mint universe, period and revocation |

The smaller Python API under `agent/xtxc_agent/core` supports research, reporting and **local-chain** exercises. It is not the deployed Privy/mainnet execution service. The active execution path is the JavaScript control/runtime path above. The old exchange frontend and archived UI prototypes are intentionally not duplicated here.

## Engineering decisions, not adjectives

### The model does not grade its own idea

The production research worker asks the model for a rebalance interval and lookback **before showing it prices**. It evaluates three fixed long-only candidates: equal weight, low volatility and momentum. Acceptance comes from computed results, including held-out drawdown and doubled transaction costs. An implausible requested return remains visible and can be rejected; it is not quietly replaced with an easier target.

The broader research library also contains a bounded strategy DSL. That capability is separate from the smaller production worker proposal schema. Neither permits arbitrary model-generated Python.

### An uncertain signature is an unresolved liability

If a signer times out, the system cannot assume that no signature exists. It records `SIGNING_UNKNOWN`, blocks a new order for that wallet and does not automatically sign a replacement. A relay retry reuses the exact signed bytes. A timeout never replenishes an allowance.

Stopping one policy and creating another does not escape the wallet-wide unresolved-order fence. [The restart and cross-policy tests](tests/research-autonomy.test.mjs) exercise that distinction.

### Approval binds the transaction, not the button

The gate checks the approved owner, plan version, wallet, budget and mint universe. It then decodes the prepared transaction and verifies permitted StockMesh instructions, account roles, amount, minimum output and fee bounds. Provider consent and signer policy must still match immediately before signing.

A finalized receipt must match the signed wire and show the expected USDC debit and stock-token credit. A successful API response or transaction signature alone cannot create a delivered position.

### Units and history are first-class inputs

Money uses integer atoms at execution boundaries. Research uses numerical arrays, but converting a token balance to a stock exposure is explicit. An issuer's share ratio, token premium and price history are not interchangeable.

Adjusted historical prices are retrospective research inputs—not a claim of point-in-time fundamentals. Snapshots are sealed and hashed; missing or suspected synthetic history is not replaced with a flattering curve. Yahoo chart data and yfinance are also **not independent market-data vendors**.

## Run the bounded checks

Use **Linux, Node 22.13+ within the 22.x line, Python 3.12 and Rust**. The publication run used Node 22.23.2. No API keys, wallet funding, RPC endpoint or historical-price download is needed for the default suites.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run verify:bundle

python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
export XTXC_CATALOG_REPORT="$PWD/fixtures/catalog-observation.json"
export XTXC_DATA_DIR="$PWD/.local/no-live-data"
export XTXC_KILN_OFFLINE=1
python -m pytest -q

cargo test --locked --manifest-path programs/xtxc-demo-policy/Cargo.toml
```

The catalog file is a historical **identity fixture**, not a live liquidity feed. Tests needing privately retained price snapshots skip explicitly. CI runs JavaScript and Python suites inside an empty network namespace after installing dependencies. The commands above do not start trading services.

For module responsibilities, controlled provider checks and the SVM harness, see [the runbook](docs/RUNBOOK.md). Raw prices, customer databases, wallet credentials and deployer keys are not distributed.

## Evidence you can inspect

* [Publication verification](evidence/verification.json): exact suite results, scope and checksums.
* [Kiln observations](evidence/kiln-observed.json): actual historical provider/model calls, input/output token counts and proposal hashes; ordinary research and a rejected target are separate records.
* [Devnet observations](evidence/devnet-observed.json): deployment, policy creation, reservation and revocation transaction signatures; negative simulations are labeled as simulations.
* [Source provenance](evidence/source-provenance.json): original source hashes, observed modification times and publication modifications. These are not fabricated Git commits or proof of original authorship.

Devnet program: [`3i5oG6xw28CTDHf4q49MRxkr6z3uzvMwhtf9FK5qH4pr`](https://explorer.solana.com/address/3i5oG6xw28CTDHf4q49MRxkr6z3uzvMwhtf9FK5qH4pr?cluster=devnet).

The recorded deployment ELF hash is `4971dd8675894577ecb086dab0addc54d8784d4326ae69abe7428a0f5aaec600`. The Rust policy implementation is included; keys and build binaries are not.

## Current scope

The implemented delegated lane is **approved new-capital stock-token buying**, with up to eight approved mints per policy. Holdings-aware buy/sell planning exists separately, but this snapshot does not claim autonomous sell/rebalance acceptance or unrestricted 24-hour asset management.

The published evidence does **not** establish a funded end-to-end autonomous mainnet trade. Existing XTXC manual swaps do not prove that separate path. This release also does not claim audited custody, guaranteed investment returns, HFT latency or measured NPU energy savings.

The recorded model is `qwen3-32b` on Bricksum Kiln. The published Challenge A brief names `gpt-oss-120b`; organizer acceptance of this substitution has not been established by this repository. [Submission evidence and remaining items](docs/EVIDENCE.md) make the distinction explicit.

## Team

Built by members of **Blackstone**, a university blockchain collective.

| Name | Responsibility | University |
| --- | --- | --- |
| 조민석 | Backend | Seoul National University |
| 양주원 | Frontend | Chung-Ang University |
| 허운 | Smart contracts | Chung-Ang University |
| 제갈민 | Data analysis | Sungkyul University |

See [NOTICE.md](NOTICE.md) for the source, data and dependency boundaries.
