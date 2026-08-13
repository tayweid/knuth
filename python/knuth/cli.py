"""The knuth command. `knuth run file.py` is the reproducibility runner;
`knuth serve` runs the kernel server in the foreground; `knuth agent
install|uninstall|status` manages it as a background launchd service."""

import argparse
import sys

from . import agent
from .server import main as serve_main

DEFAULT_PORT = 5197


def main():
    parser = argparse.ArgumentParser(prog="knuth")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="run the kernel WebSocket server in the foreground")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)

    agent_cmd = sub.add_parser("agent", help="manage the background kernel service (launchd)")
    agent_cmd.add_argument("action", choices=["install", "uninstall", "status"])
    agent_cmd.add_argument("--port", type=int, default=DEFAULT_PORT)

    run_cmd = sub.add_parser(
        "run",
        help="reproduce a document: fresh session, program cells top to bottom, "
        "rewrite outputs and the folder contract",
    )
    run_cmd.add_argument("file")

    args = parser.parse_args()

    if args.command == "run":
        from .runner import run_file

        sys.exit(run_file(args.file))
    elif args.command == "agent":
        if args.action == "install":
            sys.exit(agent.install(args.port))
        elif args.action == "uninstall":
            sys.exit(agent.uninstall())
        else:
            sys.exit(agent.status())
    else:
        serve_main(getattr(args, "port", DEFAULT_PORT))


if __name__ == "__main__":
    main()
