# 🚀 部署上线 + 手机安装教程

本指南带你把「AI 存钱小帮手」部署到 **Render**（免费），实现：手机号+密码登录、数据云端同步（换手机不丢）、真·Claude AI 对话。最后教你装到手机上。

全程大约 15 分钟，不用写代码。

---

## 第一步：准备 3 个账号

1. **GitHub** — <https://github.com>（免费，用来存放代码）
2. **Render** — <https://render.com>（免费，用来跑后端）
3. **Anthropic（Claude）API Key** — <https://console.anthropic.com>
   - 登录后左侧 **API Keys → Create Key**，复制以 `sk-ant-...` 开头的密钥（只显示一次，先存好）。
   - 需要在 **Billing** 里绑卡充值（按用量计费）。日常聊天花费很少；想更省可在第四步把模型换成 `claude-haiku-4-5`。

---

## 第二步：把代码传到 GitHub

在本项目文件夹里（含 `server.py` 的那个目录）打开终端：

```bash
cd "claude ai_project"
git init
git add .
git commit -m "AI 存钱小帮手"
```

然后到 GitHub 点 **New repository** 新建一个空仓库（例如 `savings-helper`），按页面提示把本地推上去：

```bash
git remote add origin https://github.com/你的用户名/savings-helper.git
git branch -M main
git push -u origin main
```

> 不想用命令行？也可以在 GitHub 仓库页点 **Add file → Upload files**，把整个文件夹拖进去上传。

---

## 第三步：在 Render 一键部署（Blueprint）

本项目自带 `render.yaml`，Render 能据此自动创建 **Web 服务 + 免费 Postgres 数据库**。

1. 登录 Render → 右上 **New + → Blueprint**。
2. 连接你刚才的 GitHub 仓库，Render 会读到 `render.yaml`，点 **Apply / Create**。
3. 等几分钟，它会自动：建好数据库、安装依赖、启动服务。
4. 完成后你会得到一个网址，形如 `https://savings-helper-xxxx.onrender.com`。

---

## 第四步：填入 Claude API Key

1. 在 Render 打开那个 **Web 服务 → Environment**。
2. 找到 `ANTHROPIC_API_KEY`，点编辑，粘贴你的 `sk-ant-...` 密钥，保存。
   - （可选）把 `ANTHROPIC_MODEL` 改成 `claude-haiku-4-5` 更省钱，或 `claude-sonnet-4-6` 更均衡。默认 `claude-opus-4-8` 最聪明但最贵。
3. 服务会自动重新部署。完成后「小帮手」对话就是真·Claude 了；不填则自动使用内置智能逻辑。

> `JWT_SECRET` 和 `DATABASE_URL` 已由 Blueprint 自动配置好，无需手动填。

---

## 第五步：打开网址，注册账号

1. 手机或电脑浏览器打开你的 Render 网址。
2. 右上角 **⚙️ → 登录 / 注册账号** → 输入手机号 + 密码（至少 6 位）→ **注册**。
3. 之后在任何设备用同一手机号+密码登录，数据都会自动同步回来。✅

---

## 📱 第六步：装到手机主屏幕（像 App 一样用）

**iPhone（Safari）**
1. 用 **Safari** 打开你的网址。
2. 点底部「分享」按钮（方框+向上箭头）。
3. 选「**添加到主屏幕**」→ 添加。
4. 主屏幕上就有「存钱小帮手」图标了，点开即全屏，像原生 App。

**Android（Chrome）**
1. 用 **Chrome** 打开你的网址。
2. 点右上角 **⋮** 菜单。
3. 选「**安装应用**」或「**添加到主屏幕**」→ 确认。
4. 桌面出现图标，点开即全屏运行。

> 安装后即使没网也能打开界面（离线缓存）；登录、同步、AI 对话需要联网。

---

## 💡 关于免费档与省钱

- **Render 免费 Web 服务**：闲置约 15 分钟会休眠，下次打开有约 30 秒「冷启动」等待，属正常现象。想一直在线可升级到付费档。
- **Render 免费 Postgres**：有使用期限/容量限制。想长期免费且持久，可改用 **Neon**（<https://neon.tech>，免费且不过期）：在 Neon 建库后复制它的连接串，填到 Render Web 服务的 `DATABASE_URL` 环境变量即可（不用改代码）。
- **Claude 费用**：把 `ANTHROPIC_MODEL` 设为 `claude-haiku-4-5` 最省；日常问答花费通常很低。

---

## 🖥️ 在本机运行（开发/自用）

不部署也能在自己电脑上跑（数据存本地 SQLite 文件，单机使用）：

```bash
cd "claude ai_project"
python3 server.py
# 打开 http://localhost:8000
```

想本地就用真 AI：先 `pip3 install -r requirements.txt`，再带上密钥启动：

```bash
ANTHROPIC_API_KEY=sk-ant-你的key python3 server.py
```

---

## ❓ 常见问题

- **打不开/转圈很久**：Render 免费档冷启动，等 30 秒刷新。
- **AI 还是内置回答**：检查 `ANTHROPIC_API_KEY` 是否填对、账户是否有余额；并确认你已**登录账号**（真 AI 对话需要登录）。
- **换手机数据没回来**：确认两台设备登录的是**同一手机号**；数据按“最后修改时间”同步，新设备登录后会自动拉取。
- **忘记密码**：当前为简单版，暂不支持找回；请妥善保管密码（可在「设置 → 导出备份」定期导出 JSON 备份）。
