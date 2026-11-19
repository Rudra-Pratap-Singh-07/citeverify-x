"""CiteVerify-X — Local Development & Review Server

Serves the frontend reviewer interface and example fixtures with zero external npm/node dependencies.
"""

from __future__ import annotations

import http.server
import socketserver
import webbrowser
from pathlib import Path

PORT = 8080
ROOT_DIR = Path(__file__).resolve().parent.parent


class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def do_GET(self):
        # Redirect root request directly to the frontend review UI
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/frontend/index.html")
            self.end_headers()
            return
        return super().do_GET()


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), CustomHandler) as httpd:
        url = f"http://localhost:{PORT}/frontend/index.html"
        print(f"CiteVerify-X Extraction Review UI running at:")
        print(f"  --> {url}\n")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    main()
