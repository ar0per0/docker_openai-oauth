import { boundedSignal, waitFor } from './runtime-safety.mjs'
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const number = (v) => typeof v === "number" && Number.isFinite(v) ? v : null
const string = (v) => typeof v === "string" ? v : null
const boolean = (v) => typeof v === "boolean" ? v : null
const windowSnapshot = (v) => record(v) ? {
	usedPercent: number(v.used_percent),
	windowDurationMins: number(v.limit_window_seconds) === null ? null : v.limit_window_seconds <= 0 ? null : Math.ceil(v.limit_window_seconds / 60),
	resetsAt: number(v.reset_at),
} : null

// A deliberately bounded subset of the unstable Codex RPC response, not raw backend data.
export function normalizeRateLimits(payload) {
	if (!record(payload) || !["rate_limit", "additional_rate_limits", "credits", "plan_type"].some((k) => Object.hasOwn(payload, k))) {
		throw new Error("Invalid usage schema")
	}
	if (payload.additional_rate_limits != null && !Array.isArray(payload.additional_rate_limits)) throw new Error("Invalid limits")
	const validateLimits = (limits) => {
		if (limits == null) return
		if (!record(limits)) throw new Error("Invalid rate limit")
		for (const field of ["primary_window", "secondary_window"]) {
			if (limits[field] != null && !record(limits[field])) throw new Error("Invalid window")
		}
	}
	validateLimits(payload.rate_limit)
	if (payload.credits != null && !record(payload.credits)) throw new Error("Invalid credits")
	const snapshot = (id, name, limits, credits) => ({
		limitId: id, limitName: name, normalModelSlug: null,
		primary: windowSnapshot(limits?.primary_window),
		secondary: windowSnapshot(limits?.secondary_window),
		credits: record(credits) ? { hasCredits: boolean(credits.has_credits), unlimited: boolean(credits.unlimited), balance: string(credits.balance) } : null,
		planType: string(payload.plan_type),
	})
	const rateLimits = snapshot("codex", null, payload.rate_limit, payload.credits)
	const byId = Object.create(null)
	byId.codex = rateLimits
	for (const item of payload.additional_rate_limits ?? []) {
		if (!record(item) || !string(item.metered_feature) || Object.hasOwn(byId, item.metered_feature)) throw new Error("Invalid or duplicate limit ID")
		validateLimits(item.rate_limit)
		byId[item.metered_feature] = { ...snapshot(item.metered_feature, string(item.limit_name), item.rate_limit, null), normalModelSlug: string(item.normal_model_slug) }
	}
	return { ordinaryUsageAllowed: boolean(payload.rate_limit?.allowed), rateLimits, rateLimitsByLimitId: byId }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), {
	status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
})
const error = (status, message) => json({ error: { message, type: "rate_limits_error" } }, status)

export async function handleOAuthRateLimits(request, auth, options = {}) {
	if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET", "cache-control": "no-store" } })
	const signal = boundedSignal(request.signal, options.timeoutMs ?? 10000)
	let session
	try { session = await waitFor(auth.getSession({ signal }), signal) } catch { return error(signal.aborted ? 502 : 503, "OAuth session unavailable.") }
	if (!session?.accessToken || !session?.accountId) return error(503, "OAuth session unavailable.")
	try {
		const headers = new Headers({ Authorization: `Bearer ${session.accessToken}`, "ChatGPT-Account-Id": session.accountId, Accept: "application/json", "User-Agent": "codex-cli" })
		if (session.isFedRamp === true) headers.set("X-OpenAI-Fedramp", "true")
		const response = await (options.fetch ?? globalThis.fetch)("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET", headers, redirect: "error",
			signal,
		})
		if (!response.ok) { await response.body?.cancel(); return error(502, "Usage upstream rejected the request.") }
		const chunks = []; let bytes = 0
		for await (const chunk of response.body) {
			bytes += chunk.length
			if (bytes > 262144) throw new Error('Usage response too large')
			chunks.push(chunk)
		}
		const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		if (payload?.account_id != null && payload.account_id !== session.accountId) return error(502, "Usage account mismatch.")
		return json(normalizeRateLimits(payload))
	} catch { return error(502, "Usage upstream unavailable or incompatible.") }
}
