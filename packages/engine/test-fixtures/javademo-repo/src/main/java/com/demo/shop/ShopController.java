package com.demo.shop;

import com.demo.util.Keys;
import com.demo.util.*;
import static com.demo.util.Keys.LOCK;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;

@RestController
@RequestMapping("/shop")
public class ShopController {
    private final ShopService service = new ShopService();

    @RequestMapping("/list")
    public String list() {
        return service.list();
    }
}
