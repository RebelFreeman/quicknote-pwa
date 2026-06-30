# 随手记 PWA — 跨设备同步方案

## 概述

本方案为 **quicknote-pwa** 静态应用添加了跨设备实时同步能力，基于 **Firebase Firestore**。无需后端服务器，用一个"同步码"即可让手机和电脑共享同一份待办数据。

---

## 架构原理

```
手机端                         Firestore                       电脑端
─────────────────────────────────────────────────────────────────────
本机 IndexedDB                rooms/{syncKey}/tasks/          本机 IndexedDB
      │                              │                               │
      │──── pushTaskToSync() ───────►│◄──── onSnapshot() ──────────│
      │◄─── onSnapshot() ───────────│──── pushTaskToSync() ───────►│
```

- 每台设备独立维护本机 IndexedDB（离线可用）
- 联网时通过 Firestore 实时监听（`onSnapshot`）双向同步
- **同步码**（16 位随机串）是唯一凭证，输入相同同步码的设备共享同一"房间"

---

## 已修改的文件

| 文件 | 变更内容 |
|------|---------|
| `docs/app.js` | 新增同步模块（约 160 行）、在任务增删改时触发同步推送 |
| `docs/index.html` | 新增"同步"页面、第四个导航按钮、Firebase 配置占位符 |
| `docs/styles.css` | 新增同步 UI 样式、底部导航调整为 4 列 |
| `docs/sw.js` | Service Worker 缓存版本升级（强制刷新） |

---

## 一次性配置步骤

### 第一步：创建 Firebase 项目

1. 打开 <https://console.firebase.google.com>
2. 点击「添加项目」，随意命名（如 `quicknote-sync`）
3. 可关闭 Google Analytics（非必须）

### 第二步：启用 Firestore

1. 左侧菜单 → **构建** → **Firestore Database**
2. 点击「创建数据库」
3. 选择**测试模式**（后续会改规则）
4. 选择离你最近的地区（如 `asia-east1`）

### 第三步：获取 Firebase 配置

1. 左侧齿轮图标 → **项目设置**
2. 下滑到「您的应用」→ 点击 `</>` 网页图标
3. 注册应用（随意命名），**不需要**勾选 Firebase Hosting
4. 复制显示的配置对象，形如：

```javascript
{
  apiKey: "AIzaSy...",
  authDomain: "quicknote-sync-xxxxx.firebaseapp.com",
  projectId: "quicknote-sync-xxxxx",
  storageBucket: "quicknote-sync-xxxxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
}
```

### 第四步：填入配置

打开 `docs/index.html`，找到文件末尾附近的这段注释（约在 `</body>` 前）：

```html
<script>
  window.FIREBASE_CONFIG = null;
</script>
```

将 `null` 替换为你的配置对象：

```html
<script>
  window.FIREBASE_CONFIG = {
    apiKey: "AIzaSy...",
    authDomain: "quicknote-sync-xxxxx.firebaseapp.com",
    projectId: "quicknote-sync-xxxxx",
    storageBucket: "quicknote-sync-xxxxx.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef"
  };
</script>
```

### 第五步：设置 Firestore 安全规则

1. Firestore 控制台 → **规则** 标签页
2. 将规则替换为：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId}/tasks/{taskId} {
      allow read, write: if true;
    }
  }
}
```

3. 点击「发布」

> **说明**：同步码足够长（31^16 种组合），实际上不可被暴力枚举，`allow read, write: if true` 对个人使用是安全的。

### 第六步：部署

将修改后的 `docs/` 文件夹推送到 GitHub，GitHub Pages 会自动更新。

---

## 使用方法（配置完成后）

### 第一台设备（生成同步码）

1. 打开 App → 点击底部导航「**同步**」
2. 点击「**生成新同步码**」
3. 看到类似 `ab3d-ef7h-kp2q-rs4v` 的码，点「**复制**」
4. 状态变为「**已同步**」

### 第二台设备（加入同步）

1. 打开同一个 App URL → 点击「**同步**」
2. 在输入框粘贴第一台设备的同步码
3. 点击「**连接同步**」
4. 稍等片刻，两台设备的待办会自动合并并实时同步

### 断开同步

点击「**断开同步**」— 数据保留在本机，只是停止接收远端更新。

---

## 同步逻辑细节

### 冲突处理

每个任务对象新增了 `updatedAt` 字段，合并时以**较新时间戳**为准：

```javascript
// mergeRemoteTasks() 核心逻辑
const remoteMs = new Date(remote.updatedAt).getTime();
const localMs  = new Date(local.updatedAt).getTime();
if (remoteMs > localMs) byId.set(remote.id, remote); // 远端更新，采用远端
```

### 删除同步

本地删除后，先向 Firestore 写入软删除标记，再从本地移除：

```javascript
// Firestore 中写入墓碑记录
{ _deleted: true, updatedAt: "..." }

// onSnapshot 收到后，过滤掉 _deleted 任务
if (!data._deleted) remoteTasks.push(data);
```

### 离线行为

- Firebase SDK 内置离线持久化（`enablePersistence()`）
- 离线期间写入会排队，联网后自动批量同步到 Firestore
- 本机 IndexedDB 始终可读写，不依赖网络

### Firebase SDK 懒加载

Firebase 脚本（约 300KB）**仅在 `FIREBASE_CONFIG` 非 null 时才加载**，不影响未配置用户的首屏速度：

```javascript
async function loadFirebaseSDK() {
  await loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
  await loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js");
}

async function initSync() {
  if (!window.FIREBASE_CONFIG) return; // 未配置则直接跳过
  await loadFirebaseSDK();
  // ...
}
```

---

## Firestore 数据结构

```
rooms/
  {syncKey}/               ← 同步码作为文档 ID
    tasks/
      {taskId}/            ← 任务 UUID 作为文档 ID
        id: "uuid"
        text: "备忘内容"
        status: "active"
        archived: false
        createdAt: "2026-06-29T..."
        updatedAt: "2026-06-29T..."
        reminderAt: "2026-06-29T..."
        category: "工作"
        tags: ["工作", "开会"]
        _deleted: false     ← true 表示已删除
```

---

## 免费额度参考（Firebase Spark 免费套餐）

| 指标 | 免费限额 | 个人使用估算 |
|------|---------|------------|
| 存储 | 1 GB | 数千条任务 ≈ 几 MB |
| 每日读取 | 50,000 次 | 充足 |
| 每日写入 | 20,000 次 | 充足 |
| 每日删除 | 20,000 次 | 充足 |

个人日常使用完全在免费额度内，无需付费。

---

## 当前分支

所有代码变更已提交到：

```
branch: claude/code-thread-device-sync-2ecbxx
repo:   RebelFreeman/quicknote-pwa
```

只需填写 Firebase 配置并推送，即可上线。
