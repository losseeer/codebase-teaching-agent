"""启动器：app 在别的模块里建，这个文件只负责把它跑起来。

这个样例测「服务启动语句」优先于「脚本守卫」：同一文件里既有脚本守卫又有 uvicorn.run，
锚点落在启动那一行——学习者想知道的是「进程怎么起来的」，那一行比守卫更近。
框架名靠 import 认，这里只 import 了 uvicorn（ASGI 服务器，FastAPI/Starlette 都能用），
所以标签不带框架名：宁可不写，也不把 Starlette 的仓说成 FastAPI。
"""

import uvicorn

from fastapiapp.orders import api

if __name__ == "__main__":
    uvicorn.run(api, host="127.0.0.1", port=8000)
