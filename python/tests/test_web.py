"""Static serving from the engine's own port (SAME_ORIGIN.md).

The surface is read-only by design: a page from another origin can send
blind requests here, so nothing served may cause an effect, and nothing
outside the web root may be reachable.
"""

import pytest

from knuth import web


class FakeRequest:
    def __init__(self, path, method="GET", headers=None):
        self.path = path
        self.method = method
        self.headers = headers or {}


@pytest.fixture
def root(tmp_path):
    # The secret sits OUTSIDE the web root — next to it, where a traversal
    # would land if one worked.
    (tmp_path / "secret-sibling.txt").write_text("not served")
    root = tmp_path / "web"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>Knuth</title>")
    (root / "manifest.webmanifest").write_text("{}")
    (root / "assets" / "index-abc123.js").write_text("console.log(1)")
    return root


def test_root_serves_the_index(root):
    response = web.respond(FakeRequest("/"), root)
    assert response.status_code == 200
    assert response.headers["Content-Type"] == "text/html; charset=utf-8"
    assert b"<title>Knuth</title>" in response.body


def test_manifest_gets_the_type_that_makes_install_work(root):
    # A wrong type here makes the browser silently refuse to install the app,
    # and mimetypes does not know this extension on every platform.
    response = web.respond(FakeRequest("/manifest.webmanifest"), root)
    assert response.headers["Content-Type"] == "application/manifest+json"


def test_fingerprinted_assets_are_immutable_but_the_shell_is_not(root):
    asset = web.respond(FakeRequest("/assets/index-abc123.js"), root)
    assert "immutable" in asset.headers["Cache-Control"]
    shell = web.respond(FakeRequest("/"), root)
    assert shell.headers["Cache-Control"] == "no-cache", (
        "a cached shell would hide a pip upgrade"
    )


@pytest.mark.parametrize("target", [
    "/../secret-sibling.txt",
    "/../../etc/passwd",
    "/%2e%2e/secret-sibling.txt",
    "/assets/../../secret-sibling.txt",
    "//etc/passwd",
])
def test_paths_cannot_escape_the_web_root(root, target):
    response = web.respond(FakeRequest(target), root)
    assert response.status_code == 404, target


def test_symlinks_out_of_the_root_are_refused(root, tmp_path):
    outside = tmp_path / "secret-sibling.txt"
    outside.write_text("no")
    (root / "escape.txt").symlink_to(outside)
    assert web.respond(FakeRequest("/escape.txt"), root).status_code == 404


def test_only_read_methods_are_allowed(root):
    for method in ("POST", "PUT", "DELETE", "PATCH"):
        response = web.respond(FakeRequest("/", method=method), root)
        assert response.status_code == 405, method
    head = web.respond(FakeRequest("/", method="HEAD"), root)
    assert head.status_code == 200 and head.body == b""
    assert head.headers["Content-Length"] != "0", "HEAD still reports the size"


def test_query_strings_are_ignored(root):
    assert web.respond(FakeRequest("/?v=2"), root).status_code == 200


def test_missing_files_are_not_found(root):
    assert web.respond(FakeRequest("/nope.js"), root).status_code == 404


def test_websocket_upgrades_are_left_alone(root):
    request = FakeRequest("/", headers={"Upgrade": "websocket"})
    assert web.respond(request, root) is None, "the kernel socket is not a page"


def test_an_install_without_a_build_serves_nothing(tmp_path):
    assert web.available(tmp_path) is False
    assert web.respond(FakeRequest("/"), tmp_path) is None
