"""Owner-only local configuration for the sidecar control capability."""

import os
import secrets
import stat
import sys
from pathlib import Path


CAPABILITY_BYTES = 32
CAPABILITY_CHARS = 43
CAPABILITY_FILE = "capability"
CAPABILITY_ALPHABET = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
)


def config_dir():
    """Platform config directory, overridable for isolated tests."""
    override = os.environ.get("KNUTH_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Knuth"
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        root = Path(app_data) if app_data else Path.home() / "AppData" / "Roaming"
        return root / "Knuth"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "knuth"


def capability_path():
    return config_dir() / CAPABILITY_FILE


def _prepare_dir():
    directory = config_dir()
    try:
        info = directory.lstat()
    except FileNotFoundError:
        directory.mkdir(mode=0o700, parents=True)
    else:
        if not stat.S_ISDIR(info.st_mode) or directory.is_symlink():
            raise RuntimeError(f"Knuth config path is not a directory: {directory}")
    # Windows protects the per-user roaming profile with ACL inheritance;
    # POSIX permission bits are neither authoritative nor reliably preserved.
    if os.name != "nt":
        directory.chmod(0o700)
    return directory


def _read_capability(path):
    try:
        path_info = path.lstat()
    except FileNotFoundError:
        raise
    if stat.S_ISLNK(path_info.st_mode):
        raise RuntimeError(f"Knuth capability must not be a symlink: {path}")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError(f"Knuth capability is not a regular file: {path}")
        if os.name != "nt" and stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError(f"Knuth capability permissions must be 0600: {path}")
        with os.fdopen(fd, encoding="ascii") as file:
            fd = None
            capability = file.read(256).strip()
    finally:
        if fd is not None:
            os.close(fd)
    if (
        len(capability) != CAPABILITY_CHARS
        or not set(capability).issubset(CAPABILITY_ALPHABET)
    ):
        raise RuntimeError(f"Knuth capability is invalid: {path}")
    return capability


def load_or_create_capability():
    """Return the stable per-install capability, creating it without races."""
    directory = _prepare_dir()
    path = directory / CAPABILITY_FILE
    try:
        return _read_capability(path)
    except FileNotFoundError:
        pass

    capability = secrets.token_urlsafe(CAPABILITY_BYTES)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        # Another concurrently starting agent won the creation race.
        return _read_capability(path)
    try:
        os.write(fd, (capability + "\n").encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return _read_capability(path)


def rotate_capability():
    """Atomically replace the capability and return the new value."""
    directory = _prepare_dir()
    destination = directory / CAPABILITY_FILE
    capability = secrets.token_urlsafe(CAPABILITY_BYTES)
    temporary = directory / f".{CAPABILITY_FILE}.{secrets.token_hex(8)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temporary, flags, 0o600)
    try:
        os.write(fd, (capability + "\n").encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return _read_capability(destination)
