export default {
	async fetch(request, env, ctx) {
		// --- inbound auth: secret in the URL path (Ring can't set headers) ---
		const url = new URL(request.url);

		console.log("DEBUG expected:", JSON.stringify(env.INBOUND_SECRET), "got:", JSON.stringify(url.pathname)); // TODO remove

		if (url.pathname !== `/${env.INBOUND_SECRET}`) {
			return new Response("nope", { status: 401 });
		}
		if (request.method !== "POST") {
			return new Response("method not allowed", { status: 405 });
		}

		// --- parse the multipart form the Ring sends ---
		const form = await request.formData();
		const transcription = (form.get("transcription") ?? "").toString().slice(0, 10000);
		const recordedAt = form.get("recordedAt");
		const client = form.get("client");

		// skip Ring test events (comment out if you want them through)
		if (form.get("test") === "true") {
			return new Response("ok (test skipped)", { status: 200 });
		}
		if (!transcription.trim()) {
			return new Response("ok (empty transcription)", { status: 200 });
		}

		// --- build the Notion session request ---
		const payload = {
			agent_id: env.NOTION_AGENT_ID,   // omit session_id => starts a new session
			message: transcription,
			metadata: {
				source: (client ?? "pebble-index-01").toString(),
				recorded_at: (recordedAt ?? "").toString(),
			},
		};

		const forward = fetch("https://api.notion.com/v1/sessions", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${env.NOTION_TOKEN}`,
				"Notion-Version": "2026-03-11",
				"Content-Type": "application/json",
				"Accept": "application/json",
			},
			body: JSON.stringify(payload),
		});

		ctx.waitUntil(forward);                        // don't make the Ring wait
		return new Response("ok", { status: 200 });    // ack fast so it doesn't retry
	},
};