// Interaction trim: tables already read fine inline; a fullscreen entry breaks the
// reading flow. Disable table zoom and keep only lightweight actions (copy/export);
// message body and reasoning panel share this one config.
export const STREAMDOWN_CONTROLS = {
  table: {
    fullscreen: false,
  },
} as const;
