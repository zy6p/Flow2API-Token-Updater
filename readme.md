# 使用说明

## 当前支持范围

- Chromium 系列：Chrome、Edge
- Firefox 系列：Firefox、Zen Browser
- 当前版本按“一个浏览器 profile 一套配置”工作
- 每个 profile 只需要填写一个 `Base URL`
- 如果当前浏览器已经登录同域名的 Flow2API 控制台，扩展会自动读取插件连接 Token
- 扩展会监听当前 profile 的 Google Labs 登录态变化，并自动同步到 Flow2API

> 注意：浏览器 **profile 之间是完全隔离** 的。  
> 如果你有多个 Zen / Firefox profile，需要在每个 profile 里分别安装并填写一次连接配置。  
> 同一个 Google 账号如果同时登录在多个 profile，建议只选择一个 profile 开启定时同步。

需要配合 [Flow2api](https://github.com/TheSmallHanCat/flow2api) 服务使用。

## 一、 安装步骤

### Chrome / Edge

1.  **打开扩展程序页面**
    在 Chrome 浏览器地址栏输入并访问：
    `chrome://extensions/`

2.  **开启开发者模式**
    点击页面右上角的 **“开发者模式”** 开关。
    ![开启开发者模式](image.png)

3.  **载入插件**
    将解压后的插件目录直接 **拖拽** 到浏览器页面中，或点击“加载已解压的扩展程序”选择该目录。
    ![安装插件](image-1.png)

### Firefox / Zen Browser

1.  **打开调试扩展页**
    在地址栏输入：
    `about:debugging#/runtime/this-firefox`

2.  **先生成 Gecko 临时加载包**
    运行：
    `./scripts/build_gecko_temp_bundle.sh`

3.  **临时加载扩展**
    解压 `dist/firefox/flow2api_token_updater-gecko-temp-<version>.zip`，然后点击
    **“Load Temporary Add-on / 临时加载附加组件”**，选择解压后目录里的 `manifest.json`。

4.  **注意事项**
    这是开发态安装方式，浏览器重启后需要重新加载一次。
    未签名的 `.xpi` 在 Firefox / Zen 的 `about:addons` 正式安装路径里通常会显示“附加组件似乎已损坏”，这不是代码损坏，而是签名校验未通过。
    Firefox / Zen 不要直接加载仓库根目录的 `manifest.json`。仓库根目录是给 Chromium 和 Gecko 共用的开发源，Gecko 请优先使用上面生成的临时包，或下面的运行脚本。
    如果要做长期安装，需要签名后的 XPI 包，或使用允许未签名扩展的开发版环境。

5.  **命令行启动开发态临时扩展**
    如果不想每次手动点 `about:debugging`，可以直接运行：
    `./scripts/run_gecko_dev.sh`

    如果你的 Zen 可执行文件不叫 `firefox`，可以显式指定：
    `GECKO_BINARY=/path/to/zen-browser ./scripts/run_gecko_dev.sh`

    如果你要在某个固定 profile 里启动：
    `GECKO_BINARY=/path/to/zen-browser GECKO_PROFILE=/path/to/profile ./scripts/run_gecko_dev.sh`

## 二、 配置指南

1.  **填写连接信息**
    点击插件图标，只需要填写一个：
    - **Flow2API Base URL**

    例如：
    `https://your-flow2api.example.com`

    如果当前浏览器已经登录这个 Base URL 对应的 Flow2API 控制台，扩展会自动读取插件连接配置，不再要求手动复制接口地址和连接 Token。
    ![配置界面](image-2.png)

2.  **首次连接**
    点击 `连接并同步`。
    - 如果控制台已登录：扩展会自动完成连接并立刻同步。
    - 如果控制台未登录：扩展会自动打开 Flow2API 控制台，登录后再回到扩展点一次即可。

3.  **自动同步**
    连接成功后，扩展会监听 `labs.google` 的 session cookie 变化自动同步，并保留后台兜底检查；用户不需要再理解“账号配置 / 会话来源 / 刷新时间”这类概念。

4.  **获取配置信息**
    如果您不知道 Flow2API 控制台地址，请先打开自己的 Flow2API 管理后台，然后把它的站点根地址填到扩展里即可。
    ![后台查看配置](image-3.png)

## 三、Zen 多 Profile 推荐方案

如果你像现在这样有 **13 个 profiles**，其中只有 **7 个 Google 账号** 分布在不同 profile 里，并且这些账号都能登录 Flow，推荐按下面的思路配置：

1.  只在真正持有 Google Labs 登录态的 profile 里安装和配置扩展。
2.  每个要用的 profile 里各填一次 `Base URL`。
3.  如果同一个 Google 账号同时登录在多个 profile，只选一个 profile 启用定时同步。
4.  其余 profile 可以不装扩展，或者装了但不保存配置。
5.  不要让多个 profile 长期对同一套 Flow2API 账号池反复覆盖同一个 Google 账号，否则通常是谁最后同步谁覆盖。

## 四、 隐私与存储说明

- 扩展会读取 `labs.google` 的登录 Cookie，并提取 `__Secure-next-auth.session-token`
- 当用户填写 `Base URL` 且同浏览器已登录 Flow2API 控制台时，扩展会临时读取控制台的本地登录状态，以自动获取插件连接 Token
- 提取到的登录态只会发送到用户自己填写的 `Base URL` 对应的 Flow2API 接口
- 自动发现到的连接 Token 始终仅保存在当前浏览器本地，不写入浏览器同步存储
- `Base URL` 等连接配置也仅保存在当前浏览器 profile 本地
- 更多说明见 [privacy.html](privacy.html)

## 五、 上架前建议

- 如果要发布到扩展市场，建议准备一个可公开访问的 HTTPS 隐私政策页面
- Chrome Web Store 会重点检查敏感权限、数据用途与隐私披露
- Firefox / Zen 生态通常需要签名后的 XPI 包
