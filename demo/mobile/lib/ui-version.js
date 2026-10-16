// Replaces lib/utils BASE_PATH and UI_VERSION, which Next baked in at build
// time. Here both are runtime values.
//
// BASE_PATH: the page is served at <base>/mobile/, so the base is the path
// up to the last "/mobile".
// UI_VERSION: <base>/version.txt, the bundle's build version, which the store's
// boot() fetches; it calls setUIVersion. "dev" until then, or when the bundle
// has none.

function basePath(pathname) {
  const m = /^(.*)\/mobile(?:\/[^/]*)?$/.exec(pathname)
  return m ? m[1] : ""
}

export const BASE_PATH = typeof location !== "undefined" ? basePath(location.pathname) : ""

export let UI_VERSION = "dev"

/** Set from version.txt; ignores anything but a non-empty string. */
export function setUIVersion(v) {
  if (typeof v === "string" && v) UI_VERSION = v
}
