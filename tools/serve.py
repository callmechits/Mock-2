"""Local preview server: python tools/serve.py  →  http://localhost:5173

Serves web/ with correct JavaScript MIME types (Windows can map .js to text/plain,
which breaks ES modules). With SUPABASE_URL empty in web/js/config.js the site
runs in offline demo mode.
"""
import functools
import http.server
import os
import pathlib
import sys

root = sys.argv[1] if len(sys.argv) > 1 else str(pathlib.Path(__file__).resolve().parent.parent / "web")
port = int(os.environ.get("PORT") or (sys.argv[2] if len(sys.argv) > 2 else 5173))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


print(f"Serving {root} on http://localhost:{port}")
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=root)).serve_forever()
