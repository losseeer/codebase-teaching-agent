"""Flask 小商城：入口证据在框架约定里，文件名不带任何框架信息。

这个样例测 Flask 应用的一整形态——建 app 对象、用装饰器登记视图、末尾 app.run 起服务。
旧规则只看文件名（shop.py 不在 main/server/app/index/cli/manage 里），所以这条链路此前完全不可见；
新规则一个文件只给一条锚点，落点是构造 app 的那一行：GUI 点入口直达正文，而不是第 1 行的文档字符串。
"""

from flask import Flask

app = Flask(__name__)


@app.route("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
