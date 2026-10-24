/**
 * Files on a question to Tria in the private chat (core ADR-096): the same
 * limits the core checks, so a file that cannot go is refused here with the
 * reason. The TUI and the phone share it.
 */
import { fitImage, MAX_UPLOAD } from "../state/messenger.js"

export const MAX_FILES = 4
export const MAX_TOTAL = 6 * 1024 * 1024

const BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", log: "text/plain",
  json: "application/json", yaml: "application/yaml", yml: "application/yaml", xml: "application/xml",
}
const READABLE = /^(image\/(png|jpeg|webp|heic|heif)|application\/(pdf|json|yaml|x-yaml|xml)|text\/.+)$/

/** What the browser says the file is, or what its extension says when it says nothing. */
export function mimeOf(file) {
  const t = (file.type || "").toLowerCase().split(";")[0].trim()
  if (t && t !== "application/octet-stream") return t
  return BY_EXT[(file.name || "").split(".").pop().toLowerCase()] || t
}

const base64 = (blob) => new Promise((ok, no) => {
  const r = new FileReader()
  r.onload = () => ok(String(r.result).split(",")[1] || "")
  r.onerror = () => no(r.error)
  r.readAsDataURL(blob)
})

/**
 * Turn picked files into what the chat sends: {name, mime, size, data
 * (base64), preview (a local URL for an image)}. Photos over 2 MB are shrunk.
 * Throws an Error that says why when one cannot go, with `have` files already
 * waiting.
 */
export async function prepare(files, have = []) {
  const out = []
  let total = have.reduce((n, f) => n + f.size, 0)
  if (have.length + files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files go with one question`)
  for (let file of files) {
    let mime = mimeOf(file)
    if (!READABLE.test(mime)) throw new Error(`Tria reads images, PDFs and text files, not ${file.name || "that file"}`)
    if (mime.startsWith("image/")) {
      file = await fitImage(file)
      if (!file) throw new Error("That photo could not be made small enough to send")
      mime = mimeOf(file)
    }
    if (file.size > MAX_UPLOAD) throw new Error(`${file.name} is over 2 MB`)
    if (!file.size) throw new Error(`${file.name} is empty`)
    total += file.size
    if (total > MAX_TOTAL) throw new Error("The files of one question are at most 6 MB together")
    out.push({
      name: file.name || "file", mime, size: file.size, data: await base64(file),
      preview: mime.startsWith("image/") ? URL.createObjectURL(file) : "",
    })
  }
  return out
}

/** What a sent question shows of its files in the log. */
export const shown = (files) => files.map(f => ({ name: f.name, mime: f.mime, url: f.preview, thumb: f.preview }))

/** What goes up the socket. */
export const wire = (files) => files.map(({ name, mime, data }) => ({ name, mime, data }))
