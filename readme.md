# 使用说明

## 当前支持范围

- Chromium 系列：Chrome、Edge
- Firefox 系列：Firefox、Zen Browser
- 当前测试阶段默认只发布自签名 XPI 和 banana 下载页；官方 AMO listed 渠道默认停发，避免误上架测试版本
- 当前版本以浏览器 profile 为运行边界；扩展不会跨真实 profile 读取 Cookie 或共用运行状态
- 在 Firefox / Zen 里，同一 profile 下不同 cookie store / container 会分别维护自己的 Labs 会话上下文和最近同步结果；Flow2API 地址与连接 Token 在同一浏览器里可以复用
- 如果当前浏览器已经登录同域名的 Flow2API 控制台，扩展会自动读取插件连接 Token
- 扩展会监听当前 profile 的 Google Labs 登录态变化，并自动同步到 Flow2API
- 扩展会记住这个 profile 上一次成功同步所用的 Labs 会话上下文，后续后台刷新会优先回到同一组 store / container
- 如果浏览器里已经存在 Google Labs / Flow2API 的登录态，即使对应页面没有打开，扩展也会在后台静默探测并自动同步

> 注意：浏览器 **profile 之间是完全隔离** 的。  
> 当前页面所在的 profile / container 只会同步自己的 Google Labs 登录态。  
> Flow2API 的 `Base URL` 和连接 Token 在同一浏览器实例内可以复用，不需要每个 profile / container 都重新登录 Flow2API。  
> 在 Firefox / Zen 里，不同 container / cookie store 仍会分别维护自己的最近同步结果和 Labs 会话上下文。  
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
    如果要做长期安装，请优先使用签名后的自更新 XPI：`https://banana.rematrixed.com/downloads/latest-firefox-selfhost.xpi`。
    临时加载扩展不会自动更新；如果你有很多 profile，需要无感更新，不要继续走临时加载路径。

5.  **命令行启动开发态临时扩展**
    如果不想每次手动点 `about:debugging`，可以直接运行：
    `./scripts/run_gecko_dev.sh`

    如果你的 Zen 可执行文件不叫 `firefox`，可以显式指定：
    `GECKO_BINARY=/path/to/zen-browser ./scripts/run_gecko_dev.sh`

    如果你要在某个固定 profile 里启动：
    `GECKO_BINARY=/path/to/zen-browser GECKO_PROFILE=/path/to/profile ./scripts/run_gecko_dev.sh`

## 二、 配置指南

1.  **填写连接信息**
    第一次点击插件图标时，为当前浏览器填写一次：
    - **Flow2API Base URL**

    例如：
    `https://your-flow2api.example.com`

    如果当前浏览器任意一个可访问的 Flow2API 控制台页已经登录这个 Base URL，扩展会自动读取插件连接配置，不再要求手动复制接口地址和连接 Token。拿到连接 Token 后，其他 profile / container 可以直接复用，不需要每个都重新登录 Flow2API。
    ![配置界面](image-2.png)

2.  **首次连接**
    点击 `连接并同步`。
    - 如果浏览器里已经保留了 Flow2API 控制台登录态：扩展会在后台自动读取连接配置并立刻同步。
    - 如果当前 profile 已经具备 Google Labs 登录态，但你没开 Labs 页面：扩展会后台静默打开一次 Labs 页面完成会话发现，然后自动关闭。
    - 只有在 Flow2API 控制台确实未登录时，扩展才会把控制台打开到前台，提示你手动登录。

3.  **自动同步**
    连接成功后，扩展会监听 `labs.google` 的 session cookie 变化自动同步，并保留浏览器启动检查与后台兜底检查；必要时会静默唤醒一次或多次 Labs 页面来刷新当前 profile 当前容器 / store 的会话识别。
    扩展的调度不再只依赖 Cookie 标注过期时间，而会结合 Flow2API 返回的账号过期时间、Cookie 时间和后台启发式探测节奏，尽量提前发现会话失效。对于看起来还很新、但实际上已经过期的旧 Labs Cookie，扩展会先尝试向 Flow2API 验证可用性；验证失败的旧 Cookie 会被忽略，不会再覆盖已有 token。
    如果只是 Labs session 过期、但浏览器登录仍有效，扩展会优先后台自动恢复；如果 Flow2API 插件连接 Token 失效但控制台登录仍有效，扩展也会后台重取连接配置再重试。如果恢复失败，会继续自动重试，并在通知里带上最近识别到的账号与 Flow2API 站点，方便你判断是哪个 profile。

4.  **获取配置信息**
    如果您不知道 Flow2API 控制台地址，请先打开自己的 Flow2API 管理后台，然后把它的站点根地址填到扩展里即可。
    ![后台查看配置](image-3.png)

## 三、Zen 多 Profile 推荐方案

如果你像现在这样有 **13 个 profiles**，其中只有 **7 个 Google 账号** 分布在不同 profile 里，并且这些账号都能登录 Flow，推荐按下面的思路配置：

1.  只在真正持有 Google Labs 登录态的 profile 里安装和配置扩展。
2.  Flow2API 一般只要先接入一次。
    拿到 `Base URL` 和插件连接 Token 后，其他要用的 profile / container 可以直接复用这套 Flow2API 连接；真正按 profile / container 隔离的是 Google Labs 登录态、最近同步结果和会话上下文。
3.  如果同一个 Google 账号同时登录在多个 profile，只选一个 profile 启用定时同步。
4.  其余 profile 可以不装扩展，或者装了但不保存配置。
5.  不要让多个 profile 长期对同一套 Flow2API 账号池反复覆盖同一个 Google 账号，否则通常是谁最后同步谁覆盖。

## 四、 隐私与存储说明

- 扩展会读取 `labs.google` 的登录 Cookie，并提取 `__Secure-next-auth.session-token`
- 当用户填写 `Base URL` 且同浏览器已登录 Flow2API 控制台时，扩展会临时读取控制台的本地登录状态，以自动获取插件连接 Token
- 当浏览器里存在现有登录态但页面未打开时，扩展可能会后台静默打开 `labs.google` 或 `Flow2API /manage` 页面，以发现当前 profile 可用的会话，然后自动关闭临时标签页
- 提取到的登录态只会发送到用户自己填写的 `Base URL` 对应的 Flow2API 接口
- 当前 profile 的同步状态和运行日志仅保存在当前浏览器 profile 本地；在 Firefox / Zen 里，最近一次同步结果和 Labs 会话上下文还会按 cookie store / container 分开保存
- `Base URL`、插件连接 Token、最近一次同步结果和日志都只保存在当前浏览器本地；其中 Flow2API 连接配置可以在同一浏览器实例内复用，但不会同步到别的浏览器安装
- 更多说明见 [privacy.html](privacy.html)

## 五、 上架前建议

- 如果要发布到扩展市场，建议准备一个可公开访问的 HTTPS 隐私政策页面
- Chrome Web Store 会重点检查敏感权限、数据用途与隐私披露
- Firefox / Zen 生态通常需要签名后的 XPI 包；长期使用建议走自分发签名包 + `updates.json` 自动更新链
- 默认的一键发布命令 `./scripts/release_all.sh` 只会发布自签名 XPI、GitHub Release 和 banana 下载页；如果未来需要恢复官方 AMO listed，请显式使用 `RELEASE_WITH_AMO_LISTED=1 ./scripts/release_all.sh`
