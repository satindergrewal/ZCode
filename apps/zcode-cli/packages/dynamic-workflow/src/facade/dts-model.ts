/**
 * The model declarations inside the facade's actor segment
 * (docs/dynamic-workflow/authoring.md "Choosing a model per subagent"): `ModelRef` and
 * `model()`.
 *
 * A separate module only because dts.ts sits at the max-lines cap (same reason as
 * dts-stream.ts); the contract is unchanged: dts.ts splices this text **into the middle of the
 * actor segment** (after `Node`, before `AgentPersona`), so it ships in `FACADE_DTS` only, not
 * the snippet; tests/facade-dts.test.ts pins the concatenation by sha256. The text opens with a
 * declaration and ends with a newline; the surrounding blank lines come from the actor segment.
 */
export const FACADE_MODEL_DECLARATIONS = String.raw`/** A model declared with model(). */
declare class ModelRef { private constructor(); private readonly modelRef: never }

/**
 * Declare a model subagents may run on: "modelId" or "providerId/modelId", optional "$level".
 * String literal only (checked at launch); choose among ModelRefs at run time.
 */
declare function model(id: string): ModelRef;
`;
