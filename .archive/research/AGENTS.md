# Orchestration Instructions for Claude Code

You are the **senior engineer and control panel** for this workspace. Your job is to plan, decompose, delegate, and synthesize — not necessarily to do all the implementation yourself.

---

## Worker Registry

You have four confirmed workers available. Pick the right tool for the job.

### `codex` — OpenAI Codex CLI
**Invocation:**
```bash
codex exec \
  -C "<cwd>" \
  --model gpt-5.3-codex \
  --sandbox <read-only|workspace-write> \
  [--full-auto] \
  -o .handoff/result-<slug>.txt \
  "$(cat .handoff/brief-<slug>.md)" \
  2>&1
```
**Sandbox modes:** `read-only` (review/analysis), `workspace-write --full-auto` (implementation/tests)

**Strengths:**
- Focused implementation inside a tight file scope
- Meticulous code review and security auditing
- Writing tests for a well-defined interface
- Refactoring with explicit constraints
- Sandboxed execution — safe for untrusted/risky changes

**Weaknesses:**
- Stateless per exec (no conversational context unless you `resume`)
- Cannot ask clarifying questions
- Needs a precise, complete brief — vague prompts produce vague output

**Best for:** Implementation tasks < 5 files, targeted reviews, test generation, security audits

---

### `opencode` — OpenCode CLI
**Invocation:**
```bash
opencode run \
  "$(cat .handoff/brief-<slug>.md)" \
  --dir "<cwd>" \
  --model <provider/model> \
  \
  >> .handoff/result-<slug>.txt \
  2>&1
```
Optional flags: `--variant <low|medium|high>` (effort), `--continue` (resume prior session)

**Strengths:**
- Infrastructure and full-stack tasks (SST, Pulumi, CDK)
- Long-form implementation that benefits from session continuity
- Works natively with its own context management
- Multi-model flexibility (pass `--model` to override)

**Weaknesses:**
- Output format is more verbose; parse with care when using `--format json`
- Less sandboxing control vs Codex

**Best for:** Infrastructure-as-code, full-stack features, longer tasks that may need `--continue`

---

### `claude-glm` — Claude with GLM/custom API server
**Invocation:**
```bash
claude-glm --dangerously-skip-permissions -p \
  "$(cat .handoff/brief-<slug>.md)" \
  >> .handoff/result-<slug>.txt \
  2>&1
```
**Note:** Same Claude Code binary, different config pointing to a custom API endpoint (claude-glm alias).

**Strengths:**
- Second-opinion analysis using a different model configuration
- Architecture review and planning with alternate model perspective
- Deep reasoning tasks where a different model baseline helps
- Cost-sensitive tasks (depending on the GLM endpoint config)

**Weaknesses:**
- No sandbox isolation
- Performance depends on the upstream API server config

**Best for:** Second opinions on design decisions, cross-checking analysis, planning tasks

---

### `claude` — Claude Code (default config)
**Invocation:**
```bash
claude --dangerously-skip-permissions --model claude-sonnet-4-6 -p \
  "$(cat .handoff/brief-<slug>.md)" \
  >> .handoff/result-<slug>.txt \
  2>&1
```

**Strengths:**
- General-purpose analysis, planning, and synthesis
- Explanation, documentation, and knowledge tasks
- Complex reasoning that benefits from full Claude capability

**Weaknesses:**
- No sandbox isolation
- Same model as the control panel — less useful for independent second opinions

**Best for:** Documentation, planning, explanation tasks where Codex is overkill

---

## Worker Selection Heuristic

| Task Type | Best Worker | Why |
|-----------|-------------|-----|
| Implementation, ≤5 files, risky changes | `codex` | Sandboxed, focused, safe |
| Security audit / code review | `codex` | Meticulous review mode |
| Test generation | `codex` | Strong at spec-to-tests |
| Infrastructure / IaC | `opencode` | Native context management |
| Long multi-step feature | `opencode` | Session continuity via `--continue` |
| Second opinion on architecture | `claude-glm` | Different model baseline |
| Planning / documentation | `claude` or `claude-glm` | Full reasoning capability |
| Parallel workstreams | Mix | Split by task type, fire simultaneously |

**Auto-selection rules (when `--to` is not specified):**
1. Task contains "review", "audit", "check", "security" → `codex --sandbox read-only`
2. Task contains "implement", "write", "create", "fix", "add", "refactor" with ≤5 files → `codex --sandbox workspace-write`
3. Task contains "infrastructure", "sst", "pulumi", "cdk", "deploy" → `opencode`
4. Task explicitly needs a second opinion or different model → `claude-glm`
5. Task is documentation, planning, or explanation → `claude`
6. Default fallback → `codex`

---

## The Delegation Protocol

### Step 1 — Write the Brief

Write a self-contained brief to `.handoff/brief-<slug>.md` (create `.handoff/` if it doesn't exist):

```markdown
## Architect Protocol
- **Explore first, read before coding.** Read all files listed below before writing a single line.
- **Match existing style and structure.** Search for existing patterns. Trace usages when changing shared code.
- **No placeholders or TODOs.** Every function must be fully implemented.
- **No generic code.** Write code that belongs in THIS codebase, not a tutorial.
- **Scope discipline.** Touch only what the task requires. Do not "clean up" adjacent code.
- **Incremental implementation.** Build in slices — implement, verify, expand. No 200+ line single passes.
- **Verify your work.** Run the code. Fix errors before reporting done.
- **When uncertain:** flag it, don't guess. Prefer explicit over clever.

Also read and follow `.handoff/references/architect.md` for the full protocol.

## Task
<one-paragraph description of exactly what to do>

## Working Directory
<absolute path>

## Files in Scope
<explicit list of files to read/modify>

## Read These First
Before writing ANY code, read the following files to understand the codebase:
<neighbouring files — imports, shared modules, similar patterns>
Pay attention to: naming, error handling, export patterns, comment style.
Write code that matches this codebase, not generic boilerplate.

## Codebase Conventions
<naming (camelCase/snake_case), error handling style, export pattern, indent, comments>

## Constraints
- <what NOT to touch>
- <patterns to follow>
- <output format required>

## Do NOT Rationalize
| If you think... | Do this instead |
|---|---|
| "I'll add tests later" | Write the test now. Untested code is unfinished. |
| "This is simple enough to skip reading" | Read it anyway. Generic code creates cleanup work. |
| "Let me clean up this nearby code" | Don't. Touch only what the task requires. |
| "Let me build a generic abstraction" | Implement the specific thing. Abstract on the third use case. |

## Red Flags — Stop If You Notice
- Writing code without having read the neighbouring files first
- Inventing a pattern that doesn't exist elsewhere in the codebase
- 100+ lines written without running or testing anything
- Modifying files outside the listed scope

## Definition of Done
<what "finished" looks like — concrete, checkable>

Skip preambles. Read the codebase files first, then start the work.
```

The brief is the entire handoff. The worker has no other context. **The "Read These First" section is critical — it's the difference between generic AI slop and code that belongs in the codebase.** Always include at least 2-3 neighbouring files. **The "Do NOT Rationalize" table blocks agents from skipping steps.** Always include it.

### Step 2 — Select Worker and Fire

**Determine the worker** using the heuristic above or the explicit `--to` flag.

Ensure `.handoff/` exists, then fire via Bash tool. Use `run_in_background: true` for tasks > ~30s:

```bash
mkdir -p .handoff

# codex
codex exec -C "<cwd>" --model gpt-5.3-codex --sandbox <mode> [--full-auto] \
  -o .handoff/result-<slug>.txt "$(cat .handoff/brief-<slug>.md)" 2>&1

# opencode
cd "<cwd>" && opencode run "$(cat .handoff/brief-<slug>.md)" \
  >> .handoff/result-<slug>.txt 2>&1

# claude-glm
claude-glm --dangerously-skip-permissions -p "$(cat .handoff/brief-<slug>.md)" \
  >> .handoff/result-<slug>.txt 2>&1

# claude
claude -p "$(cat .handoff/brief-<slug>.md)" \
  >> .handoff/result-<slug>.txt 2>&1
```

### Step 3 — Receive and Synthesize

```bash
cat .handoff/result-<slug>.txt
```

1. Assess whether the worker completed the definition of done
2. If partial → resume or fix yourself:
   - Codex: `codex exec resume --last "follow-up instruction"`
   - OpenCode: re-run with `--continue`
   - Others: re-run with updated brief
3. If complete → synthesize into your response
4. Clean up: `rm .handoff/brief-<slug>.md .handoff/result-<slug>.txt`

---

## Multi-Worker Parallelism

**All workers run in the same working directory on live files. There are no worktrees or isolation layers. Two workers writing the same file simultaneously = silent data loss (last write wins). You must prevent this before firing.**

### Pre-flight: shared file scan

Before decomposing any parallel task, identify every file the overall task touches and flag any file that more than one workstream would naturally modify. Common culprits:

- Package manifests: `package.json`, `Cargo.toml`, `pyproject.toml`
- Barrel exports / index files: `src/index.ts`, `mod.rs`
- Config files: `tsconfig.json`, `vite.config.ts`, `.eslintrc`
- Shared types: `src/types.ts`, `src/schema.ts`
- Test setup: `vitest.config.ts`, `conftest.py`

**For each shared file:** assign ownership to exactly one workstream. All others are explicitly banned from touching it in their brief. If no single workstream owns it cleanly, pull it out of parallel work entirely and handle it yourself after workers complete.

### Brief constraint — always include

Every parallel brief must have a **"Files You Must NOT Touch"** section listing all files outside that workstream's explicit scope. If a worker needs a change in a banned file, it should note it in output instead of making it.

### Post-parallel reconciliation

After all workers complete, you apply shared file changes yourself — reading each worker's noted changes and merging them. You have full context of what all workers did; the workers don't.

### Firing multiple workers in the same message using `run_in_background: true`. Use distinct slugs:

```
[Bash run_in_background] codex exec ... -o .handoff/result-auth-review.txt ...
[Bash run_in_background] opencode run ... >> .handoff/result-infra-impl.txt ...
[Bash run_in_background] claude-glm --dangerously-skip-permissions -p ... >> .handoff/result-design-check.txt ...
```

All run concurrently. You're notified when each completes. Then synthesize across all results.

---

## Resume Protocol

| Worker | Resume Command |
|--------|---------------|
| Codex | `codex exec resume --last -o .handoff/result-<slug>-v2.txt "follow-up"` |
| OpenCode | `opencode run "follow-up" --dir <cwd> --continue >> .handoff/result-<slug>-v2.txt 2>&1` |
| claude-glm | Re-run with updated brief (stateless) |
| claude | Re-run with updated brief (stateless) |

---

## Structured Output

For machine-readable output from Codex:

```bash
codex exec \
  --output-schema .handoff/schema-<slug>.json \
  -o .handoff/result-<slug>.txt \
  "$(cat .handoff/brief-<slug>.md)"
```

Define the schema as a JSON Schema object before running.

---

## Brief Writing Standards

- **Codebase-aware**: ALWAYS include a "Read These First" section pointing the worker to 2-3 neighbouring files. Workers that don't read the codebase write generic slop. This is the single most important thing in the brief.
- **Convention-explicit**: state the codebase conventions (naming, error handling, exports, indent). Don't make the worker guess.
- **Anti-rationalization**: ALWAYS include a "Do NOT Rationalize" table with 3-4 task-relevant excuses and rebuttals. Agents rationalize skipping steps — the table blocks this.
- **Red flags**: ALWAYS include a "Red Flags — Stop If You Notice" section with 3-4 observable signs the worker is going off-track.
- **Five-axis review**: review briefs must evaluate across correctness, readability, architecture, security, and performance — not just one dimension.
- **Incremental implementation**: impl briefs must enforce slicing — implement one piece, test it, verify it, then expand. No 200+ line single-pass implementations.
- **Scope discipline**: briefs must state what NOT to touch. Workers must not clean up adjacent code, refactor imports in unrelated files, or add features not in the spec.
- **Atomic scope**: one brief = one clear unit of work
- **No ambiguity**: every decision the worker might need to make should be pre-decided
- **File-explicit**: list every file the worker should touch; don't say "the auth module"
- **Format-explicit**: tell the worker exactly how to format output if you need to parse it
- **No preamble request**: always end briefs with `Skip preambles. Read the codebase files first, then start the work.`
- **Worker-aware**: calibrate brief detail level to worker strength — Codex needs tighter specs
