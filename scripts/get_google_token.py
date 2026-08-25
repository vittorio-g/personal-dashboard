"""
Get a Google refresh token with the scopes this project needs.

Starts a local server, opens the browser once for consent, then prints the
refresh token. A refresh token's scopes are frozen at consent time, so re-run
this (editing SCOPES) whenever you need to add a permission.

Usage:
    set GOOGLE_CLIENT_ID=...        (export ... on macOS/Linux)
    set GOOGLE_CLIENT_SECRET=...
    python scripts/get_google_token.py

Then store it:   wrangler secret put GOOGLE_RT_PERSONALE
"""
import http.server, socketserver, urllib.parse, urllib.request, webbrowser, json, threading, sys, os

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID") or input("Google Client ID: ").strip()
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET") or input("Google Client Secret: ").strip()
PORT = int(os.environ.get("OAUTH_PORT", "8765"))
REDIRECT = f"http://localhost:{PORT}"

# gmail.modify   = read + mark as read/archive   (use gmail.readonly for read-only)
# calendar.events = read + create events         (use calendar.readonly for read-only)
SCOPES = " ".join([
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events",
])

result, done = {}, threading.Event()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        params = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        if "code" in params:
            result["code"] = params["code"]
            self.wfile.write(b"<h2>Done. You can close this tab.</h2>")
        else:
            result["error"] = params.get("error", "no code received")
            self.wfile.write(f"<h2>Error: {result['error']}</h2>".encode())
        done.set()

    def log_message(self, *a):
        pass


auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
    "client_id": CLIENT_ID,
    "redirect_uri": REDIRECT,
    "response_type": "code",
    "scope": SCOPES,
    "access_type": "offline",
    "prompt": "consent",      # forces a NEW refresh token to be issued
})

print("Opening the browser for consent...\n" + auth_url, flush=True)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    webbrowser.open(auth_url)
    if not done.wait(timeout=300):
        sys.exit("Timed out waiting for consent.")

if "code" not in result:
    sys.exit("Error: " + str(result.get("error")))

data = urllib.parse.urlencode({
    "code": result["code"], "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
    "redirect_uri": REDIRECT, "grant_type": "authorization_code",
}).encode()
with urllib.request.urlopen("https://oauth2.googleapis.com/token", data=data) as r:
    tok = json.load(r)

print("\nGRANTED SCOPES:", tok.get("scope"))
if tok.get("refresh_token"):
    print("\nREFRESH TOKEN (store it, it is not shown again):\n" + tok["refresh_token"])
else:
    print("No refresh_token returned:", json.dumps(tok)[:300])
