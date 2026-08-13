"""Artifacts (the folder contract): what persists, what stays behind.
Run with the project venv: .venv/bin/python python/tests/test_artifacts.py
"""

from knuth.session import Session


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
    assert "ax" not in figures and "ax" not in values

    # Regenerate semantics: deleting a name removes it from the mirror.
    s.run("del x")
    values, _ = s.artifacts()
    assert "x" not in values

    print("test_artifacts: all assertions passed")


if __name__ == "__main__":
    main()
