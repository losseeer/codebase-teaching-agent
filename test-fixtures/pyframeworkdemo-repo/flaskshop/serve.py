"""Flask 的独立启动文件：app 在 shop.py 里建，这里只负责把它跑起来。

这个样例专门测「服务启动语句」那一支：文件里既没有 app 构造、也没有路由装饰器，
只有守卫下面那行 `app.run(...)`；启动证据优先于守卫证据，所以锚点落在那一行。
框架名认不出来（`from flaskshop.shop import app` 里的 flaskshop 是仓内包名，不是 flask），
标签就只写「HTTP 服务启动」——宁可少说，别说错。
"""

from flaskshop.shop import app

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)
