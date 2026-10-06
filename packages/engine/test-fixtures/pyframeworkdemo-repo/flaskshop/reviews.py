"""Flask 蓝图：app 对象在 shop.py，本文件只有挂在 Blueprint 上的路由。

这个样例专门测「没有 app 构造语句、只有路由声明」的模块——稍大的 Flask 仓都按蓝图拆分。
蓝图里的每条路由都是真实请求的落点，所以文件该入围；锚点落在第一条路由装饰器那一行。
"""

from flask import Blueprint

bp = Blueprint("reviews", __name__, url_prefix="/reviews")


@bp.route("/list")
def list_reviews():
    return []


@bp.route("/<int:product_id>")
def review_of(product_id: int):
    return []
