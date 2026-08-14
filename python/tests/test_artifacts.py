"""Artifacts (the folder contract): what persists, what stays behind.
Run with the project venv: .venv/bin/python python/tests/test_artifacts.py
"""

from knuth.session import Session, capture_open_figures


def main():
    s = Session()
    ok, _ = s.run(
        "import numpy as np\n"
        "x = 42\n"
        "pi = 3.14159\n"
        "label = 'gdp'\n"
        "flag = True\n"
        "nothing = None\n"
        "nums = [1, 2, 3]\n"
        "params = {'alpha': 0.05}\n"
        "_secret = 'loop temp'\n"
        "big = list(range(100000))\n"
        "inf = float('inf')\n"
        "np_val = np.float64(2.5)\n"
        "f = lambda z: z\n"
    )
    assert ok
    values, figures = s.artifacts()
    assert values["x"] == 42 and values["pi"] == 3.14159, values
    assert values["label"] == "gdp" and values["flag"] is True, values
    assert values["nothing"] is None and values["nums"] == [1, 2, 3], values
    assert values["params"] == {"alpha": 0.05}, values
    assert values["np_val"] == 2.5, values  # numpy scalar unwrapped
    for hidden in ("_secret", "big", "inf", "np", "f"):
        assert hidden not in values, hidden
    assert figures == {}, figures

    # DataFrames are session-only.
    ok, _ = s.run("import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})")
    assert ok
    values, _ = s.artifacts()
    assert "df" not in values

    # Named figures render to SVG.
    ok, tb = s.run(
        "import matplotlib\n"
        "matplotlib.use('Agg')\n"
        "import matplotlib.pyplot as plt\n"
        "fig, ax = plt.subplots()\n"
        "ax.plot([1, 2, 3], [2, 4, 9])\n"
    )
    assert ok, tb
    values, figures = s.artifacts()
    assert "fig" in figures and "<svg" in figures["fig"], list(figures)
    # Artist unwrapping: a named axes persists its owning figure (as fig).
    assert "ax" in figures and "ax" not in values

    # Display capture: pyplot-style (unnamed) figures render once and are
    # closed; a NAMED figure still persists via artifacts after closing.
    capture_open_figures()  # flush figures left open by earlier blocks
    ok, tb = s.run("plt.figure()\n_ = plt.plot([1, 2], [3, 4])")
    assert ok, tb
    svgs = capture_open_figures()
    assert len(svgs) == 1 and "<svg" in svgs[0], len(svgs)
    assert capture_open_figures() == [], "figures close after capture"
    _, figures = s.artifacts()
    assert "fig" in figures, "named figure persists even after plt.close"

    # Artist unwrapping: naming what plt.plot RETURNS (a list of Line2D)
    # persists the owning figure — the natural pattern just works.
    ok, tb = s.run("p = plt.plot([1, 2], [2, 1])")
    assert ok, tb
    capture_open_figures()
    _, figures = s.artifacts()
    assert "p" in figures and "<svg" in figures["p"], list(figures)
    ok, tb = s.run("named_ax = fig.gca()")
    assert ok, tb
    _, figures = s.artifacts()
    assert "named_ax" in figures, "an axes persists its figure too"

    # Regenerate semantics: deleting a name removes it from the mirror.
    s.run("del x")
    values, _ = s.artifacts()
    assert "x" not in values

    # Scratch never persists: bound names stay out of values.json and are
    # badged in the explorer; a program cell binding the name reclaims it.
    ok, _ = s.run("probe = 99\nimport math as m", scratch=True)
    assert ok
    values, _ = s.artifacts()
    assert "probe" not in values
    snap = {v["name"]: v for v in s.snapshot()}
    assert snap["probe"].get("scratch") is True, snap["probe"]
    ok, _ = s.run("probe = 100")
    assert ok
    values, _ = s.artifacts()
    assert values["probe"] == 100
    snap = {v["name"]: v for v in s.snapshot()}
    assert "scratch" not in snap["probe"]

    print("test_artifacts: all assertions passed")


if __name__ == "__main__":
    main()
