#!/usr/bin/env python3
"""JSON command line client for the Agentic Mailbox API."""

import argparse
import getpass
import http.cookies
import json
import os
import re
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

COOKIE_NAME = "agentic_mailbox_session"
SESSION = Path(os.environ.get("AGENTIC_MAILBOX_SESSION_FILE") or (
    Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    / "agentic-mailbox" / "session.json"
)).expanduser()


class MailboxError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def origin_for(value):
    url = urllib.parse.urlsplit(value)
    local = url.hostname in ("127.0.0.1", "localhost", "::1")
    if (not url.hostname or url.username is not None or url.password is not None
            or url.path not in ("", "/") or url.query or url.fragment
            or not (url.scheme == "https" or (url.scheme == "http" and local))):
        raise MailboxError("Use an HTTPS origin or a loopback HTTP origin.")
    hostname = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
    default_port = 443 if url.scheme == "https" else 80
    port = f":{url.port}" if url.port is not None and url.port != default_port else ""
    return f"{url.scheme}://{hostname}{port}"


def request(origin, path, *, data=None, method=None, cookie=None):
    headers = {"Accept": "application/json", "Origin": origin}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(
        origin + path,
        None if data is None else json.dumps(data).encode(),
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=60) as response:
            return json.load(response), response.headers
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read(16384)).get("error", {})
        except (ValueError, AttributeError):
            payload = {}
        if error.code == 401 and cookie:
            raise MailboxError("Session expired. Sign in again with the login command.") from None
        if not isinstance(payload, dict):
            payload = {}
        detail = payload.get("message", "The server could not complete the request.")
        raise MailboxError(f"HTTP {error.code}: {detail}") from None
    except (OSError, ValueError):
        raise MailboxError("Cannot read the mailbox response. Check the instance and the last operation's result before retrying.") from None


def session_file(profile):
    if profile == "default":
        return SESSION
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}", profile):
        raise MailboxError("Use a profile name of 1 to 40 letters, digits, underscores or hyphens.")
    return SESSION.parent / "profiles" / (profile + ".json")


def save_session(origin, cookie, profile):
    target = session_file(profile)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as file:
            temporary = Path(file.name)
            json.dump({"origin": origin, "cookie": cookie}, file)
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def login(args):
    origin = origin_for(args.origin)
    password = sys.stdin.readline().rstrip("\r\n") if args.password_stdin else getpass.getpass("Mailbox password: ")
    if not password:
        raise MailboxError("A mailbox password is required.")
    data = {"password": password}
    if not args.admin:
        data["username"] = args.username
    payload, headers = request(origin, "/api/session" if args.admin else "/api/members/login", data=data)
    jar = http.cookies.SimpleCookie()
    for value in headers.get_all("Set-Cookie", []):
        jar.load(value)
    if not payload.get("authenticated") or COOKIE_NAME not in jar:
        raise MailboxError("No mailbox session was issued.")
    save_session(origin, jar[COOKIE_NAME].OutputString().split(";", 1)[0], args.profile)
    return {"authenticated": True, "user": payload.get("user"), "origin": origin}


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--profile", default="default", help="Separate forwarding service session")
    commands = root.add_subparsers(dest="command", required=True)
    auth = commands.add_parser("login")
    auth.add_argument("--origin", required=True)
    mode = auth.add_mutually_exclusive_group(required=True)
    mode.add_argument("--username")
    mode.add_argument("--admin", action="store_true")
    auth.add_argument("--password-stdin", action="store_true")
    for name in ("profiles", "logout", "status", "forwarding", "sources", "cancel-change", "confirm-destination"):
        commands.add_parser(name)
    commands.add_parser("aliases", help="Find addresses in this instance").add_argument("--query", default="")
    create = commands.add_parser("create-alias", help="Create a hosted domain address")
    create.add_argument("local_part")
    create.add_argument("--label", default="")
    update = commands.add_parser("set-alias-status", help="Enable or disable a hosted address")
    update.add_argument("id")
    update.add_argument("status", choices=("active", "disabled"))
    for name in ("set-destination", "verify-destination"):
        commands.add_parser(name).add_argument("address")
    return root


def send_command(args, api):
    command = args.command
    if command == "status":
        return api("/api/session")
    if command == "forwarding":
        return api("/api/forwarding")
    if command == "sources":
        return api("/api/forwarding/sources")
    if command == "set-destination":
        return api("/api/forwarding/destination", method="PUT", data={"address": args.address})
    if command == "verify-destination":
        return api("/api/forwarding/verify", data={"address": args.address})
    if command == "confirm-destination":
        code = getpass.getpass("Destination confirmation code: ")
        return api("/api/forwarding/confirm", data={"code": code})
    if command == "cancel-change":
        return api("/api/forwarding/destination", method="DELETE", data={})
    if command == "aliases":
        return api("/api/aliases?" + urllib.parse.urlencode({"q": args.query, "limit": 100}))
    if command == "create-alias":
        if not args.local_part.strip():
            raise MailboxError("Supply the requested local part.")
        return api("/api/aliases", data={"localPart": args.local_part, "label": args.label})
    if command == "set-alias-status":
        if args.id in ("", ".", ".."):
            raise MailboxError("A mailbox alias ID is required.")
        return api("/api/aliases/" + urllib.parse.quote(args.id, safe=""), method="PATCH", data={"status": args.status})
    raise MailboxError("Unknown mailbox command.")


def authenticated_api(profile="default"):
    target = session_file(profile)
    if not target.exists():
        raise MailboxError("Sign in to Agentic Mailbox in your own terminal using the bundled login command.")
    try:
        session = json.loads(target.read_text())
        origin = origin_for(session["origin"])
        cookie = session["cookie"]
    except (KeyError, OSError, TypeError, ValueError):
        raise MailboxError("Cannot read the saved mailbox session. Sign in again.") from None
    return lambda path, **kwargs: request(origin, path, cookie=cookie, **kwargs)[0]


def main():
    args = parser().parse_args()
    try:
        if args.command == "profiles":
            directory = SESSION.parent / "profiles"
            profiles = ["default"] if SESSION.is_file() else []
            profiles.extend(sorted(path.stem for path in directory.glob("*.json") if path.is_file()))
            result = {"profiles": profiles}
        elif args.command == "login":
            result = login(args)
        elif args.command == "logout":
            session_file(args.profile).unlink(missing_ok=True)
            result = {"authenticated": False}
        else:
            result = send_command(args, authenticated_api(args.profile))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (MailboxError, OSError, ValueError, KeyError, TypeError) as error:
        print(str(error) if isinstance(error, MailboxError) else "Cannot read the command input or saved session.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
