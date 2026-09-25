/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

/**
 * Installable app shell. Only the immutable build assets and static files are
 * cached. Pages and API responses are never cached: incident data, transcripts
 * and photos stay off the device, which matters on shared phones and tablets.
 * Offline, a navigation gets a plain notice instead of stale incident data.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `sentinel-${version}`;
const ASSETS = [...build, ...files];

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
	);
});

const OFFLINE_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline — SENTINEL</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#07090c;color:#e7ebf0;font:15px system-ui,sans-serif">
<main style="max-width:28rem;padding:1.5rem"><h1 style="font-size:1.1rem">You're offline</h1>
<p style="color:#a3adbb;line-height:1.5">SENTINEL needs a connection to load and save incidents, so nothing is shown from this device. If this is an emergency, follow your site's procedure and call the people you need directly.</p>
<button onclick="location.reload()" style="margin-top:.5rem;padding:.5rem .9rem;border-radius:6px;border:1px solid #2e3846;background:#141920;color:#e7ebf0">Try again</button></main></body></html>`;

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== sw.location.origin) return;

	if (ASSETS.includes(url.pathname)) {
		event.respondWith(caches.match(url.pathname).then((hit) => hit ?? fetch(req)));
		return;
	}
	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req).catch(
				() =>
					new Response(OFFLINE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
			)
		);
	}
	// Everything else (API, data, photos) goes to the network untouched.
});
