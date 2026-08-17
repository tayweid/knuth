"""Serve the built app from the engine, on the engine's own port.

The page and the kernel socket share an origin, which is the whole point:
a secret never has to travel between them (see SAME_ORIGIN.md). This runs
inside the WebSocket server's `process_request` hook, so one port answers
both protocols and `websockets` remains the only runtime dependency.

The surface is deliberately read-only. A page from another origin can send
blind GETs here — it cannot read the responses, but it must never be able
to cause an effect with one either. Everything that executes code stays
behind the origin-checked WebSocket upgrade.
"""

import mimetypes
import posixpath
import urllib.parse
from pathlib import Path

from websockets.datastructures import Headers
from websockets.http11 import Response

# Populated by the release build (npm run build → knuth/web/). A source
# checkout without a build simply has no app to serve, and the engine still
# runs for `knuth run` and for a separately hosted frontend.
WEB_ROOT = Path(__file__).parent / "web"

INDEX = "index.html"

# mimetypes' table varies by platform and misses the manifest entirely;
# a wrong type here makes the browser refuse to install the app.
CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".otf": "font/otf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".webmanifest": "application/manifest+json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


def available(root=None):
    """Whether this install carries a built frontend."""
    return (root or WEB_ROOT).joinpath(INDEX).is_file()


def _content_type(path):
    suffix = path.suffix.lower()
    if suffix in CONTENT_TYPES:
        return CONTENT_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def _cache_control(relative):
    # Vite fingerprints everything under assets/, so those are immutable.
    # The shell must not be, or a pip upgrade would be invisible behind a
    # cached index — the service worker is network-first for the same reason.
    if relative.startswith("assets/"):
        return "public, max-age=31536000, immutable"
    return "no-cache"


def _resolve(target, root):
    """Map a request path to a file inside root, or None if it escapes."""
    path = urllib.parse.urlsplit(target).path
    path = urllib.parse.unquote(path)
    # normpath collapses ../ before we ever touch the filesystem; the
    # resolved-parents check below then catches symlinks pointing outward.
    path = posixpath.normpath(path)
    if path in {"/", ".", ""}:
        path = f"/{INDEX}"
    if not path.startswith("/") or path.startswith("//"):
        return None
    candidate = root / path.lstrip("/")
    try:
        resolved = candidate.resolve(strict=True)
        base = root.resolve(strict=True)
    except OSError:
        return None
    if resolved != base and base not in resolved.parents:
        return None
    return resolved if resolved.is_file() else None


def respond(request, root=None):
    """Return an HTTP Response for a non-WebSocket request, or None.

    None means "not ours": let the WebSocket handshake proceed.
    """
    root = root or WEB_ROOT
    # An upgrade request is the kernel socket, never a page fetch.
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None
    if not available(root):
        return None

    method = getattr(request, "method", "GET")
    if method not in {"GET", "HEAD"}:
        return _error(405, "Method Not Allowed", allow="GET, HEAD")

    resolved = _resolve(request.path, root)
    if resolved is None:
        return _error(404, "Not Found")

    body = resolved.read_bytes()
    relative = resolved.relative_to(root.resolve()).as_posix()
    headers = Headers({
        "Content-Type": _content_type(resolved),
        "Content-Length": str(len(body)),
        "Cache-Control": _cache_control(relative),
        # The app is local and self-contained; nothing should frame it or
        # sniff its types. index.html carries the full CSP.
        "X-Content-Type-Options": "nosniff",
        "Frame-Options": "DENY",
    })
    return Response(200, "OK", headers, b"" if method == "HEAD" else body)


def _error(status, phrase, allow=None):
    body = f"{status} {phrase}\n".encode()
    fields = {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": str(len(body)),
        "Cache-Control": "no-store",
    }
    if allow:
        fields["Allow"] = allow
    return Response(status, phrase, Headers(fields), body)
