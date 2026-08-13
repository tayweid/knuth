"""The knuth command. `knuth serve` runs the kernel server (the default);
`knuth run file.py` (Milestone 5) will be the reproducibility runner."""

import argparse

from .server import main as serve_main

DEFAULT_PORT = 5197


def main():
    parser = argparse.ArgumentParser(prog="knuth")
    sub = parser.add_subparsers(dest="command")
    serve = sub.add_parser("serve", help="run the kernel WebSocket server")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    if args.command in (None, "serve"):
        serve_main(getattr(args, "port", DEFAULT_PORT))


if __name__ == "__main__":
    main()
