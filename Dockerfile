# Playwright 官方镜像 —— 已预装 Chromium + 系统依赖 + Node.js
# 本地 build 时 npm install，启动时 Express 直接起来（零浏览器下载）
FROM mcr.microsoft.com/playwright:v1.48.0-noble

# 工作目录
WORKDIR /app

# 先复制依赖声明，利用 Docker 缓存
COPY package.json ./

# 安装 Node 依赖（Playwright 已预装，不需要再装浏览器）
RUN npm install --omit=dev

# 复制源代码
COPY . .

# Render 默认端口 10000
EXPOSE 10000

# 启动
CMD ["node", "src/server.js"]
