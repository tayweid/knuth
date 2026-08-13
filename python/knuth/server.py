"""WebSocket server: one kernel subprocess PER CONNECTION.

Every window/document gets its own fresh session — no state bleeding
between documents or page loads, and closing the window ends its session.
`interrupt` (SIGINT) and `restart` (kill + respawn, fresh `ready`) act on
this connection's kernel only; every other message is forwarded verbatim,
and kernel events stream straight back to the owning client.
"""

import asyncio
import json
import os
import signal
import sys

import websockets


class KernelProcess:
    def __init__(self):
        self.proc = None

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-u",
            "-m",
            "knuth.kernel",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            # Headless matplotlib: no GUI windows from a background service,
            # and SVG rendering works in any context.
            env={"MPLBACKEND": "Agg", **os.environ},
        )

    async def send(self, msg):
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self.proc.stdin.drain()

    def interrupt(self):
        try:
            self.proc.send_signal(signal.SIGINT)
        except ProcessLookupError:
            pass

    def kill(self):
        if self.proc and self.proc.returncode is None:
            self.proc.kill()

    async def stop(self):
        self.kill()
        if self.proc:
            await self.proc.wait()


async def _pump(kernel, ws):
    """Forward this kernel's event lines to its client."""
    while True:
        line = await kernel.proc.stdout.readline()
        if not line:
            break
        try:
            await ws.send(line.decode())
        except websockets.exceptions.ConnectionClosed:
            break


async def serve(port):
    async def handler(ws):
        kernel = KernelProcess()
        await kernel.start()
        pump_task = asyncio.create_task(_pump(kernel, ws))
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                kind = msg.get("type")
                if kind == "interrupt":
                    kernel.interrupt()
                elif kind == "restart":
                    pump_task.cancel()
                    await kernel.stop()
                    await kernel.start()
                    pump_task = asyncio.create_task(_pump(kernel, ws))
                else:
                    await kernel.send(msg)
        finally:
            pump_task.cancel()
            kernel.kill()

    async with websockets.serve(handler, "127.0.0.1", port):
        print(f"knuth kernel server on ws://127.0.0.1:{port} (one session per window)", flush=True)
        await asyncio.get_running_loop().create_future()


def main(port=5197):
    try:
        asyncio.run(serve(port))
    except KeyboardInterrupt:
        pass
