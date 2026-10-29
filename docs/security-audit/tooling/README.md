# Security Audit Tooling Setup (Phase 1)

Reproducible setup record for the security-audit environment. All installs were reviewed
before use; no unreviewed remote installer scripts were executed.

## 1. Environment (verified 2026-10-28)

- Windows 11 Pro, Git Bash
- Node v24.20.0, pnpm 11.1.1, Python 3.13.5
- Go 1.25.4 (for Go-based scanners), Docker 28.5.1, uv 0.8.17
- Network: GitHub reachable via `curl`/`git`/`go`/`uv`. The Claude `WebFetch`/`WebSearch`
  tools are blocked by enterprise policy for `github.com` — use `curl` for upstream docs.

## 2. Agentic audit skills (reviewed, optional for future runs)

### 2.1 Cloudflare `security-audit-skill`
- Repo: https://github.com/cloudflare/security-audit-skill (single skill, MIT)
- What it does: a six-phase audit *orchestration* methodology — reconnaissance +
  coverage ledger, coverage-led hunting with isolated hunters, adversarial candidate
  validation, structured `findings.json` output, independent record verification, and
  target-neutral reporting. Zero-dependency Node validators
  (`validate-findings.cjs`, `validate-coverage-ledger.cjs`).
- Install (reviewed): `npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit` (add `--global` for user-level).
- **Decision**: methodology adopted manually this run (this task already follows the
  same recon→hunt→verify→report discipline). Installing the skill adds a structured
  ledger + independent-verifier harness for *repeatable* runs; recommended for CI-driven
  audits, not required for this manual round.

### 2.2 Trail of Bits `skills` (marketplace)
- Repo: https://github.com/trailofbits/skills (marketplace of many plugins)
- Install (reviewed): `/plugin marketplace add trailofbits/skills`, then `/plugin menu`.
- Relevant plugins and overlap:
  | Plugin | Purpose | Overlap with this run |
  |---|---|---|
  | `static-analysis` | CodeQL + Semgrep + SARIF | Semgrep run directly below; CodeQL heavy for TS monorepo, deferred |
  | `insecure-defaults` | Parallel fail-open defaults audit + refuting verifiers | Same goal as Phase 3F; methodology adopted manually |
  | `differential-review` | git-history diff review | Useful for SDK 0.4.0/0.5.0 feature commits |
  | `supply-chain-risk-auditor` | npm/PyPI/Go advisories + abandoned upstream + install scripts | OSV-Scanner covers advisories; extra heuristics are additive |
  | `fp-check` | False-positive verification gate | Complements Phase 4 |
- **Decision**: the machine-checkable subset is covered by the CLI tools below
  (semgrep → static-analysis; osv-scanner → supply-chain advisories; gitleaks → secrets).
  The agentic *methodologies* are followed manually this run.

### 2.3 Overlap conclusion
- Cloudflare `security-audit` ≈ the *overall process* this task already implements.
- ToB `static-analysis` ⊃ semgrep; ToB `supply-chain-risk-auditor` ⊃ osv-scanner
  (adds publisher/abandonment/install-script heuristics not in OSV).
- No duplication installed: only the three concrete CLI tools were installed locally;
  the agentic skills are documented for repeatable future use rather than force-installed
  (they are Claude Code plugins added via the `/plugin` marketplace, not shell tools).

## 3. CLI scanners installed (local, reproducible)

All installs are isolated and do not upload source, keys, or user data.

### 3.1 Semgrep (static analysis)
```sh
uv tool install semgrep
# binary: ~/.local/bin/semgrep
```
Run (JSON output; `--config auto` requires metrics, so use explicit rulesets):
```sh
semgrep scan --config "p/default" --config "p/security-audit" --metrics=off \
  --json --output docs/security-audit/tooling/semgrep.json \
  --exclude "**/node_modules/**" --exclude "**/dist/**" --exclude "**/test/**" \
  --exclude "**/*.test.ts" --exclude "**/vendor/**" packages
```

### 3.2 Gitleaks (secrets)
```sh
# NOTE: module path is github.com/zricethezav/gitleaks/v8, NOT github.com/gitleaks/gitleaks/v8
go install github.com/zricethezav/gitleaks/v8@latest
# binary: $(go env GOPATH)/bin/gitleaks(.exe)
```
Run:
```sh
gitleaks detect --source . --report-format json \
  --report-path docs/security-audit/tooling/gitleaks.json --redact --no-banner
```

### 3.3 OSV-Scanner (dependency vulnerabilities)
```sh
go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest
# binary: $(go env GOPATH)/bin/osv-scanner(.exe)
```
Run:
```sh
osv-scanner scan --recursive . --format=json > docs/security-audit/tooling/osv-scanner.json
```

## 4. Reproducibility & incompatibilities log

- **gitleaks `@latest`** fails with a module-path conflict (`github.com/gitleaks/gitleaks/v8`
  declares itself as `github.com/zricethezav/gitleaks/v8`); the working install uses the
  `zricethezav` path (see above). Recorded 2026-10-28.
- **semgrep `--config auto`** errors ("Cannot create auto config when metrics are off");
  use explicit `p/default` + `p/security-audit` with `--metrics=off`.
- **Windows PATH**: Go binaries install to `$(go env GOPATH)/bin`, which is a
  Windows-style path; in Git Bash use `/c/Users/<user>/go/bin/<tool>.exe`.
- **WebFetch/WebSearch** blocked for `github.com` (enterprise policy); `curl` works.
  GitHub MCP plugin failed to connect (bad Authorization header) — treated as a
  connection failure, not a missing capability.

## 5. Results

- `semgrep.json`, `gitleaks.json`, `osv-scanner.json` under this directory.
- Findings are triaged into `../findings.md`; the scanners are treated as *leads* and
  every reported finding is verified against the source before being classified.
