import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
	originalImageBlock,
	patchOpenAIOAuth,
	patchedImageBlock,
} from "../patch-openai-oauth.mjs"

const withFixture = async (callback) => {
	const root = await mkdtemp(join(tmpdir(), "openai-oauth-patch-"))
	const dist = join(root, "dist")
	const chunk = join(dist, "chunk-test.js")
	await mkdir(dist)
	await writeFile(chunk, `const before = true;\n${originalImageBlock}\nconst after = true;\n`)
	try {
		await callback({ root, chunk })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

test("adapta image_url data:base64 sin modificar las URL http/https", async () => {
	await withFixture(async ({ root, chunk }) => {
		assert.equal(patchOpenAIOAuth(root), chunk)
		const source = await readFile(chunk, "utf8")

		assert.doesNotMatch(source, new RegExp(originalImageBlock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
		assert.ok(source.includes(patchedImageBlock))
		assert.match(source, /data:\(image\\\/\[\^;,\]\+\);base64/)
		assert.match(source, /image: new URL\(imageUrl\)/)
		assert.match(source, /mediaType: dataUrlMatch\[1\]/)
	})
})

test("el parche es idempotente", async () => {
	await withFixture(async ({ root, chunk }) => {
		patchOpenAIOAuth(root)
		const once = await readFile(chunk, "utf8")
		assert.equal(patchOpenAIOAuth(root), chunk)
		assert.equal(await readFile(chunk, "utf8"), once)
	})
})

test("falla de forma explícita si la versión instalada ya no es compatible", async () => {
	const root = await mkdtemp(join(tmpdir(), "openai-oauth-patch-"))
	try {
		await mkdir(join(root, "dist"))
		await writeFile(join(root, "dist", "chunk-test.js"), "const incompatible = true;\n")
		assert.throws(() => patchOpenAIOAuth(root), /se encontraron 0/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
