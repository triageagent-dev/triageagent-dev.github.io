#!/bin/sh
# Copies the TUI and the mobile app from ../ui/public into demo/ and points
# them at the sample data (demo/fixtures.js + demo/shim.js) instead of a core.
# Run again after the UI changes.
set -eu
cd "$(dirname "$0")"
src=../ui/public
rm -rf demo/tui demo/mobile
cp -R "$src/tui" demo/tui
cp -R "$src/mobile" demo/mobile
rm -f demo/mobile/package.json demo/mobile/*.test.js
cp ../ui/public/triage-logo.svg demo/triage-logo.svg
printf 'demo\n' > demo/version.txt
find demo -name '*.test.js' -delete
python3 - <<'PY'
import re
def patch(path, drop):
    s = open(path).read()
    for d in drop:
        s = re.sub(r'[ \t]*<script[^>]*src="%s"[^>]*></script>\n?' % re.escape(d), '', s)
    s = re.sub(r'<link rel="manifest"[^>]*>\n?', '', s)
    s = re.sub(r'[ \t]*<link rel="preload"[^>]*jetbrains-mono[^>]*>\n?', '', s)
    s = re.sub(r'(<meta charset="utf-8">\n)', r'\1<script src="../fixtures.js"></script>\n<script src="../shim.js"></script>\n', s, count=1)
    open(path, 'w').write(s)
def sub(path, old, new):
    t = open(path).read()
    assert old in t, (path, old)
    open(path, "w").write(t.replace(old, new, 1))
# Sign-out does nothing in the demo (no session to end, no error page).
sub("demo/mobile/state/store.js", "  async signOut() {\n", "  async signOut() {\n    if (window.TriageDemo) return\n")
sub("demo/tui/app.js", "async function logout() {\n  S.logoutConfirm = false;\n", "async function logout() {\n  S.logoutConfirm = false;\n  if (window.TriageDemo) { render(); return; }\n")
patch("demo/tui/index.html", ["./phone-redirect.js"])
patch("demo/mobile/index.html", ["./sw-register.js"])
# No encryption in the demo: the engine never starts, so the 8 MB crypto library (deleted below) is never fetched.
sub("demo/mobile/state/e2ee-app.js",
    '    const E = await import("../vendor/matrix-crypto/index.js")\n    await E.initAsync()\n    return E\n',
    '    throw new Error("The demo has no encryption")\n')
sub("demo/mobile/state/e2ee-app.js", "export { deviceName }\n",
    "export { deviceName }\nif (window.TriageDemo) e2ee.start = async () => {}\n")
PY
rm -rf demo/mobile/vendor/matrix-crypto
echo "demo synced"
