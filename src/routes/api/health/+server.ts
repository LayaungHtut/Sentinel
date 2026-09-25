import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Liveness: the process is up. Deliberately reveals no configuration. */
export const GET: RequestHandler = async () => json({ ok: true });
