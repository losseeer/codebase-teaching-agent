"""纯库文件：只有函数定义与非路由装饰器，没有任何框架级入口证据。

这是最需要被证伪的**负例**：要是规则在这里也报一个入口，「入口清单」就退化成「文件清单」。
文件里故意放了 lru_cache 与 property 两种装饰器——装饰器本身不是路由证据，
只有挂在 app/router/蓝图对象上的那几个 HTTP 动词才是。
"""

from functools import lru_cache


class MoneyLine:
    def __init__(self, amount: float):
        self.amount = amount

    @property
    def display(self) -> str:
        return f"{self.amount:.2f}"


@lru_cache(maxsize=None)
def tax_rate(region: str) -> float:
    return 0.06 if region == "cn" else 0.0


def gross_amount(unit_price: float, count: int, region: str = "cn") -> float:
    return round(unit_price * count * (1 + tax_rate(region)), 2)
