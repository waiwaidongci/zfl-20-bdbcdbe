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
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`
- `POST /import/precheck`
- `POST /import/confirm`
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

#### 第1步：登记拓片

```bash
curl -X POST http://127.0.0.1:3020/rubbings \
  -H 'Content-Type: application/json' \
  -d '{"code":"TP-清-014","source":"地方碑刻残页","paperSize":"42x68cm","note":"边缘有旧折痕"}'
```

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

#### 第4步：审核通过

```bash
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/approve \
  -H 'Content-Type: application/json'
```

审核通过后 `reviewStatus` 变为 `approved`。

#### 第4步（备选）：审核驳回

```bash
curl -X POST http://127.0.0.1:3020/damages/damage_demo_2/reject \
  -H 'Content-Type: application/json' \
  -d '{"reason":"照片模糊无法确认缺损位置，请重新拍摄后提交"}'
```

驳回后 `reviewStatus` 变为 `rejected`，`rejectReason` 记录原因。被驳回的缺损项无法加入修补批次。

#### 第5步：创建修补批次（仅已审核通过的缺损项可入批次）

```bash
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1"]}'
```

若 `damageIds` 中包含未通过审核的缺损项，返回 400 错误及 `unapprovedDamageIds` 列表。

#### 第6步：完成批次

```bash
curl -X POST http://127.0.0.1:3020/batches/batch_xxx/complete \
  -H 'Content-Type: application/json' \
  -d '{"note":"全部修复完成","results":[{"damageId":"damage_demo_1","afterPhotoUrl":"https://example.local/after-014-1.jpg","repairNote":"虫蛀孔已补全"}]}'
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
