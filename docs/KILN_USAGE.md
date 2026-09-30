# Kiln API usage in the recorded demo

The three requests in the demo produced **three actual Bricksum Kiln research-design calls**, using `qwen3-32b` at `POST https://api.bricksum.com/v1/chat/completions`. This table is extracted from the persisted production reports, not a scripted provider fixture or a new call made for publication.

| Research request | Created, UTC on September 30 | Input tokens | Output tokens | Observed model-call latency | PR7 decision |
| --- | --- | ---: | ---: | ---: | --- |
| 2 USDC · 5% · one year | 00:27:51.115 | 893 | 687 | 14,856 ms | REVIEW |
| 1 USDC · 3% · one year | 00:30:01.333 | 886 | 684 | 9,623 ms | REVIEW |
| 1 USDC · 1,000% · 30 days | 00:31:39.543 | 876 | 742 | 12,400 ms | DECLINED |
| **Total** | **3 research-design calls** | **2,655** | **2,113** | — | — |

These are the design calls after intake, not a claim that the whole session used no other inference calls. Latency is the measured application call span, not accelerator kernel time, p99 or energy use. The refused request also used Kiln; deterministic evaluation rejected its proposed strategies afterwards.

## Inspect the actual artifacts

* [Recorded requests, usage and normalized model proposals](../evidence/kiln-demo-20260930.json).
* [The model-calling implementation](../lib/research-kiln.mjs): approved host, account model availability, bounded JSON, provider usage fields, prompt/proposal hashes and rejection of tool calls.
* [PR7 integration](../compute/design_bridge.py): validate the proposed DSL, execute deterministic backtests and calculate acceptance checks.
* [Linked owner approvals and mainnet receipts](../evidence/demo-execution-20260930.json).

The published proposals include the actual signals, lookbacks, filters, weighting and risk-off designs returned during this session. They are not executable generated Python. Research report hashes bind the computed result to the later plan; a plan approval is distinct from a model response.

## Hashes, precisely

`promptHash` is SHA-256 of the canonical submitted messages. Prompt bodies are not published. `responseHash` is SHA-256 of the **validated, normalized proposal**, not the raw HTTP response body. The normalized proposals are included, so a reviewer can recompute their hashes with `npm run verify:evidence`.

During the read-only export we also recomputed each complete private report's hash and compared it to the linked plan. Public reports are allowlisted summaries, so their `reportHash` is not the digest of the shortened JSON. Mainnet receipt hashes are recomputable from the published receipt objects and appear in the corresponding devnet settlement instruction.

These are **application-recorded provider observations**, not a provider-signed attestation. Raw HTTP responses and provider request IDs were not retained, and no billing invoice or accelerator-energy measurement is inferred. API keys, authorization headers, endpoints carrying credentials and private databases are not included. Exporting this evidence called no model and initiated no transaction.

The measured model is Qwen; the repository does not relabel it as `gpt-oss-120b`. See [the submission boundary](EVIDENCE.md) for the Challenge A model requirement.
