// 负例：前端的 axios 封装。`api.get("/orders")` 长得和路由登记一模一样，但它是**调用**路由的那一边。
import axios from "axios";

const api = axios.create({ baseURL: "/api" });

export const fetchOrders = (): Promise<unknown> => api.get("/orders");
