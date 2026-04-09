# 使用说明

## 当前支持范围

- Chromium 系列：Chrome、Edge
- Firefox 系列：Firefox、Zen Browser
- 一个浏览器 profile 内支持多套账号配置
- Zen / Firefox 可按默认会话、当前活动标签、或固定 cookie store 绑定不同用户

> 注意：浏览器 **profile 之间是完全隔离** 的。  
> 如果你有多个 Zen / Firefox profile，需要在每个 profile 里分别安装一份扩展；同一个 profile 里的多账号，才可以通过工作区 / 容器 / cookie store 区分。

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

2.  **临时加载扩展**
    点击 **“Load Temporary Add-on / 临时加载附加组件”**，选择本项目目录下的 `manifest.json` 文件。

3.  **注意事项**
    这是开发态安装方式，浏览器重启后需要重新加载一次。
    如果要做长期安装，需要签名后的 XPI 包，或使用允许未签名扩展的开发版环境。

## 二、 配置指南

1.  **新增一个或多个账号配置**
    点击插件图标，在弹出窗口中为每个账号配置：
    - **账号名称**
    - **连接接口 (API URL)**
    - **连接 Token**
    - **会话来源**
      - `默认会话 / 当前浏览器 profile`
      - `跟随当前活动标签`
      - `固定到指定 cookie store`

    刷新时间默认 60 分钟，一般情况下建议 1-6 小时。
    ![配置界面](image-2.png)

2.  **Zen / Firefox 多账号建议**
    如果你在 Zen Browser / Firefox 中使用多个工作区、容器或多套登录态：
    - 在目标工作区或容器页中打开扩展
    - 选择 `跟随当前活动标签`，或直接固定到指定 `cookie store`
    - 保存后，定时任务会按该配置对应的会话去抓取 Google Labs 登录态

3.  **获取配置信息**
    如果您不知道如何填写，请登录 **Flow2api 后台** 查看相关的接口地址和访问密钥。
    ![后台查看配置](image-3.png)
