/** What the key was created for; independent of keyType. Excludes 3 and -1, which serve only as legacy-mapping/cache sentinels. */
export const API_KEY_USAGE_SCENE = {
  CODING_PLAN: 1,
  STANDARD: 2,
} as const;

export type ApiKeyCreationUsageScene =
  (typeof API_KEY_USAGE_SCENE)[keyof typeof API_KEY_USAGE_SCENE];
