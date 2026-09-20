# ADR-0020: Asset Library 的筛选维度取自冻结的 Generation Specification

## 状态

已接受 — 2026-09-20。收起对象是 Asset Library 的筛选入口：此前只有一个按资产 ID 搜索的输入框，改为按 Generation Parameter 中的模式 / 比例 / 分辨率筛选（同一维度内多选为 OR，维度之间为 AND，选中即生效）。

## 背景

Media Asset 自身不携带生成参数：模式、比例、分辨率只存在于它所属 Generation Task 的、提交时冻结的 Generation Specification 里（`creation_media_assets.task_id` → `creation_generation_tasks.specification`），而该规范在 Asset Library 的 API 面上是本人私有的。筛选维度因此不能读 Asset 自身的列，必须沿 Generation Task 回读冻结值——这决定了查询形状，也决定了「维度词的权威来源是谁」这个问题必须显式回答。

比例另有一个例外：`adaptive` 是供应商自行决定画幅的取值，没有比例标签能描述其结果的实际形状。

## 决策

### 词表由版本化的能力契约决定，不由当前连接状态决定

`GET /creation/assets` 的响应随页返回 `facets: { modes, ratios, resolutions }`，按当前媒体类型给出可选值，单一权威清单仍是 AI Provider Capability Manifest 对应的版本化契约常量。不读实时能力清单：AI Provider Connection 暂停时清单对不可用媒体返回空值表，若以它为准，暂停连接就会连 User 筛选自己既有资产的能力一起拿走——而既有资产与当前连接是否可用无关。

### adaptive 按像素实际形状归类

比例筛选同时接受两类命中：规范里写着该比例字的资产，以及规范里写着 `adaptive` 且像素宽高比落在该比例 ±3% 带内的资产（带宽容度按已发布的全部尺寸反证：每个尺寸只命中它自己所属的那一个比例，相邻比例间隔 12.5%，最坏标签偏差 1.84%）。规范该字段为空的资产不进入任何比例筛选，这是接受的代价。分辨率与模式不设此类回退：它们的取值本身就是标签。

### 超出词表的筛选值返回 400

未知的 mode / ratio / resolution 值按客户端缺陷处理并明确报错，而不是静默返回空页——空页会把缺陷伪装成一个合法为空的筛选结果。词表内的值可以与任意资产数相交为空，那是正常的筛选结果。

## 后果

- 筛选只在选中了维度时才引入 Generation Task 的 join，不为筛选新建列或索引。plan 由哪一侧驱动不受保证：实测在 50k Asset 下，选中维度后规划器改从 Task 侧驱动并排序命中行（代价随命中数增长，而非页大小），因为 `= ANY($n)` 的选择率估算是看不到参数内容的。出现慢查询日志时，把维度列物化到 `creation_media_assets` 是既定的升级路径。
- 契约中 mode / ratio / resolution 的 enum 顺序与 domain 的发布顺序由契约一致性测试逐项比对锁死，客户端不重排已发布词表。
- 发布词表只含可表达的比例：`adaptive` 是分类回退而非可筛选的取值，客户端不会把它渲染成一行。
