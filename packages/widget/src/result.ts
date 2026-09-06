export type FieldFoxResult =
  | { status: 'filled'; filledCount: number; leftCount: number }
  | { status: 'refused'; httpStatus: number; errorCode?: string; signupUrl?: string }
  | { status: 'error'; httpStatus?: number; errorCode?: string }
  | { status: 'aborted' };
