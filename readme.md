# 使用说明

## 当前支持范围

- Chromium 系列：Chrome、Edge
- Firefox 系列：Firefox、Zen Browser
- 当前测试阶段默认只发布自签名 XPI 和 banana 下载页；官方 AMO listed 渠道默认停发，避免误上架测试版本
- 当前版本以浏览器 profile 为运行边界；扩展不会跨真实 profile 读取 Cookie 或共用运行状态
- 在 Firefox / Zen 里，同一 profile 下不同 cookie store / container 会分别维护自己的 Labs 会话上下文和最近同步结果；Flow2API 站点地址与插件登录配置在同一浏览器实例里统一管理
- 当前版本使用“全局 Flow2API 配置 + 各 store 独立 Labs session”模型；自动同步不再依赖后台打开 Flow2API 控制台页面
- 扩展会监听当前 profile 的 Google Labs 登录态变化，并自动同步到 Flow2API
- 扩展会记住这个 profile 上一次成功同步所用的 Labs 会话上下文，后续后台刷新会优先回到同一组 store / container
- 如果浏览器里已经存在 Google Labs / Flow2API 的登录态，即使对应页面没有打开，扩展也会在后台静默探测并自动同步

> 注意：浏览器 **profile 之间是完全隔离** 的。  
> 当前页面所在的 profile / container 只会同步自己的 Google Labs 登录态。  
> Flow2API 的 `Base URL` 和插件登录配置在同一浏览器实例内统一配置，不需要每个 store / container 都重新配置 Flow2API。
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
    只要 Firefox / Zen 提示“未经验证”或“附加组件似乎已损坏”，就把该包视为无效发布件，不要继续分发；正式用户安装只能使用验证通过的签名包。
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
    - **Flow2API 后台用户名**
    - **Flow2API 后台密码**

    例如：
    `https://your-flow2api.example.com`

    默认推荐直接填写 Flow2API 后台用户名和密码。
    扩展会临时登录后台，自动换取并保存插件专用的长期低权限 `connection_token`，然后立刻丢弃后台 session；密码默认不会落盘。
    ![配置界面](image-2.png)

2.  **首次连接**
    点击 `登录并接管同步`。
    - 扩展会先保存全局 `Base URL`。
    - 如果你输入了后台用户名和密码，扩展会临时登录后台并换取 `connection_token`。
    - 登录成功后，设置区会自动折叠；后续打开 popup 时会默认先同步当前 store。
    - 日常自动同步只使用 `connection_token`，不再依赖后台打开控制台页，也不再依赖后台登录 session 常驻有效。
    - 如果当前 profile 已经具备 Google Labs 登录态，但你没开 Labs 页面：扩展会后台静默打开一次 Labs flow 页面完成会话发现，然后自动关闭。

3.  **自动同步**
    连接成功后，扩展会监听 `labs.google` 的 session cookie 变化自动同步，并保留浏览器启动检查与后台兜底检查；必要时会静默唤醒一个 Labs 页面来刷新当前 profile 当前容器 / store 的会话识别。
    popup 里现在可以给当前 store 选三种管理模式：`主动管理`、`轻量跟随`、`停用`。只有 `主动管理` 的 store 会参与后台定时检查和静默唤醒；`轻量跟随` 只会在你自己登录、切换账号或 Cookie 变化时顺手同步；`停用` 则完全不参与后台自动逻辑。
    扩展的调度不再使用浏览器 Cookie 标注的过期时间来决定刷新时机，因为这个值在 Labs 上并不可靠。现在会优先使用 Flow2API 返回的账号过期时间提前刷新；如果暂时拿不到账号过期时间，后台会按更积极的探测策略继续补齐元数据，然后才退回 popup 里可配置的“后台保底刷新”间隔。对于看起来还很新、但实际上已经过期的旧 Labs Cookie，扩展会先尝试向 Flow2API 验证可用性；验证失败的旧 Cookie 会被忽略，不会再覆盖已有 token。
    如果只是 Labs session 过期、但浏览器登录仍有效，扩展会优先后台自动恢复。如果 `connection_token` 被后台改掉或失效，扩展会明确报错提示你更新，而不会再去混用更高权限凭证自动“猜”回来。如果恢复失败，会按失败次数逐步退避重试，不再高频打扰所有 store；通知里也会带上最近识别到的账号与 Flow2API 站点，方便你判断是哪个 profile。
    打开 popup 默认只读取当前 profile 已缓存的状态，不会因为你只是看一眼就主动打开 Flow2API / Labs 页面；如果你想立即重新探测当前账号或连接状态，用 popup 里的 `刷新当前状态`。popup 还会直接显示当前 store 的 `下次检查` 和触发策略，方便判断后台自动刷新有没有真正排上。

4.  **获取配置信息**
    如果您不知道 Flow2API 控制台地址，请先打开自己的 Flow2API 管理后台，然后把它的站点根地址填到扩展里即可。
    ![后台查看配置](image-3.png)

## 三、 故障排查

1.  **先看扩展自己的诊断日志**
    点扩展图标，然后点 `查看诊断日志`。
    这里会显示最近 120 条后台日志，包括：
    - 当前是哪个 profile / cookie store 在同步
    - 自动刷新什么时候被安排
    - 是 Labs 会话没找到、Cookie 已失效，还是 Flow2API 连接 Token 失效
    日志页默认只看当前页面所属的 profile / cookie store，并附带少量全局事件；如果你要横向看所有 store，再切到 `查看全部`。

2.  **需要反馈问题时直接复制诊断**
    在日志页点 `复制诊断`，会把当前 profile 的同步状态、浏览器信息和最近日志一起复制出来，方便直接贴出来分析。
    导出的诊断会自动隐藏原始 Flow2API 连接 Token，不会直接把生产 token 带出去。

3.  **如果日志还不够，再看 Firefox / Zen 的扩展调试页**
    打开 `about:debugging#/runtime/this-firefox`
    找到 `Flow2API Token Updater`
    点 `Inspect`
    这里能看到扩展后台脚本的实时 `console` 输出和报错堆栈。

## 四、Zen 多 Profile 推荐方案

如果你像现在这样有 **13 个 profiles**，其中只有 **7 个 Google 账号** 分布在不同 profile 里，并且这些账号都能登录 Flow，推荐按下面的思路配置：

1.  只在真正持有 Google Labs 登录态的 profile 里安装和配置扩展。
2.  Flow2API 一般只要先接入一次。
    配好 `Base URL` 和后台登录配置后，这个浏览器实例里的其他 container / store 都会共用同一套 Flow2API 控制面；真正按 profile / container 隔离的是 Google Labs 登录态、最近同步结果和会话上下文。
3.  如果同一个 Google 账号同时登录在多个 profile，只选一个 profile 启用定时同步。
4.  其余 profile 可以不装扩展，或者装了但不保存配置。
5.  不要让多个 profile 长期对同一套 Flow2API 账号池反复覆盖同一个 Google 账号，否则通常是谁最后同步谁覆盖。

## 五、 隐私与存储说明

- 扩展会读取 `labs.google` 的登录 Cookie，并提取 `__Secure-next-auth.session-token`
- 当用户填写 `Base URL + 用户名/密码` 后，扩展会临时调用 `/api/login` 和 `/api/plugin/config` 获取 `connection_token`，然后立即丢弃后台 session
- 日常自动刷新只会用这个低权限 `connection_token` 调用 `/api/plugin/update-token`
- 当浏览器里存在现有登录态但页面未打开时，扩展可能会后台静默打开 `labs.google` 的 flow 页面，以发现当前 profile 可用的会话，然后自动关闭临时标签页
- 提取到的登录态只会发送到用户自己填写的 `Base URL` 对应的 Flow2API 接口
- 当前 profile 的同步状态和运行日志仅保存在当前浏览器 profile 本地；在 Firefox / Zen 里，最近一次同步结果和 Labs 会话上下文还会按 cookie store / container 分开保存
- `Base URL`、插件连接令牌、最近一次同步结果和日志都只保存在当前浏览器本地；后台密码默认不会持久化保存；其中 Flow2API 全局配置可以在同一浏览器实例内复用，但不会同步到别的浏览器安装
- 更多说明见 [privacy.html](privacy.html)

## 六、 上架前建议

- 如果要发布到扩展市场，建议准备一个可公开访问的 HTTPS 隐私政策页面
- Chrome Web Store 会重点检查敏感权限、数据用途与隐私披露
- Firefox / Zen 生态通常需要签名后的 XPI 包；长期使用建议走自分发签名包 + `updates.json` 自动更新链
- 默认的一键发布命令 `./scripts/release_all.sh` 只会发布自签名 XPI、GitHub Release 和 banana 下载页；如果需要同时推官方市场：
  - AMO listed：`RELEASE_WITH_AMO_LISTED=1 ./scripts/release_all.sh`
  - Chrome Web Store：`RELEASE_WITH_CWS=1 ./scripts/release_all.sh`
  - 仓库里也提供了单独的 Chrome 提交流程：`./scripts/sign_cws.sh`

## 七、 开发测试

- 统一测试入口：`npm test`
- 只跑纯 Node 单元测试：`npm run test:unit`
- 只跑扩展后台 smoke 测试：`npm run test:smoke`

当前测试基于 Node 内置测试运行器和本地 mock harness，不依赖真实浏览器安装；适合在改动 `background.js` 的同步策略、调度规则和 store 隔离逻辑后快速回归。
