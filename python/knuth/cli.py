"""The knuth command. `knuth serve` runs the kernel server in the
foreground; `knuth agent install|uninstall|status` manages it as a
background launchd service; `knuth run file.py` (Milestone 5) will be
the reproducibility runner."""

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

    args = parser.parse_args()

    if args.command == "agent":
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
