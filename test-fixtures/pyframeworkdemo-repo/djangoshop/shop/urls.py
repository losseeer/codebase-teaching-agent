"""Django 的 URL 配置：请求到视图的唯一映射表。

这个样例测 urlpatterns 那一行——Django 仓里最该被认成入口的非启动文件：
每个 HTTP 请求都先过这张表，锚点落在表本身，而不是表里指向的某个视图。
视图是同包相对导入进来的，依赖图里应当留下 urls.py 指向 views.py 的那条边。
"""

from django.urls import path

from .views import order_detail, order_list

urlpatterns = [
    path("orders/", order_list),
    path("orders/<int:order_id>/", order_detail),
]
