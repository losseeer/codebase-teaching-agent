#!/usr/bin/env python
"""Django 命令行管理入口：migrate、runserver、shell 都从这儿进。

这个样例钉两件事：
1. manage 本来就在文件名约定清单里，新规则把它升成**权威入口**——落点从第 1 行挪到守卫那一行，
   标签也不再是「conventional entrypoint」这种猜测口径。
2. 只有 execute_from_command_line 这个调用，不构成 HTTP 入口证据：它是命令入口。
"""

import os
import sys

from django.core.management import execute_from_command_line


def main() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "djangoshop.settings")
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
