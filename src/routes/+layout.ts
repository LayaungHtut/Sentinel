// The dashboard renders live, locale-formatted timestamps and drives the
// microphone; client-side rendering avoids hydration mismatches on time text.
// Server `load` functions still run on the server (secrets stay there).
export const ssr = false;
