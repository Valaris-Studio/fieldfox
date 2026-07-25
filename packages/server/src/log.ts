// Privacy default (PLAN §0, RESEARCH §6): NOTHING from the request body/content
// is logged — no context text, no field labels/values, no image bytes. Only
// operational metadata. Production should swap this for pino with a `redact`
// path list; a minimal function here avoids adding pino to the lockfile in this
// card. Every log site must pass an object of this shape only.
export interface RequestMeta {
  siteKey?: string; // the key id is operational, not user content
  formId?: string; // opaque per-form token; operational, not user content
  event: string;
  status: number;
  fieldCount?: number;
  imageCount?: number;
  estimatedTokens?: number;
  latencyMs?: number;
  errorClass?: string;
  reason?: string;
}

export type MetaLogger = (meta: RequestMeta) => void;

export const consoleMetaLogger: MetaLogger = (meta) => {
  // Structured single-line JSON keeps it grep-able and pino-swappable.
  console.info(JSON.stringify({ ts: new Date().toISOString(), ...meta }));
};
