# Hermes ChatGPT MCP

Private-use integration project for connecting ChatGPT to a full Hermes Agent runtime through a thin MCP control adapter.

## Architecture

ChatGPT → `@Hermes` → secure MCP transport → this adapter → Hermes API server → full Hermes Agent.

The adapter must not duplicate Hermes' internal tool registry. Hermes remains responsible for its own tools, skills, memory, MCP connections, subagents and approvals.

## Security

- Hermes API remains localhost-only on the Cube runtime.
- No API keys, tunnel credentials, tokens, passwords, cookies or other secrets belong in this repository.
- Sensitive actions must preserve Hermes approval semantics.
- Runtime retries must not duplicate destructive work.

## Status

Project bootstrap / Hermes runtime preflight in progress.
