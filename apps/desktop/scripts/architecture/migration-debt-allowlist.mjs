// Exact-path allowlist for the documented pre-migration Desktop architecture
// debt (see apps/desktop/AGENTS.md, "Migration and enforcement"). Every entry
// names one rule at one exact path with a reason and a verifiable removal
// trigger; the list only shrinks and unknown entries fail verification.
// This module must run directly in Node without a TypeScript runtime.

export const migrationDebtAllowlist = []
