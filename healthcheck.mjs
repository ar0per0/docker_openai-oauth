const port = process.env.PORT || "10531"
const baseUrl = `http://127.0.0.1:${port}/v1`
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || "30000")
const timeZone = process.env.TZ || "Etc/UTC"

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
	throw new Error("HEALTHCHECK_TIMEOUT_MS debe ser un entero positivo")
}

const localTimestamp = (date = new Date()) => {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(date)
			.filter(({ type }) => type !== "literal")
			.map(({ type, value }) => [type, value]),
	)
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
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
					content:
						"Realiza esta comprobación internamente: calcula (37 × 24) - 125 y verifica que el resultado sea 763. Si es correcto, responde única y exactamente con la palabra OK, en mayúsculas, sin comillas, explicaciones, puntuación ni espacios adicionales. Si no es correcto, responde ERROR.",
				},
			],
			max_completion_tokens: 128,
		}),
	})
	const answer = result.choices?.[0]?.message?.content
	if (answer !== "OK") {
		throw new Error(`Respuesta inesperada del modelo: ${JSON.stringify(answer)}`)
	}
	console.log(
		`[openai-oauth][cron] OK ${localTimestamp()} model=${model} response="OK"`,
	)
} catch (error) {
	console.error(
		`[openai-oauth][cron] ERROR ${localTimestamp()} ${error instanceof Error ? error.message : String(error)}`,
	)
	process.exitCode = 1
}
