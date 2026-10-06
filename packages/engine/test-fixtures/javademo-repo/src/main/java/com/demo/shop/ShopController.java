package com.demo.shop;

import com.demo.order.IOrderFacade;
import com.demo.util.Keys;
import com.demo.util.*;
import static com.demo.util.Keys.LOCK;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;

@RestController
@RequestMapping("/shop")
public class ShopController {
    private final ShopService service = new ShopService();
    // 只靠包级通配 import 落点：下面引用到的那个类该入图，同包里没人碰的那个不该
    private final String trace = Metrics.SHOP_LIST;
    /** 依赖注入的形状：控制器只认接口，实现类在源码里不被任何人调用。 */
    private final IOrderFacade orders = null;

    @RequestMapping("/list")
    public String list() {
        return service.list();
    }

    @RequestMapping("/submit")
    public String submit() {
        return orders.submit();
    }
}
