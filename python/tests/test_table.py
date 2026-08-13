"""Data viewer windows (Session.table). Run with the project venv:
.venv/bin/python python/tests/test_table.py
"""

from knuth.session import Session


def main():
    s = Session()
    ok, tb = s.run(
        "import numpy as np\n"
        "import pandas as pd\n"
        "df = pd.DataFrame({'a': range(1000), 'b': [x * 0.5 for x in range(1000)]})\n"
        "series = pd.Series([10, 20, 30], name='vals')\n"
        "arr = np.arange(12).reshape(3, 4)\n"
        "wide = pd.DataFrame({f'c{i}': [1] for i in range(300)})\n"
        "x = 42\n"
    )
    assert ok, tb

    t = s.table("df")
    assert t["total_rows"] == 1000 and t["total_cols"] == 2, t
    assert t["columns"] == ["a", "b"] and len(t["rows"]) == 100
    assert t["rows"][0] == ["0", "0.0"] and t["index"][0] == "0"

    t = s.table("df", offset=990, limit=100)
    assert len(t["rows"]) == 10 and t["rows"][0][0] == "990", t["rows"][:2]

    t = s.table("series")
    assert t["columns"] == ["vals"] and t["total_rows"] == 3
    assert [r[0] for r in t["rows"]] == ["10", "20", "30"]

    t = s.table("arr")
    assert t["total_rows"] == 3 and t["total_cols"] == 4
    assert t["rows"][2] == ["8", "9", "10", "11"]

    t = s.table("wide")
    assert t["total_cols"] == 300 and len(t["columns"]) == 200, "column cap"
    assert len(t["rows"][0]) == 200

    assert "error" in s.table("x"), "scalars are not tabular"
    assert "error" in s.table("missing")

    print("test_table: all assertions passed")


if __name__ == "__main__":
    main()
