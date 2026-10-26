package com.demo.order;

/** 接收者既不是字段也不是类名：参数与局部变量也要能换成类型，否则这类调用边会整片看不见。 */
public class OrderValidator {
    public String check(OrderMapper injected) {
        OrderMapper local = injected;
        return local.insert("checked");
    }
}
