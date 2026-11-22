# 铁路复运中的货主服务缺口与改道取舍

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

日期按运输季起算，目标 P 的指定船期由 port-calls 提供。leg 用连字符连接起讫站，批量为千克，空车即便 max_kg 为零也占其车底时间。每一候选安排独立比较，同一车底腿必须时间连续可接，连续地点不同需有已提供的空车路段，装卸的准备时间资料以日精度表示。同日可接仅在同站。
road-survey 的 unknown 不许强制计入回流；range 记录可能应答窗口，不能等同于通过协议确认。obligations 标示签订时的最低运量和到站日。最低站频次是可办理的服务窗口，空车不计。
freight-profile 标注登记时采用的运输季型、货类和货主规模。当地季初天数以各季自己的日历记，wet 和 dry 不共用抽样分母。service-capture 登记每个站的登记范围、被访货主数、人群覆盖基数及获知日，群体行不是逐批需求。shipment-receipts 是目的站后续签收，held 只是已到站待交，accepted 才是交付。received_day 是现场日期，known_day 是回收回单的日期。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。
