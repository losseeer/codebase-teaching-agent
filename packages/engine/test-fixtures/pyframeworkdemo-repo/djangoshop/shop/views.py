"""Django 视图：只定义函数，由 urls.py 那张表决定谁来调。

这是**负例**。视图文件本身不该被标成入口：一个 Django 仓动辄几十上百个 views 模块，
逐文件标入口等于把「请求从哪进来」换成几十个候选，课程树会把业务函数当执行起点讲，
流程证据也从一条不会自己开始执行的链路铺起——那正是误判最贵的地方。
"""


def order_list():
    return []


def order_detail(order_id: int):
    return {"order_id": order_id}
