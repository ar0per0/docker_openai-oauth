const port = process.env.PORT || "10531"
const baseUrl = `http://127.0.0.1:${port}/v1`
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || "30000")

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
	throw new Error("HEALTHCHECK_TIMEOUT_MS debe ser un entero positivo")
}

const requestJson = async (url, options = {}) => {
	const response = await fetch(url, {
		...options,
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			Authorization: "Bearer openai-oauth",
			"Content-Type": "application/json",
			...options.headers,
		},
	})
	const body = await response.text()
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`)
	}
	if (!body) return {}
	try {
		return JSON.parse(body)
	} catch {
		throw new Error(`Respuesta JSON no válida de ${url}: ${body.slice(0, 500)}`)
	}
}

const resolveModel = async () => {
	if (process.env.MODEL_TEST) return process.env.MODEL_TEST
	const models = await requestJson(`${baseUrl}/models`)
	const model = models.data?.[0]?.id
	if (!model) throw new Error("No hay ningún modelo disponible")
	return model
}

try {
	const model = await resolveModel()
	const result = await requestJson(`${baseUrl}/chat/completions`, {
		method: "POST",
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: "Responde únicamente OK. Es una comprobación automática del servicio.",
				},
			],
			max_completion_tokens: 16,
		}),
	})
	const answer = result.choices?.[0]?.message?.content ?? "respuesta recibida"
	console.log(
		`[openai-oauth][cron] OK ${new Date().toISOString()} model=${model} response=${JSON.stringify(answer)}`,
	)
} catch (error) {
	console.error(
		`[openai-oauth][cron] ERROR ${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}`,
	)
	process.exitCode = 1
}
