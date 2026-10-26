// Nest 的路由写在方法上的装饰器里；同文件有 @Controller 才算，别的装饰器不认。
import { Controller, Get } from "@nestjs/common";

@Controller("orders")
export class OrdersController {
  @Get(":id")
  findOne(): string {
    return "one";
  }
}
