import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

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

export const patchOpenAIOAuth = (packageRoot) => {
	const distDirectory = resolve(packageRoot, "dist")
	const candidates = readdirSync(distDirectory)
		.filter((name) => /^chunk-.*\.js$/.test(name))
		.map((name) => resolve(distDirectory, name))

	const alreadyPatched = candidates.filter((file) =>
		readFileSync(file, "utf8").includes(patchedImageBlock),
	)
	if (alreadyPatched.length === 1) return alreadyPatched[0]
	if (alreadyPatched.length > 1) {
		throw new Error("El parche multimodal aparece en más de un chunk de openai-oauth")
	}

	const matches = candidates.filter((file) =>
		readFileSync(file, "utf8").includes(originalImageBlock),
	)
	if (matches.length !== 1) {
		throw new Error(
			`Se esperaba exactamente un bloque compatible de openai-oauth y se encontraron ${matches.length}`,
		)
	}

	const target = matches[0]
	const source = readFileSync(target, "utf8")
	const patched = source.replace(originalImageBlock, patchedImageBlock)
	if (patched === source || patched.includes(originalImageBlock)) {
		throw new Error("No se pudo aplicar completamente el parche multimodal")
	}
	writeFileSync(target, patched)
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
	console.log(`[openai-oauth] Soporte data:image base64 aplicado en ${target}`)
}
