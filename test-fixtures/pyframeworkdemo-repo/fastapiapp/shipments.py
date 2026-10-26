"""FastAPI 路由模块：APIRouter 上的 HTTP 动词装饰器，没有应用构造语句。

这个样例专门测装饰器动词那一支（get/post/put/patch/delete）：main.py 用 include_router 挂上去之前，
请求的落点其实已经写死在这里了，所以它是入口；锚点落在第一条装饰器那一行。
"""

from fastapi import APIRouter

router = APIRouter(prefix="/shipments")


@router.get("/{shipment_id}")
def shipment_detail(shipment_id: str):
    return {"shipment_id": shipment_id}
