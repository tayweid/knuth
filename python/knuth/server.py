"""WebSocket server owning the kernel subprocess.

Clients speak the kernel's JSON protocol over ws://127.0.0.1:<port>, plus
two commands the server handles itself: `interrupt` (SIGINT to the kernel
process) and `restart` (kill and respawn — clients see a fresh `ready`).
Kernel events are broadcast to every connected client.
"""

import asyncio
import json
import os
import signal
import sys

import websockets


class KernelProcess:
    def __init__(self, on_event):
        self.on_event = on_event
        self.proc = None
        self._reader = None

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
        self._reader = asyncio.create_task(self._read_events())

    async def _read_events(self):
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            try:
                self.on_event(json.loads(line))
            except ValueError:
                continue

    async def send(self, msg):
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self.proc.stdin.drain()

    def interrupt(self):
        try:
            self.proc.send_signal(signal.SIGINT)
        except ProcessLookupError:
            pass

    async def restart(self):
        if self._reader:
            self._reader.cancel()
        try:
            self.proc.kill()
        except ProcessLookupError:
            pass
        await self.proc.wait()
        await self.start()

    def kill(self):
        if self.proc and self.proc.returncode is None:
            self.proc.kill()


async def serve(port):
    clients = set()
    kernel_ready = False

    def on_event(event):
        nonlocal kernel_ready
        if event.get("type") == "ready":
            kernel_ready = True
        websockets.broadcast(clients, json.dumps(event))

    kernel = KernelProcess(on_event)
    await kernel.start()

    async def handler(ws):
        clients.add(ws)
        try:
            # Late-joining clients still need to learn the kernel is up.
            if kernel_ready:
                await ws.send(json.dumps({"type": "ready"}))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                kind = msg.get("type")
                if kind == "interrupt":
                    kernel.interrupt()
                elif kind == "restart":
                    await kernel.restart()
                else:
                    await kernel.send(msg)
        finally:
            clients.discard(ws)

    try:
        async with websockets.serve(handler, "127.0.0.1", port):
            print(f"knuth kernel server on ws://127.0.0.1:{port}", flush=True)
            await asyncio.get_running_loop().create_future()
    finally:
        kernel.kill()


def main(port=5197):
    try:
        asyncio.run(serve(port))
    except KeyboardInterrupt:
        pass
