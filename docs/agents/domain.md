# Domain Docs

## Before exploring, read these

- `CONTEXT-MAP.md` at the repository root, then each relevant context's `CONTEXT.md`.
- Relevant system-wide decisions in `docs/adr/`.
- Relevant context-scoped ADRs, including `apps/desktop/docs/adr/` and `<context>/docs/adr/` when present.

If a document does not exist, proceed silently. Create or revise domain documentation only when terminology or an architectural decision is actually being resolved.

## File structure

This is a multi-context repository:

```
/
├── CONTEXT-MAP.md
├── docs/adr/                  ← system-wide decisions
├── apps/desktop/
│   ├── CONTEXT.md
│   └── docs/adr/              ← desktop-specific decisions
└── server/
    └── CONTEXT.md
```

## Use the glossary's vocabulary

Use terms defined in the relevant `CONTEXT.md` for issue titles, proposals, hypotheses, and test names. Do not substitute a glossary term with an avoided synonym.

If a needed concept is absent, reconsider whether existing terminology applies; otherwise record the gap for `/domain-modeling`.

## Flag ADR conflicts

Explicitly surface a conflict with an existing ADR rather than silently overriding it.
