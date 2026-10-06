package com.demo.order;

/** 控制器只认识接口，运行时才绑到这个实现：仓库里没有任何一行代码直接调用它。 */
public class OrderFacadeImpl implements IOrderFacade {
    private final OrderMapper mapper = new OrderMapper();

    @Override
    public String submit() {
        return mapper.insert("ok");
    }
}
