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
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`
- `POST /import/precheck`
- `POST /import/confirm`
- `GET /rubbings/:id/summary`

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
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
        "status": "pending"
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
