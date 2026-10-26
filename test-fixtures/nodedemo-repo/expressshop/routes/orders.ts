// Express 的子路由文件：接收者是本文件里建出来的 Router 实例，所以这条登记算证据。
import { Router } from "express";

const router = Router();

router.post("/orders", async (_request, response) => response.send("created"));

export default router;
