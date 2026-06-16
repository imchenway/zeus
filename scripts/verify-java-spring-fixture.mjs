#!/usr/bin/env node
/* global console */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProjectSource } from '../packages/code-indexer/dist/index.js';

const rootPath = await mkdtemp(join(tmpdir(), 'zeus-java-spring-fixture-'));

function requireSymbol(symbols, predicate, description) {
  const found = symbols.find(predicate);
  if (!found) throw new Error(`Zeus Java Spring fixture missing ${description}`);
  return found;
}

try {
  await mkdir(join(rootPath, 'src/main/java/com/example/orders'), {
    recursive: true,
  });
  await mkdir(join(rootPath, 'src/main/resources/mapper'), { recursive: true });

  await writeFile(
    join(rootPath, 'pom.xml'),
    `
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>orders-service</artifactId>
  <version>1.0.0</version>
  <modules><module>orders-api</module></modules>
</project>
`.trim(),
  );

  await writeFile(
    join(rootPath, 'build.gradle'),
    `
plugins {
  id 'org.springframework.boot' version '3.3.0'
  id 'java'
}
dependencies {
  implementation 'org.mybatis.spring.boot:mybatis-spring-boot-starter:3.0.3'
}
`.trim(),
  );

  await writeFile(
    join(rootPath, 'src/main/java/com/example/orders/OrderController.java'),
    `
package com.example.orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  private final OrderService orderService;

  public OrderController(OrderService orderService) {
    this.orderService = orderService;
  }

  @GetMapping("/{id}")
  public OrderDto getOrder(@PathVariable Long id) {
    return orderService.findOrder(id);
  }
}
`.trim(),
  );

  await writeFile(
    join(rootPath, 'src/main/java/com/example/orders/OrderService.java'),
    `
package com.example.orders;

import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {
  private final OrderMapper orderMapper;

  public OrderService(OrderMapper orderMapper) {
    this.orderMapper = orderMapper;
  }

  @Transactional(readOnly = true)
  @Async
  public OrderDto findOrder(Long id) {
    return orderMapper.selectOrder(id);
  }
}
`.trim(),
  );

  await writeFile(
    join(rootPath, 'src/main/java/com/example/orders/OrderMapper.java'),
    `
package com.example.orders;

import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface OrderMapper {
  OrderDto selectOrder(Long id);
}
`.trim(),
  );

  await writeFile(
    join(rootPath, 'src/main/resources/mapper/OrderMapper.xml'),
    `
<mapper namespace="com.example.orders.OrderMapper">
  <resultMap id="OrderMap" type="com.example.orders.OrderDto">
    <id column="id" property="id"/>
    <result column="total_amount" property="totalAmount"/>
  </resultMap>
  <select id="selectOrder" resultMap="OrderMap">
    SELECT orders.id, orders.total_amount, users.name
    FROM orders
    JOIN users ON users.id = orders.user_id
    WHERE orders.id = #{id}
  </select>
</mapper>
`.trim(),
  );

  const result = await scanProjectSource({
    rootPath,
    projectName: 'JavaSpringFixture',
  });
  const symbols = result.symbols;
  requireSymbol(symbols, (symbol) => symbol.symbolType === 'api' && symbol.name === 'GET /api/orders/{id}', 'Spring REST API route');
  requireSymbol(symbols, (symbol) => symbol.symbolType === 'class' && symbol.name === 'OrderService' && symbol.metadata.stereotype === 'service', 'Spring service stereotype');
  requireSymbol(symbols, (symbol) => symbol.symbolType === 'interface' && symbol.name === 'OrderMapper' && symbol.metadata.stereotype === 'mybatis_mapper', 'MyBatis mapper stereotype');
  requireSymbol(symbols, (symbol) => symbol.symbolType === 'function' && symbol.name === 'findOrder' && symbol.metadata.transactional === true && symbol.metadata.async === true, 'Transactional + Async service method');
  requireSymbol(symbols, (symbol) => symbol.symbolType === 'sql_call' && symbol.metadata.mapperNamespace === 'com.example.orders.OrderMapper', 'MyBatis SQL statement');
  requireSymbol(symbols, (symbol) => symbol.symbolType === 'table' && symbol.name === 'orders' && symbol.metadata.sourceKind === 'mybatis_xml_table', 'orders table from MyBatis XML');
  requireSymbol(symbols, (symbol) => symbol.symbolType === 'config' && symbol.name === 'Maven module orders-api', 'Maven module fact');
  requireSymbol(symbols, (symbol) => symbol.symbolType === 'config' && symbol.name === 'Gradle plugin org.springframework.boot', 'Gradle plugin fact');

  console.log(`java-spring-fixture=verified;files=${result.files.length};symbols=${symbols.length}`);
} finally {
  await rm(rootPath, { recursive: true, force: true });
}
