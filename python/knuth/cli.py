"""The Knuth command-line interface."""

import argparse
from pathlib import Path
import sys

from . import agent
from .server import main as serve_main

DEFAULT_PORT = 5197


def _resolve_root(path):
    """Resolve a project root, or exit before anything starts if it's unusable."""
    if path is None:
        return None
    resolved = Path(path).expanduser().resolve()
    if not resolved.is_dir():
        sys.exit(f"knuth: root does not exist or is not a directory: {resolved}")
    return str(resolved)


def _resolve_target(path):
    """`knuth app PATH`: a folder is the project root; a file is the document
    to open, and its folder is the root (APP.md). Returns (root, file)."""
    if path is None:
        return None, None
    resolved = Path(path).expanduser().resolve()
    if resolved.is_dir():
        return str(resolved), None
    if resolved.is_file():
        return str(resolved.parent), str(resolved)
    sys.exit(f"knuth: no such file or folder: {resolved}")


def main():
    parser = argparse.ArgumentParser(prog="knuth")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="run the kernel WebSocket server in the foreground")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.add_argument(
        "--grace",
        type=int,
        default=120,
        help="seconds a disconnected session stays alive for reattach (default 120)",
    )
    serve.add_argument(
        "--origin",
        action="append",
        dest="origins",
        help="exact allowed browser origin (repeatable; overrides release defaults)",
    )
    serve.add_argument(
        "--root",
        help="project root each kernel runs in (default: this process's cwd)",
    )

    app_cmd = sub.add_parser(
        "app",
        help="start the local engine and open the Knuth app it serves",
    )
    app_cmd.add_argument(
        "path",
        nargs="?",
        help="a project folder, or a document to open (its folder becomes "
        "the project root); default: this process's cwd",
    )
    app_cmd.add_argument("--port", type=int, default=DEFAULT_PORT)
    app_cmd.add_argument(
        "--grace",
        type=int,
        default=120,
        help="seconds a disconnected session stays alive for reattach (default 120)",
    )
    app_cmd.add_argument(
        "--browser",
        help="which browser to open (chrome, safari, arc, edge, brave, firefox, "
        "default, or an application name). Remembered for next time.",
    )
    app_cmd.add_argument(
        "--no-browser",
        action="store_true",
        help="start the engine without opening a browser",
    )

    agent_cmd = sub.add_parser(
        "agent",
        help="manage the optional background kernel service (macOS launchd)",
    )
    agent_cmd.add_argument(
        "action",
        choices=["install", "uninstall", "status", "restart"],
    )
    agent_cmd.add_argument("--port", type=int, default=DEFAULT_PORT)

    run_cmd = sub.add_parser(
        "run",
        help="reproduce a document: fresh session, program cells top to bottom, "
        "rewrite outputs and the folder contract",
    )
    run_cmd.add_argument("file")

    import_cmd = sub.add_parser(
        "import",
        help="convert Jupyter notebooks to percent-format .py documents "
        "(outputs dropped, magic lines commented out; never overwrites)",
    )
    import_cmd.add_argument("files", nargs="+", metavar="notebook.ipynb")

    doctor_cmd = sub.add_parser(
        "doctor",
        help="report package, engine, port, and protocol diagnostics",
    )
    doctor_cmd.add_argument("--port", type=int, default=DEFAULT_PORT)

    args = parser.parse_args()

    if args.command == "run":
        from .runner import run_file

        sys.exit(run_file(args.file))
    elif args.command == "import":
        from .ipynb import import_files

        sys.exit(import_files(args.files))
    elif args.command == "doctor":
        from .doctor import run_doctor

        return run_doctor(args.port)
    elif args.command == "app":
        from .hosted import run_hosted

        root, open_path = _resolve_target(args.path)
        sys.exit(run_hosted(
            args.port,
            args.grace,
            open_browser=not args.no_browser,
            browser=args.browser,
            root=root,
            open_path=open_path,
        ))
    elif args.command == "agent":
        if args.action == "install":
            sys.exit(agent.install(args.port))
        elif args.action == "uninstall":
            sys.exit(agent.uninstall())
        elif args.action == "status":
            sys.exit(agent.status())
        else:
            sys.exit(agent.restart())
    elif args.command == "serve":
        root = _resolve_root(args.root)
        serve_main(
            args.port,
            args.grace,
            args.origins,
            root=root,
        )
    else:
        parser.print_help()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
