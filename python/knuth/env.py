"""The document's environment: a PEP 723 header, built and run by uv.

The header is the truth (ENVIRONMENT.md). This module reads it, creates it
for a new document, asks uv for the environment it describes, and makes the
kernel and `knuth run` execute on that environment's interpreter. Every
write to an existing header goes through `uv add`, never through string
edits here, so the file looks exactly as a terminal user's would.

Standard library only, on purpose: the kernel imports this inside the
document's own environment, where nothing else of the engine's exists, and
the browser kernel loads the pure functions (`find_header`, `header_lines`,
`parse_header`) into Pyodide.
"""

import ast
import datetime
import hashlib
import importlib
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

HEADER_OPEN = "# /// script"
HEADER_CLOSE = "# ///"

# uv is asked to use only the Pythons it manages itself, so a document runs
# on the same interpreter build on every machine and nothing on the machine
# (Anaconda, Homebrew, python.org) is touched or relied on.
UV_ENVIRON = {
    "UV_PYTHON_PREFERENCE": "only-managed",
    "UV_NO_PROGRESS": "1",
}

# Environment variables the server sets for a kernel it started in a
# document's environment, and the kernel reads.
DOCUMENT_VAR = "KNUTH_DOCUMENT"
UV_VAR = "KNUTH_UV"
IN_ENVIRONMENT_VAR = "KNUTH_IN_ENVIRONMENT"

# Import names that differ from the distribution that provides them. Anything
# not listed is assumed to share its name, which is the common case.
DISTRIBUTIONS = {
    "PIL": "pillow",
    "bs4": "beautifulsoup4",
    "cv2": "opencv-python",
    "Crypto": "pycryptodome",
    "dateutil": "python-dateutil",
    "docx": "python-docx",
    "dotenv": "python-dotenv",
    "fitz": "pymupdf",
    "gi": "PyGObject",
    "google.protobuf": "protobuf",
    "jwt": "pyjwt",
    "Levenshtein": "python-Levenshtein",
    "magic": "python-magic",
    "nacl": "pynacl",
    "OpenSSL": "pyopenssl",
    "pptx": "python-pptx",
    "serial": "pyserial",
    "skimage": "scikit-image",
    "sklearn": "scikit-learn",
    "usb": "pyusb",
    "wx": "wxPython",
    "yaml": "pyyaml",
    "zmq": "pyzmq",
}

MAX_REASON_CHARS = 600


# --- the header -------------------------------------------------------------


def _is_comment(line):
    return line == "#" or line.startswith("# ")


def find_header(text):
    """(first, last) line indexes of the PEP 723 block, inclusive, or None.

    The block opens at `# /// script` and closes at the last `# ///` inside
    the same run of comment lines, as the standard's reference regex does.
    """
    lines = [line.rstrip("\r") for line in text.split("\n")]
    for start, line in enumerate(lines):
        if line != HEADER_OPEN:
            continue
        end = None
        for index in range(start + 1, len(lines)):
            if not _is_comment(lines[index]):
                break
            if lines[index] == HEADER_CLOSE:
                end = index
        if end is not None:
            return start, end
    return None


def header_lines(text):
    """The header block's lines, or None when the document has none."""
    span = find_header(text)
    if span is None:
        return None
    return [line.rstrip("\r") for line in text.split("\n")[span[0] : span[1] + 1]]


def parse_header(text):
    """The header as data: requires_python, dependencies, exclude_newer.

    None when there is no header. A header whose TOML does not parse comes
    back with an `error` and empty fields, so a caller can still report it.
    """
    lines = header_lines(text)
    if lines is None:
        return None
    body = "\n".join(
        line[2:] if line.startswith("# ") else "" for line in lines[1:-1]
    )
    result = {"requires_python": None, "dependencies": [], "exclude_newer": None}
    try:
        data = tomllib.loads(body)
    except tomllib.TOMLDecodeError as exc:
        result["error"] = f"environment header is not valid TOML: {exc}"
        return result
    requires = data.get("requires-python")
    if isinstance(requires, str):
        result["requires_python"] = requires
    dependencies = data.get("dependencies")
    if isinstance(dependencies, list):
        result["dependencies"] = [d for d in dependencies if isinstance(d, str)]
    uv = data.get("tool", {}).get("uv", {}) if isinstance(data.get("tool"), dict) else {}
    stamp = uv.get("exclude-newer") if isinstance(uv, dict) else None
    if isinstance(stamp, str):
        result["exclude_newer"] = stamp
    return result


# A requirement's leading project name and optional extras (PEP 508).
_REQUIREMENT = re.compile(r"^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$")
def _requirement_parts(spec):
    """(name, extras, rest) of a requirement string; rest is the specifier
    and any marker. Unparseable strings sort last and are never replaced."""
    match = _REQUIREMENT.match(spec)
    if not match:
        return "", "", spec
    return match.group(1), match.group(2) or "", match.group(3)


def stamp_today():
    """Midnight UTC today: the date after which the resolver sees nothing."""
    today = datetime.datetime.now(datetime.timezone.utc).date()
    return f"{today.isoformat()}T00:00:00Z"


def stamp_now():
    """This second, UTC: a package added now comes at its newest version."""
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    return now.strftime("%Y-%m-%dT%H:%M:%SZ")


# The header's date line, `# exclude-newer = "..."`, value replaced whole.
_EXCLUDE_NEWER = re.compile(r'^(#\s*exclude-newer\s*=\s*)"[^"\n]*"', re.MULTILINE)


def default_requires_python():
    """The engine's own minor version as a floor, never below Knuth's own."""
    minor = max(sys.version_info.minor, 11)
    return f">=3.{minor}"


def new_header(requires_python=None, stamp=None):
    """The header a new document gets: no packages, a floor, and the stamp.

    Formatted exactly as `uv init --script` writes it, so a later `uv add`
    changes only the lines it must.
    """
    return [
        HEADER_OPEN,
        f'# requires-python = "{requires_python or default_requires_python()}"',
        "# dependencies = []",
        "#",
        "# [tool.uv]",
        f'# exclude-newer = "{stamp or stamp_today()}"',
        HEADER_CLOSE,
    ]


def with_header(text, requires_python=None, stamp=None):
    """(text, header lines) with a fresh header prepended; (text, None) when
    the document already has one. The existing text is untouched below the
    blank line that separates the header from it."""
    if find_header(text) is not None:
        return text, None
    lines = new_header(requires_python, stamp)
    # A CRLF document stays CRLF throughout (files.py keeps bytes as given).
    eol = "\r\n" if "\r\n" in text else "\n"
    header = eol.join(lines) + eol
    if text == "":
        return header, lines
    return header + eol + text, lines


# --- uv ---------------------------------------------------------------------


def find_uv():
    """The uv binary: $KNUTH_UV, then beside our interpreter, then on PATH."""
    named = os.environ.get(UV_VAR)
    if named and os.path.isfile(named):
        return named
    suffix = ".exe" if sys.platform == "win32" else ""
    sibling = Path(sys.executable).resolve().parent / f"uv{suffix}"
    if sibling.is_file():
        return str(sibling)
    return shutil.which("uv")


def uv_version(uv=None):
    uv = uv or find_uv()
    if not uv:
        return None
    try:
        result = subprocess.run(
            [uv, "--version"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def _uv_environ():
    environ = dict(os.environ)
    for key, value in UV_ENVIRON.items():
        environ.setdefault(key, value)
    return environ


def run_uv(args, cwd=None, on_progress=None):
    """Run uv with Knuth's policy environment; never raises for uv's own
    failures (a nonzero return code carries them), only when uv is absent.

    `on_progress` hears each step uv reports as it happens ("Downloading
    scipy (33.1MiB)"), so a long build is never an opaque spinner (Taylor,
    2026-09-27). uv writes those to stderr, one line per step."""
    uv = find_uv()
    if not uv:
        raise FileNotFoundError("uv is not installed")
    if on_progress is None:
        return subprocess.run(
            [uv, *args], capture_output=True, text=True, cwd=cwd, env=_uv_environ()
        )
    process = subprocess.Popen(
        [uv, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        cwd=cwd, env=_uv_environ(),
    )
    stdout = []
    reader = threading.Thread(target=lambda: stdout.append(process.stdout.read()), daemon=True)
    reader.start()
    stderr = []
    for line in process.stderr:
        stderr.append(line)
        step = progress_step(line)
        if step:
            on_progress(step)
    process.wait()
    reader.join()
    return subprocess.CompletedProcess(process.args, process.returncode, "".join(stdout), "".join(stderr))


def progress_step(line):
    """A line of uv's worth showing, or None: its steps, not the per-package
    list (`+ numpy==2.5.3`) it prints at the end."""
    line = line.strip()
    if line.startswith("Creating script environment"):
        return "Creating the environment"  # not the cache path it names
    if not line or line[0] in "+-~" or len(line) > MAX_REASON_CHARS:
        return None
    return line


def _reason(result, fallback):
    """The useful part of uv's stderr, bounded, for a user-facing event."""
    lines = [line.rstrip() for line in result.stderr.splitlines() if line.strip()]
    lines = [line for line in lines if not line.startswith(("Creating", "Resolved", "Prepared", "Installed", "Uninstalled", "Audited"))]
    text = "\n".join(lines).strip() or fallback
    if len(text) > MAX_REASON_CHARS:
        text = text[: MAX_REASON_CHARS - 1] + "…"
    return text


# --- the environment --------------------------------------------------------


@dataclass
class Environment:
    """Where a document's kernel runs. `managed` means the document's own
    uv environment; otherwise `python` is the engine's interpreter and
    `reason` says why."""

    document: str | None
    python: str
    managed: bool
    reason: str | None = None

    def event(self):
        event = {
            "type": "environment",
            "document": self.document,
            "state": "ready" if self.managed else "fallback",
            "python": self.python,
            "managed": self.managed,
        }
        if self.reason:
            event["reason"] = self.reason
        return event


def _fallback(document, reason):
    return Environment(document, sys.executable, False, reason)


def _read(document):
    try:
        return Path(document).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def is_candidate(document):
    """Cheaply: would ensure_environment have uv work to do for this document?
    (A header, and a uv to build it with.) The server sends `syncing` on
    yes, so the page can say why the kernel is slow to appear."""
    if not document:
        return False
    text = _read(document)
    return text is not None and find_header(text) is not None and find_uv() is not None


def ensure_environment(document, on_progress=None):
    """Build or refresh the document's environment and name its interpreter.

    Blocking, possibly for minutes the first time (uv may download a Python).
    Never raises: every failure is a fallback to the engine's interpreter
    with a reason the page can show.
    """
    if not document:
        return _fallback(None, "no document")
    document = str(document)
    text = _read(document)
    if text is None:
        return _fallback(document, "the document could not be read")
    if find_header(text) is None:
        return _fallback(document, "no environment header")
    if find_uv() is None:
        return _fallback(document, "uv is not installed")
    folder = str(Path(document).parent)
    try:
        synced = run_uv(["sync", "--script", document], cwd=folder, on_progress=on_progress)
        if synced.returncode != 0:
            return _fallback(document, _reason(synced, "uv could not build the environment"))
        found = run_uv(["python", "find", "--script", document], cwd=folder)
    except (OSError, subprocess.SubprocessError) as exc:
        return _fallback(document, f"uv could not run: {exc}")
    if found.returncode != 0:
        return _fallback(document, _reason(found, "uv could not find the environment"))
    python = found.stdout.strip().splitlines()[-1] if found.stdout.strip() else ""
    if not python or not os.path.exists(python):
        return _fallback(document, "uv did not report an interpreter")
    return Environment(document, python, True)


def same_interpreter(python):
    try:
        return os.path.samefile(python, sys.executable)
    except OSError:
        return False


# --- reaching the kernel code from another interpreter ---------------------


def shim_dir():
    """A directory holding a `knuth` package that forwards to this one.

    Put on PYTHONPATH for a kernel started in a document's environment, it
    exposes exactly one extra package — Knuth's own — and nothing else from
    the engine's site-packages, which would otherwise leak every package
    the engine happens to have into every document.
    """
    real = Path(__file__).resolve().parent
    key = hashlib.sha256(str(real).encode("utf-8")).hexdigest()[:12]
    base = Path(tempfile.gettempdir()) / f"knuth-shim-{key}"
    package = base / "knuth"
    init = package / "__init__.py"
    wanted = f"__path__ = [{str(real)!r}]\n"
    try:
        if init.is_file() and init.read_text(encoding="utf-8") == wanted:
            return str(base)
        package.mkdir(parents=True, exist_ok=True)
        staged = package / f".__init__.{os.getpid()}.tmp"
        staged.write_text(wanted, encoding="utf-8")
        os.replace(staged, init)
    except OSError:
        # Last resort: the real package's parent. Correct, less isolated.
        return str(real.parent)
    return str(base)


def kernel_environ(environment=None):
    """The environment variables for a kernel process (or a re-executed
    `knuth run`): headless matplotlib always; in a managed environment also
    the shim on PYTHONPATH, the document, and the uv to install with."""
    environ = {**os.environ, "MPLBACKEND": "Agg", TOOLS_VAR: str(tools_dir())}
    if environment is None or not environment.managed:
        return environ
    path = shim_dir()
    existing = environ.get("PYTHONPATH")
    environ["PYTHONPATH"] = path if not existing else path + os.pathsep + existing
    environ[DOCUMENT_VAR] = environment.document
    uv = find_uv()
    if uv:
        environ[UV_VAR] = uv
    for key, value in UV_ENVIRON.items():
        environ.setdefault(key, value)
    return environ


# --- import installs --------------------------------------------------------


def _importable(name):
    if name in sys.modules:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, AttributeError):
        # A finder that cannot answer is not a reason to install anything.
        return True


def missing_imports(code):
    """Top-level names a cell imports absolutely that are neither in the
    standard library nor importable now, in first-seen order."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    stdlib = getattr(sys, "stdlib_module_names", frozenset()) | frozenset(sys.builtin_module_names)
    seen = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        else:
            continue
        for dotted in names:
            top = dotted.split(".")[0]
            if not top or top in stdlib or top in seen or top == "__future__":
                continue
            if _importable(top):
                continue
            seen.append(top)
    return seen


def distribution_for(module):
    return DISTRIBUTIONS.get(module, module)


def import_name_hint(module):
    """When `module` is a package's name spelled as an import (`import
    scikitlearn`, `import pillow`) and that package imports as something
    else, the words to say so; otherwise None. Nothing to download: the
    import itself is what is wrong."""
    squashed = re.sub(r"[-_.]", "", module).lower()
    for name, distribution in DISTRIBUTIONS.items():
        if re.sub(r"[-_.]", "", distribution).lower() == squashed and name != module:
            return f"it's {distribution}, which is imported as {name}"
    return None


def _normalize(name):
    return name.lower().replace("_", "-").replace(".", "-")


def pinned_version(text, distribution):
    """The `==` version the header pins `distribution` to, or None."""
    header = parse_header(text) or {}
    wanted = _normalize(distribution)
    for spec in header.get("dependencies", []):
        name, _extras, rest = _requirement_parts(spec)
        version, _semicolon, _marker = rest.partition(";")
        if name and _normalize(name) == wanted and version.strip().startswith("=="):
            return version.strip()[2:].strip()
    return None


def add_dependency(document, distribution, offline=False, on_progress=None):
    """`uv add --script --bounds exact`, then sync: the header gains an exact
    pin and the environment gains the package. (ok, reason).

    The header's date moves to now first, so the package comes at its
    newest version; everything already listed is pinned exactly, so
    nothing else moves. `offline`: only what uv already has on this Mac,
    never a download (Taylor, 2026-09-27: using a downloaded package
    needs no permission, downloading does). A failure leaves the file as
    it was, date included."""
    folder = str(Path(document).parent)
    before = _read(document)
    if before is not None:
        moved = _EXCLUDE_NEWER.sub(lambda m: f'{m.group(1)}"{stamp_now()}"', before, count=1)
        if moved != before:
            Path(document).write_text(moved, encoding="utf-8")
    network = ["--offline"] if offline else []

    def undo():
        if before is not None:
            Path(document).write_text(before, encoding="utf-8")

    try:
        added = run_uv(
            ["add", *network, "--script", document, "--bounds", "exact", distribution],
            cwd=folder, on_progress=on_progress,
        )
        if added.returncode != 0:
            undo()
            if not offline and "not found in the package registry" in added.stderr:
                # uv's resolver prose is a paragraph; the fact is one line.
                return False, f"there's no package named {distribution} on PyPI. Check the import's spelling"
            return False, _reason(added, f"uv could not add {distribution}")
        synced = run_uv(["sync", *network, "--script", document], cwd=folder, on_progress=on_progress)
    except (OSError, subprocess.SubprocessError) as exc:
        undo()
        return False, f"uv could not run: {exc}"
    if synced.returncode != 0:
        undo()
        return False, _reason(synced, f"uv could not install {distribution}")
    return True, None


def declare_imports(code, document, emit, request_id):
    """After a clean run: every package the cell imports that is installed
    but not listed in the header gets listed, pinned to the version already
    installed. `import pandas` arrives with seaborn and never fails, so
    without this it would never reach the header, and the document would
    depend on it silently (Taylor, 2026-09-27). No download and no install:
    `uv add --offline` only writes what is already there. Emits `header`
    when the header changed."""
    import importlib.metadata as metadata

    text = _read(document)
    header = parse_header(text) if text is not None else None
    if not header or header.get("error"):
        return False
    listed = {_normalize(_requirement_parts(spec)[0]) for spec in header["dependencies"]}
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    stdlib = getattr(sys, "stdlib_module_names", frozenset()) | frozenset(sys.builtin_module_names)
    provided = metadata.packages_distributions()
    pins = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        else:
            continue
        for dotted in names:
            top = dotted.split(".")[0]
            if not top or top in stdlib or top == "knuth":
                continue
            for distribution in provided.get(top, [])[:1]:  # a local module has none
                key = _normalize(distribution)
                if key in listed:
                    continue
                try:
                    version = metadata.version(distribution)
                except metadata.PackageNotFoundError:
                    continue
                listed.add(key)
                pins.append(f"{key}=={version}")
    if not pins:
        return False
    try:
        added = run_uv(
            ["add", "--script", document, "--bounds", "exact", "--offline", *pins],
            cwd=str(Path(document).parent),
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if added.returncode != 0:
        return False
    text = _read(document)
    lines = header_lines(text) if text is not None else None
    if lines is None:
        return False
    try:
        modified = int(os.stat(document).st_mtime * 1000)
    except OSError:
        modified = int(time.time() * 1000)
    emit({"type": "header", "id": request_id, "path": document, "lines": lines, "modified": modified})
    return True


TOOLS_VAR = "KNUTH_TOOLS"


def tools_dir():
    """Where the engine keeps what the kernel uses but documents never list:
    Jedi, for code hints (knuth.complete). Beside the preferences, installed
    once, and appended to a kernel's path only when a completion asks."""
    from . import state

    return state.state_dir() / "tools"


def ensure_tools():
    """Install Jedi into tools_dir() if it is not there: pure Python, one
    download, shared by every environment. Never raises; code hints fall
    back to the standard library's completer until it is in place."""
    target = tools_dir()
    if (target / "jedi").is_dir() or find_uv() is None:
        return False
    try:
        result = run_uv(["pip", "install", "--target", str(target), "--python", sys.executable, "jedi"])
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0
