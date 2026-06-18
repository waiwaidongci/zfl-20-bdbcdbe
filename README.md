# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项和修补批次。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=&reviewStatus=`
- `PATCH /damages/:id`
- `POST /damages/:id/approve`
- `POST /damages/:id/reject`
- `GET /batches?status=&responsible=`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`
- `POST /batches/:id/rollback`
- `POST /import/precheck`
- `POST /import/confirm`
- `GET /dashboard/repair-workbench?type=&rubbingId=&batchId=&responsible=`
- `GET /schedules?startDate=&endDate=&status=&responsible=`
- `GET /rubbings/:id/summary`

## 缺损项审核流程

缺损项创建后先进入 `review_pending`（待审核）状态，审核通过后才可加入修补批次，审核驳回时需记录驳回原因。

### 审核状态（reviewStatus）

| 值 | 含义 |
|---|---|
| `review_pending` | 待审核（新建缺损项的初始状态） |
| `approved` | 审核通过（可加入修补批次） |
| `rejected` | 审核驳回（不可加入批次，附带 rejectReason） |

> 旧数据中缺少 `reviewStatus` 字段时，读取时自动默认为 `approved`，确保平滑兼容。

### 完整调用链路：登记 → 审核 → 入批次

#### 第1步：确认示例拓片

```bash
curl http://127.0.0.1:3020/rubbings
```

示例数据内置 `rubbing_demo`，后续登记、审核和入批次示例都基于该拓片。

#### 第2步：登记缺损项（自动进入待审核）

```bash
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/damages \
  -H 'Content-Type: application/json' \
  -d '{"position":"左上角第3列题字旁","type":"虫蛀孔","beforePhotoUrl":"https://example.local/before-014-1.jpg"}'
```

返回的缺损项 `reviewStatus` 为 `review_pending`。

#### 第3步：查询待审核缺损项

```bash
curl http://127.0.0.1:3020/damages?reviewStatus=review_pending
```

支持组合过滤：`/damages?reviewStatus=review_pending&type=虫蛀孔`

#### 第4步：审核通过（以待审核的 damage_demo_2 为例）

```bash
curl -X POST http://127.0.0.1:3020/damages/damage_demo_2/approve \
  -H 'Content-Type: application/json'
```

审核通过后 `reviewStatus` 变为 `approved`，之后该缺损项可加入修补批次。

#### 第4步（备选）：审核驳回（先登记一个新缺损项，再对其驳回）

```bash
# 先登记一个新的缺损项
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/damages \
  -H 'Content-Type: application/json' \
  -d '{"position":"右下角","type":"霉斑","beforePhotoUrl":"https://example.local/before-mold.jpg"}'

# 然后驳回（把 damage_new 替换为上一步返回的 id，reason 必填且不能为空）
curl -X POST http://127.0.0.1:3020/damages/damage_new/reject \
  -H 'Content-Type: application/json' \
  -d '{"reason":"照片模糊无法确认缺损位置，请重新拍摄后提交"}'
```

驳回后 `reviewStatus` 变为 `rejected`，`rejectReason` 记录原因。被驳回的缺损项无法加入修补批次。

#### 第5步：创建修补批次（仅已审核通过的缺损项可入批次）

```bash
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
```

若 `damageIds` 中包含未通过审核的缺损项，返回 400 错误及 `unapprovedDamageIds` 列表。

#### 第6步：完成批次

```bash
curl -X POST http://127.0.0.1:3020/batches/batch_xxx/complete \
  -H 'Content-Type: application/json' \
  -d '{"note":"全部修复完成","results":[{"damageId":"damage_demo_1","afterPhotoUrl":"https://example.local/after-014-1.jpg","repairNote":"虫蛀孔已补全"},{"damageId":"damage_demo_2","afterPhotoUrl":"https://example.local/after-014-2.jpg","repairNote":"撕裂处已加固"}]}'
```

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?reviewStatus=approved
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1"]}'
```

## 批量导入示例

### 1. 导入预检（不落库）

```bash
curl -X POST http://127.0.0.1:3020/import/precheck \
  -H 'Content-Type: application/json' \
  -d '{
    "rubbings": [
      {
        "code": "TP-宋-087",
        "source": "西安碑林馆藏",
        "paperSize": "60x90cm",
        "note": "字迹清晰"
      },
      {
        "code": "TP-清-014",
        "source": "旧藏重复",
        "paperSize": "42x68cm"
      },
      {
        "code": "TP-明-003",
        "source": ""
      }
    ],
    "damages": [
      {
        "rubbingId": "TP-宋-087",
        "position": "右上额题字",
        "type": "水渍",
        "beforePhotoUrl": "https://example.local/before-087-1.jpg"
      },
      {
        "rubbingId": "nonexistent",
        "position": "中部",
        "type": "霉斑",
        "beforePhotoUrl": "https://example.local/before-xxx.jpg"
      },
      {
        "rubbingId": "TP-宋-087",
        "position": "",
        "type": "",
        "beforePhotoUrl": ""
      }
    ]
  }'
```

### 2. 确认导入（落库）

导入的缺损项默认 `reviewStatus` 为 `review_pending`，也可在导入数据中指定：

```bash
curl -X POST http://127.0.0.1:3020/import/confirm \
  -H 'Content-Type: application/json' \
  -d '{
    "rubbings": [
      {
        "code": "TP-宋-087",
        "source": "西安碑林馆藏",
        "paperSize": "60x90cm",
        "note": "字迹清晰"
      },
      {
        "code": "TP-元-011",
        "source": "道教碑文",
        "paperSize": "50x75cm"
      }
    ],
    "damages": [
      {
        "rubbingId": "TP-宋-087",
        "position": "右上额题字",
        "type": "水渍",
        "beforePhotoUrl": "https://example.local/before-087-1.jpg"
      },
      {
        "rubbingId": "TP-元-011",
        "position": "左下角落款处",
        "type": "虫蛀孔",
        "beforePhotoUrl": "https://example.local/before-011-1.jpg",
        "reviewStatus": "approved"
      }
    ]
  }'
```

### 3. 关联已存在拓片导入缺损

```bash
curl -X POST http://127.0.0.1:3020/import/precheck \
  -H 'Content-Type: application/json' \
  -d '{
    "rubbings": [],
    "damages": [
      {
        "rubbingId": "rubbing_demo",
        "position": "右边缘中部",
        "type": "折裂",
        "beforePhotoUrl": "https://example.local/before-demo-3.jpg"
      }
    ]
  }'
```

## 批次负责人筛选与排程查询示例

### 创建带负责人的修补批次

```bash
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"张工负责的六月批次",
    "damageIds":["damage_demo_1"],
    "responsible":"张工",
    "plannedStartAt":"2026-06-10T00:00:00.000Z",
    "plannedEndAt":"2026-06-20T23:59:59.999Z"
  }'
```

### 按负责人筛选批次列表

```bash
# 查询张工负责的所有批次
curl "http://127.0.0.1:3020/batches?responsible=张工"

# 查询未分配负责人的批次（传空字符串）
curl "http://127.0.0.1:3020/batches?responsible="

# 组合筛选：张工负责且进行中的批次
curl "http://127.0.0.1:3020/batches?responsible=张工&status=open"
```

### 按负责人筛选排程

```bash
# 查询张工在 2026 年 6 月的排程
curl "http://127.0.0.1:3020/schedules?startDate=2026-06-01&endDate=2026-06-30&responsible=张工"

# 查询未分配负责人的排程
curl "http://127.0.0.1:3020/schedules?startDate=2026-06-01&endDate=2026-06-30&responsible="
```

## 修补工作台看板负责人聚合统计

### 查看完整看板（含按负责人聚合）

```bash
curl http://127.0.0.1:3020/dashboard/repair-workbench
```

返回数据中新增 `byResponsible` 字段，每个负责人包含：
- `responsible`：负责人名称（旧批次无负责人时显示为"未分配"）
- `batchCount`：负责的批次数
- `damageCount`：负责的缺损总数
- `overdueCount`：已逾期未完成的批次数
- `openBatchCount`：进行中的批次数
- `completedBatchCount`：已完成的批次数

### 按负责人筛选看板数据

```bash
# 只看张工相关的统计
curl "http://127.0.0.1:3020/dashboard/repair-workbench?responsible=张工"
```

> 说明：没有设置 `responsible` 字段的旧批次在筛选时不会被过滤掉（不传 `responsible` 参数时返回全部），在看板聚合统计中统一归类为"未分配"。

## 数据结构版本

本项目使用版本化数据结构，支持从 v0/v1/v2 平滑升级到最新版本（v3）。

| 版本 | 主要特性 |
|---|---|
| v0 | 扁平结构，直接在根目录存放 rubbings/damages/batches 等数组 |
| v1 | 引入 schemaVersion 字段，兼容新旧格式混合 |
| v2 | 实体与元数据分离（entities/meta），引入 imageArchive 空壳 |
| **v3** | **结构化审计追踪（auditTrail）、增强型影像归档统计（imageArchive）** |

### v3 新特性

#### 1. 结构化审计追踪（auditTrail）

v3 新增 `auditTrail` 字段，用于记录所有关键操作的历史事件：

- `damage_registered` - 缺损登记
- `damage_approved` / `damage_rejected` - 缺损审核通过/驳回
- `damage_updated` - 缺损信息更新
- `batch_created` / `batch_completed` - 批次创建/完成
- `batch_rolled_back` / `batch_partially_rolled_back` - 批次全量/部分回滚
- `images_archived` - 影像归档
- `backup_restored` - 备份恢复
- `data_imported` - 数据导入

每个事件包含：
```json
{
  "id": "evt_xxx",
  "eventType": "damage_approved",
  "targetType": "damage",
  "targetId": "damage_demo_1",
  "timestamp": "2025-06-15T10:30:00.000Z",
  "actor": "张工",
  "oldValues": { "reviewStatus": "review_pending" },
  "newValues": { "reviewStatus": "approved" },
  "reason": null,
  "metadata": { "changeSummary": "...", "success": true }
}
```

#### 2. 增强型影像归档统计（imageArchive）

v3 将 `imageArchive` 从空壳升级为可维护的归档统计：

```json
{
  "summary": {
    "totalArchived": 42,
    "totalByStage": {
      "before_repair": 20,
      "during_repair": 5,
      "after_repair": 17
    },
    "byDamageId": { "damage_demo_1": 3, "damage_demo_2": 5 },
    "byBatchId": { "batch_001": 8 },
    "byMonth": { "2025-06": 15 },
    "lastArchivedAt": "2025-06-15T14:30:00.000Z",
    "firstArchivedAt": "2025-01-10T09:00:00.000Z",
    "storagePath": "./data/image-archive"
  }
}
```

归档统计在每次写入时自动重建，确保数据一致性。

### 数据迁移

#### 自动迁移

启动服务时会自动检测并执行数据迁移：

```bash
PORT=3020 node server.js
```

迁移过程包含：
1. 自动备份原始数据到 `data/backups/` 目录
2. 执行版本升级（v0→v1→v2→v3）
3. 迁移失败自动回滚
4. 从实体字段和 audit-logs.json 重建 auditTrail 历史

#### 手动迁移

```bash
# 查看迁移状态
node data-migrator.js status

# 执行迁移（自动备份）
node data-migrator.js migrate

# 强制重新迁移
node data-migrator.js migrate --force

# 仅验证结构
node data-migrator.js validate

# 列出备份
node data-migrator.js backups
```

#### 迁移安全保障

- **自动备份**：迁移前自动创建完整备份
- **原子写入**：使用临时文件 + 重命名确保写入原子性
- **失败回滚**：迁移过程中任何错误自动回滚到备份
- **结构校验**：迁移前后执行完整结构校验
- **冲突检测**：迁移时检测并报告潜在数据冲突

### v3 新增接口

#### 查看当前数据结构版本

```bash
curl http://127.0.0.1:3020/schema-version
```

返回：
```json
{
  "schemaVersion": 3,
  "currentSupported": 3,
  "isLatest": true,
  "meta": { ... },
  "imageArchiveSummary": { ... },
  "auditTrailCount": 156
}
```

#### 查询结构化审计追踪

```bash
# 全部事件
curl http://127.0.0.1:3020/audit-trail

# 按事件类型筛选
curl "http://127.0.0.1:3020/audit-trail?eventType=damage_approved"

# 按目标ID筛选
curl "http://127.0.0.1:3020/audit-trail?targetId=damage_demo_1"

# 按时间范围筛选
curl "http://127.0.0.1:3020/audit-trail?startDate=2025-06-01&endDate=2025-06-30"

# 按操作人筛选
curl "http://127.0.0.1:3020/audit-trail?actor=张工"
```

### v2 向后兼容

v3 完全保留 v2 实体读取兼容性：
- 旧版 API 调用方式完全不变
- `unwrapDbData` 透明处理 v2/v3 格式转换
- 非 v3 数据库上 `writeAuditTrailEvent` 静默返回 null，不影响业务
- test-helper.js 自动检测版本，支持 v2/v3 混合测试

### 完整接口列表

- `GET /health`
- `GET /schema-version`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=&reviewStatus=`
- `PATCH /damages/:id`
- `POST /damages/:id/approve`
- `POST /damages/:id/reject`
- `GET /damages/:id/images`
- `POST /damages/:id/images`
- `GET /batches?status=&responsible=`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`
- `POST /batches/:id/rollback`
- `POST /batches/:id/rollback {damageIds} (partial)`
- `POST /import/precheck`
- `POST /import/confirm`
- `GET /dashboard/repair-workbench?type=&rubbingId=&batchId=&responsible=`
- `GET /rubbings/:id/summary`
- `GET /schedules?startDate=&endDate=&status=&responsible=`
- `GET /export/rubbings?startDate=&endDate=&fields=`
- `GET /export/damages?status=&type=&startDate=&endDate=&fields=`
- `GET /export/batches?status=&startDate=&endDate=&fields=`
- `GET /export/repair-results?status=&type=&startDate=&endDate=&fields=`
- `GET /backups`
- `POST /backups`
- `GET /backups/:filename/validate`
- `GET /backups/:filename/diff`
- `POST /backups/:filename/restore`
- `GET /audit-logs?actionType=&targetId=&targetType=&startDate=&endDate=&success=`
- `GET /audit-trail?eventType=&targetId=&targetType=&startDate=&endDate=&actor=`
