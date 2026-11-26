---
name: dsh-superagent-code-writing
description: Rules for reliable, minimal, codebase-consistent code work; load before writing, changing, testing or reviewing code.
---

This is the mandatory default policy for every code-related task. Before the first code-related action, read [the complete code-writing rules](references/code-writing-rules.md). Apply them throughout exploration, planning, implementation, testing, debugging, review, and handoff.

## Mandatory Activation

- Use this skill whenever a task may write or change source code, tests, scripts, build files, infrastructure-as-code, or code-related configuration.
- Also use it for code generation, refactoring, debugging, testing, code review, and implementation planning.
- Do not skip it because a task or change appears small.
- If the complete rules cannot be read, do not modify code until the policy is available or a higher-priority instruction explicitly overrides it.

## Precedence

- Follow system, developer, explicit user, and repository-local instructions first.
- Treat the referenced rules as mandatory wherever they do not conflict with higher-priority instructions.
- When a material requirement is genuinely ambiguous, state the ambiguity and obtain clarification before making an architectural or hard-to-reverse choice.

## Completion Contract

- Read the relevant existing code, nearby patterns, imports, and tests before editing.
- Prefer the smallest implementation that fully satisfies the request.
- Keep changes surgical and avoid unrelated cleanup or formatting churn.
- Verify behavior with focused tests and report any checks that could not be run.
- Distinguish evidence from assumptions and communicate significant tradeoffs or residual risks precisely.
