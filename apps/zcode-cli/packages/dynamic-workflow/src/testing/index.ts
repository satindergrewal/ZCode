/**
 * `@zcode/dynamic-workflow/testing`: shared test assets for JournalStorePort implementers.
 * Runs only inside the consumer's test process (vitest is a devDependency of this package, never
 * a runtime dependency).
 */

export { runJournalStoreContract } from "./journal-contract.js";
