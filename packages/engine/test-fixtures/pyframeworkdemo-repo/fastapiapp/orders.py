"""FastAPI 订单服务：应用对象与路由写在同一个文件里。

这个样例测 FastAPI 那一支的 app 构造行——api = FastAPI(...) 出现在哪，入口就落在哪。
顺便钉住「一个文件只出一条」：文件里有两条 HTTP 动词装饰器，入口清单里却只有一个 orders.py，
真仓的 main.py 常常挂着十几条路由，逐条标会把入口清单变成路由清单。
"""

from fastapi import FastAPI

api = FastAPI(title="订单服务")


@api.get("/orders")
def list_orders():
    return []


@api.post("/orders")
def create_order(payload: dict):
    return payload
