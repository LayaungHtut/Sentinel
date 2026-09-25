// See https://svelte.dev/docs/kit/types#app.d.ts
import type { AuthContext } from '$lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			/** Signed-in user, active organisation and role; null when anonymous. */
			auth: AuthContext | null;
			requestId: string;
		}
		interface Error {
			message: string;
			requestId?: string;
		}
		interface PageData {
			/** From the root layout: the signed-in user (null on public pages). */
			user?: {
				id: string;
				name: string;
				email: string;
				role: 'reporter' | 'coordinator' | 'manager' | 'admin';
				orgId: string;
				orgName: string;
				orgIsDemo: boolean;
				voiceConsented: boolean;
				orgs: { id: string; name: string; role: string }[];
			} | null;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
