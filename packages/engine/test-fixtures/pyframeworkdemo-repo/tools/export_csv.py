"""独立脚本：没有框架，只有一个 `if __name__ == "__main__":` 守卫。

这个样例测最朴素的那条入口证据——`python tools/export_csv.py` 真会跑起来。
文件名（export_csv）不在约定清单里，旧规则碰不到；守卫行以外的函数定义与 import 都不算证据。
"""

import csv
import sys


def rows_for(path: str):
    with open(path, newline="", encoding="utf-8") as handle:
        yield from csv.DictReader(handle)


if __name__ == "__main__":
    for row in rows_for(sys.argv[1]):
        print(row)
