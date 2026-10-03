import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"

const healthcheckPath = new URL("../healthcheck.mjs", import.meta.url)

const runHealthcheck = async ({ port, count, context = "cron" }) => {
	const child = spawn(process.execPath, [healthcheckPath.pathname], {
		env: {
			...process.env,
			PORT: String(port),
			MODEL_TEST: "test-model",
			CRON_TEST_COUNT: String(count),
			TEST_CONTEXT: context,
			HEALTHCHECK_TIMEOUT_MS: "2000",
			TZ: "Europe/Madrid",
		},
		stdio: ["ignore", "pipe", "pipe"],
	})

	let stdout = ""
	let stderr = ""
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk
	})
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		stderr += chunk
	})

	const [code] = await once(child, "close")
	return { code, stdout, stderr }
}

const withMockServer = async (answers, callback) => {
	let requests = 0
	const prompts = []
	const server = createServer((request, response) => {
		requests += 1
		const requestNumber = requests
		let body = ""
		request.setEncoding("utf8")
		request.on("data", (chunk) => {
			body += chunk
		})
		request.on("end", () => {
			const payload = JSON.parse(body)
			prompts.push(payload.messages?.[0]?.content)
			const answer = answers[Math.min(requestNumber - 1, answers.length - 1)]
			response.writeHead(200, { "content-type": "application/json" })
			response.end(
				JSON.stringify({ choices: [{ message: { content: answer } }] }),
			)
		})
	})

	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	try {
		const address = server.address()
		return await callback({
			port: address.port,
			getRequests: () => requests,
			getPrompts: () => prompts,
		})
	} finally {
		server.close()
		await once(server, "close")
	}
}

test("solo registra OK después de completar todas las comprobaciones", async () => {
	await withMockServer(["OK"], async ({ port, getRequests, getPrompts }) => {
		const result = await runHealthcheck({ port, count: 3 })

		assert.equal(result.code, 0)
		assert.equal(getRequests(), 3)
		assert.equal(new Set(getPrompts()).size, 3)
		for (const prompt of getPrompts()) {
			assert.match(prompt, /calcula .+ y comprueba que el resultado sea -?\d+/)
			assert.match(prompt, /responde única y exactamente con la palabra OK/)
		}
		assert.match(result.stdout, /checks=3 response="OK"/)
		assert.equal(result.stderr, "")
	})
})

test("detiene la serie y registra ERROR ante el primer resultado incorrecto", async () => {
	await withMockServer(["OK", "ERROR", "OK"], async ({ port, getRequests }) => {
		const result = await runHealthcheck({ port, count: 3 })

		assert.equal(result.code, 1)
		assert.equal(getRequests(), 2)
		assert.equal(result.stdout, "")
		assert.match(result.stderr, /Comprobación 2\/3/)
		assert.match(result.stderr, /respuesta inesperada del modelo: "ERROR"/)
	})
})

test("rechaza cantidades fuera del intervalo permitido", async () => {
	const result = await runHealthcheck({ port: 1, count: 0 })

	assert.notEqual(result.code, 0)
	assert.match(result.stderr, /CRON_TEST_COUNT debe ser un entero entre 1 y 100/)
})

test("identifica separadamente una comprobación ejecutada al inicio", async () => {
	await withMockServer(["OK"], async ({ port }) => {
		const result = await runHealthcheck({ port, count: 1, context: "startup" })

		assert.equal(result.code, 0)
		assert.match(result.stdout, /^\[openai-oauth\]\[startup\] OK /)
		assert.doesNotMatch(result.stdout, /\[cron\]/)
	})
})
