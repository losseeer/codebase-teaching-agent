package com.demo;

import org.springframework.boot.SpringApplication;
import com.demo.shop.ShopController;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
        ShopController noop = null;
    }
}
