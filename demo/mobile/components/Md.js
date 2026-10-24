import { html } from "../vendor/preact-htm.js"
import { markdown } from "../model/markdown.js"

/** Tria's text as Markdown (model/markdown.js escapes it first). */
export const Md = ({ text }) => html`<div class="md" dangerouslySetInnerHTML=${{ __html: markdown(text) }} />`
