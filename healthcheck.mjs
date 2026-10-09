import { randomInt } from "node:crypto"

const port = process.env.PORT || "10531"
const baseUrl = `http://127.0.0.1:${port}/v1`
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || "30000")
const testCount = Number(process.env.CRON_TEST_COUNT || "1")
const testContext = process.env.TEST_CONTEXT || "cron"
const timeZone = process.env.TZ || "Etc/UTC"

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
	throw new Error("HEALTHCHECK_TIMEOUT_MS debe ser un entero positivo")
}

if (!Number.isSafeInteger(testCount) || testCount < 1 || testCount > 100) {
	throw new Error("CRON_TEST_COUNT debe ser un entero entre 1 y 100")
}

if (!new Set(["cron", "startup"]).has(testContext)) {
	throw new Error("TEST_CONTEXT debe ser 'cron' o 'startup'")
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
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} zone=${timeZone} instant=${date.toISOString()}`
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
		throw new Error(`HTTP ${response.status}`)
	}
	if (!body) return {}
	try {
		return JSON.parse(body)
	} catch {
		throw new Error("Respuesta JSON no válida")
	}
}

const resolveModel = async () => {
	if (process.env.MODEL_TEST) {
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(process.env.MODEL_TEST)) throw new Error('Identificador de modelo no válido')
		return process.env.MODEL_TEST
	}
	const models = await requestJson(`${baseUrl}/models`)
	const model = models.data?.[0]?.id
	if (!model) throw new Error("No hay ningún modelo disponible")
	if (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(model)) throw new Error('Identificador de modelo no válido')
	return model
}

const createChallenge = () => {
	switch (randomInt(4)) {
		case 0: {
			const first = randomInt(12, 100)
			const second = randomInt(11, 50)
			const subtract = randomInt(20, 250)
			return {
				expression: `(${first} × ${second}) - ${subtract}`,
				result: first * second - subtract,
			}
		}
		case 1: {
			const first = randomInt(20, 200)
			const second = randomInt(20, 200)
			const multiplier = randomInt(2, 13)
			return {
				expression: `(${first} + ${second}) × ${multiplier}`,
				result: (first + second) * multiplier,
			}
		}
		case 2: {
			const divisor = randomInt(2, 21)
			const quotient = randomInt(10, 100)
			const addend = randomInt(5, 100)
			return {
				expression: `(${divisor * quotient} ÷ ${divisor}) + ${addend}`,
				result: quotient + addend,
			}
		}
		default: {
			const base = randomInt(11, 41)
			const subtract = randomInt(1, base * base)
			return {
				expression: `(${base} × ${base}) - ${subtract}`,
				result: base * base - subtract,
			}
		}
	}
}

const createUniqueChallenge = (usedExpressions) => {
	let challenge
	do {
		challenge = createChallenge()
	} while (usedExpressions.has(challenge.expression))
	usedExpressions.add(challenge.expression)
	return challenge
}

try {
	const model = await resolveModel()
	const usedExpressions = new Set()
	for (let check = 1; check <= testCount; check += 1) {
		const challenge = createUniqueChallenge(usedExpressions)
		const result = await requestJson(`${baseUrl}/chat/completions`, {
			method: "POST",
			body: JSON.stringify({
				model,
				messages: [
					{
						role: "user",
						content: `Realiza esta comprobación internamente: calcula ${challenge.expression} y comprueba que el resultado sea ${challenge.result}. Si es correcto, responde única y exactamente con la palabra OK, en mayúsculas, sin comillas, explicaciones, puntuación ni espacios adicionales. Si no es correcto, responde ERROR.`,
					},
				],
			}),
		})
		const answer = result.choices?.[0]?.message?.content
		if (answer !== "OK") {
			throw new Error(
				`Comprobación ${check}/${testCount}: respuesta inesperada del modelo`,
			)
		}
	}
	console.log(
		`[openai-oauth][${testContext}] OK ${localTimestamp()} model=${model} checks=${testCount} response="OK"`,
	)
} catch (error) {
	console.error(
		`[openai-oauth][${testContext}] ERROR ${localTimestamp()} ${error instanceof Error ? error.message : String(error)}`,
	)
	process.exitCode = 1
}
