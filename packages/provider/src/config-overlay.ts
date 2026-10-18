export interface ConfigValidationIssue {
  readonly code:
    | "required-field-missing"
    | "duplicate-key"
    | "duplicate-model"
    | "invalid-option-spec"
    | "invalid-config"
    | "invalid-reasoning-mapping"
    | "invalid-pattern"
    | "invalid-url"
    | "missing-template";
  readonly path: readonly string[];
  readonly message: string;
}

/**
 * The sparse config layer and the post-overlay config share one type.
 *
 * Subclasses enumerate fields; this base class fixes one semantic: inherit when absent,
 * recursive override for Config values, whole-value replace otherwise.
 */
export abstract class ConfigOverlay<TSelf extends ConfigOverlay<TSelf>> {
  abstract overlay(next: TSelf): TSelf;

  abstract validateComplete(path?: readonly string[]): readonly ConfigValidationIssue[];

  protected overlayValue<T>(base: T | undefined, next: T | undefined): T | undefined {
    return next === undefined ? base : next;
  }

  protected overlayConfig<T extends ConfigOverlay<T>>(
    base: T | null | undefined,
    next: T | null | undefined,
  ): T | null | undefined {
    if (next === undefined) return base;
    if (next === null || base === null || base === undefined) return next;
    return base.overlay(next);
  }
}

export function requiredFieldIssue(path: readonly string[], field: string): ConfigValidationIssue {
  return {
    code: "required-field-missing",
    path: [...path, field],
    message: `Missing required config ${[...path, field].join(".")}`,
  };
}
