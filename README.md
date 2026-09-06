# 繁花·纷落 · 新站

独立的网站、源码仓库和本地发布工具。初始站点保留「繁花·纷落」与「公开」两个分区，但两区均为空：没有角色卡、卡片预览、作品详情或简介，也没有迁入旧仓库的 Git 历史。

- 网站：https://hqu35785-cmyk.github.io/fanhuafenluo-site/
- 仓库：https://github.com/hqu35785-cmyk/fanhuafenluo-site
- 保留原分区头像、分区文字及头像切换效果；分区头像是界面素材，不属于角色卡作品。清空的只有作品及其卡片数据。
- 旧网站、旧仓库、旧本地文件及旧快捷方式不属于本项目，不会被本项目的发布工具更新。

## 以后发布作品

Windows 下需要 Node.js 22 或更高版本、Git，以及拥有本仓库写入权限的 GitHub 登录凭据。

```powershell
npm ci
npm run publisher:install
```

安装器创建三个独立的桌面快捷方式，不覆盖原来的快捷方式：

- `新站快捷发布卡片`
- `新站发布到繁花·纷落`
- `新站发布到公开`

打开快捷方式，选择分区并拖入自己的 PNG 卡片。工具读取卡片信息，但不会自动将人物设定充当简介；简介初始留空。可以复制「原始资料 + 写作提示」给 AI，随后自行检查并填入 120–180 字简介。检查摘要后点击发布，工具会验证、提交到本仓库的 `main` 分支，并检查网页部署结果。

导入、预览和保存草稿都只发生在本机；只有明确点击发布才会推送。工具状态和草稿单独保存在 `%LOCALAPPDATA%\FanHuaSitePublisher`，与旧工具的数据隔离。运行时凭据不得提交到仓库或分享给他人。完整说明见 [发布工具文档](tools/card-publisher/README.md)。

## 数据与部署

唯一数据源是 `src/data/catalog.json`；简介编辑源是 `src/data/card-intros.json`，详情由同步脚本生成。新项目初始的作品数组及三个详情/简介对象均为空。

`main` 分支变更通过 GitHub Actions 执行数据、导入/发布、页面回归测试后部署到 GitHub Pages。部署产物只包含首页、带指纹的 CSS/JS/JSON 和明确引用的 WebP 图像。本地发布工具、草稿、测试和原始 PNG 不进入 Pages 产物。以后主动发布到这个公开仓库的作品文件仍会作为公开仓库文件被访问和下载，请在发布前确认内容及授权。

## 本地验证与预览

```powershell
npm test
npm run validate:assets
npm run check:details
npm run build:pages
npm run verify:pages-site
npx playwright install chromium
npm run test:ui
npm run preview
```

构建需要有效的 Git 提交 SHA，用于固定下载资源的版本。预览地址为 `http://127.0.0.1:4173/`。回归测试使用临时目录或隔离的中性合成测试资料，不向线上发布测试卡，也不向生产目录填入作品。
