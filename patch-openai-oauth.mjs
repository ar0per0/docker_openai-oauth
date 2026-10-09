import { readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { prepareSafety } from './safety-patch.mjs'

export const originalImageBlock = `    if (item.type === "image_url" && isRecord(item.image_url) && typeof item.image_url.url === "string") {
      try {
        parts.push({ type: "image", image: new URL(item.image_url.url) });
      } catch {
      }
    }`

export const patchedImageBlock = `    if (item.type === "image_url" && isRecord(item.image_url) && typeof item.image_url.url === "string") {
      const imageUrl = item.image_url.url;
      const dataUrlMatch = /^data:(image\\/[^;,]+);base64,([A-Za-z0-9+/=\\r\\n]+)$/i.exec(imageUrl);
      if (dataUrlMatch) {
        parts.push({
          type: "image",
          image: dataUrlMatch[2].replace(/\\s/g, ""),
          mediaType: dataUrlMatch[1]
        });
        continue;
      }
      try {
        parts.push({ type: "image", image: new URL(imageUrl) });
      } catch {
      }
    }`

export const originalUsageBlock = `  prompt_tokens: usage.inputTokens ?? 0,
  completion_tokens: usage.outputTokens ?? 0,
  total_tokens: usage.totalTokens ?? 0,`
export const patchedUsageBlock = `  prompt_tokens: usage.inputTokens ?? null,
  completion_tokens: usage.outputTokens ?? null,
  total_tokens: usage.totalTokens ?? null,`

export const originalAuthAnchor = "  const auth = openaiCredentials(settings);"
export const patchedAuthAnchor = `${originalAuthAnchor}
  const readOAuthRateLimits = (request) => handleOAuthRateLimits(request, auth, { fetch: settings.fetch });`
export const originalRouteAnchor = "  const handler = async (request) => {\n    try {"
export const patchedRouteAnchor = `${originalRouteAnchor}
      if (new URL(request.url).pathname === "/oauth/rate-limits") {
        return await readOAuthRateLimits(request);
      }`
export const rateLimitsImport = 'import { handleOAuthRateLimits } from "./oauth-rate-limits.mjs";\n'

export const patchOpenAIOAuth = (packageRoot) => {
	const metadata = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
	if (metadata.name !== "openai-oauth" || metadata.version !== "2.0.0") throw new Error("Se requiere openai-oauth npm 2.0.0 exacto")
	const candidates = readdirSync(resolve(packageRoot, "dist"))
		.filter((name) => /^chunk-.*\.js$/.test(name))
		.map((name) => resolve(packageRoot, "dist", name))
	const pairs = [[originalUsageBlock, patchedUsageBlock], [originalImageBlock, patchedImageBlock], [originalAuthAnchor, patchedAuthAnchor], [originalRouteAnchor, patchedRouteAnchor]]
	const matches = candidates.filter((file) => {
		const text = readFileSync(file, "utf8")
		return pairs.every(([original, patched]) => text.includes(original) || text.includes(patched))
	})
	if (matches.length !== 1) throw new Error(`Se esperaba exactamente un chunk compatible y se encontraron ${matches.length}`)
	const target = matches[0]
	let source = readFileSync(target, "utf8")
	// Validate every anchor before any write; accept the old image-only patch.
	for (const [original, patched] of pairs) {
		const pattern = source.includes(patched) ? patched : original
		if (source.split(pattern).length !== 2 || (source.includes(patched) && source.replace(patched, "").includes(original))) throw new Error("Bloque ambiguo o incompatible")
		if (!source.includes(patched)) source = source.replace(original, patched)
	}
	if (source.split(rateLimitsImport).length > 2) throw new Error("Import duplicado")
	if (!source.includes(rateLimitsImport)) source = rateLimitsImport + source
	// After all anchors validate, replace the helper too: upgrades the previous
	// key-gated endpoint without changing its route or the shared OAuth session.
	const safety = prepareSafety(packageRoot, source)
	for (const [file, text] of safety.writes) writeFileSync(file, text)
	for (const directory of [resolve(packageRoot, 'dist'), resolve(packageRoot, 'node_modules/@openai-oauth/local/dist'), resolve(packageRoot, 'node_modules/@openai-oauth/core/dist')]) {
		copyFileSync(new URL('./runtime-safety.mjs', import.meta.url), resolve(directory, 'runtime-safety.mjs'))
	}
	copyFileSync(new URL("./oauth-rate-limits.mjs", import.meta.url), resolve(packageRoot, "dist", "oauth-rate-limits.mjs"))
	writeFileSync(target, safety.source)
	return target
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (import.meta.url === invokedPath) {
	const packageRoot = process.argv[2]
	if (!packageRoot) {
		console.error("Uso: node patch-openai-oauth.mjs <directorio-del-paquete>")
		process.exit(2)
	}
	const target = patchOpenAIOAuth(packageRoot)
	console.log(`[openai-oauth] Parches imágenes y /oauth/rate-limits aplicados en ${target}`)
}
