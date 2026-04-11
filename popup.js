const extensionApi = globalThis.browser ?? globalThis.chrome;

const state = {
    apiUrl: '',
    connectionToken: '',
    browserInfo: null
};

let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadSetupData();
});

function bindEvents() {
    document.getElementById('saveBtn').addEventListener('click', saveSettings);
    document.getElementById('testBtn').addEventListener('click', syncNow);

    document.getElementById('logsBtn').addEventListener('click', () => {
        window.location.href = 'logs.html';
    });
}

async function loadSetupData() {
    try {
        showStatus('正在加载当前 profile 配置...', 'info');

        const response = await extensionApi.runtime.sendMessage({
            action: 'getSetupData'
        });

        if (!response || !response.success) {
            throw new Error(response?.error || '加载配置失败');
        }

        state.apiUrl = response.settings.apiUrl || '';
        state.connectionToken = response.settings.connectionToken || '';
        state.browserInfo = response.browserInfo || null;

        render();
        showStatus('配置已加载', 'success');
    } catch (error) {
        showStatus(`加载失败：${error.message}`, 'error');
    }
}

function render() {
    document.getElementById('apiUrl').value = state.apiUrl;
    document.getElementById('connectionToken').value = state.connectionToken;
    renderEnvironmentHint();
}

function renderEnvironmentHint() {
    const browserName = state.browserInfo?.name
        ? `${state.browserInfo.name} ${state.browserInfo.version || ''}`.trim()
        : '当前浏览器';

    document.getElementById('environmentHint').textContent =
        `${browserName} 已连接。这个扩展按“每个浏览器 profile 一套配置”工作。` +
        '在每个要同步的 Zen / Firefox profile 里各填一次 API URL 和 Token 即可。' +
        '保存后会读取这个 profile 的默认 Google Labs 登录态，并每 60 分钟自动同步一次。';
}

function collectSettings() {
    const apiUrl = document.getElementById('apiUrl').value.trim();
    const connectionToken = document.getElementById('connectionToken').value.trim();

    if (!apiUrl || !connectionToken) {
        throw new Error('请填写完整的连接接口和连接 Token');
    }

    if (!/^https?:\/\//i.test(apiUrl)) {
        throw new Error('连接接口必须是 http 或 https URL');
    }

    return {
        apiUrl,
        connectionToken
    };
}

async function saveSettings() {
    try {
        const settings = collectSettings();

        showStatus('正在保存当前 profile 配置...', 'info');

        const response = await extensionApi.runtime.sendMessage({
            action: 'saveSettings',
            settings
        });

        if (!response || !response.success) {
            throw new Error(response?.error || '保存失败');
        }

        state.apiUrl = response.settings.apiUrl || settings.apiUrl;
        state.connectionToken = response.settings.connectionToken || settings.connectionToken;

        render();
        showStatus('已保存。这个 profile 现在会定时同步。', 'success');
    } catch (error) {
        showStatus(error.message, 'error');
    }
}

async function syncNow() {
    try {
        const settings = collectSettings();

        showStatus('正在同步当前 profile 的 session...', 'info');

        const response = await extensionApi.runtime.sendMessage({
            action: 'testNow',
            account: {
                name: '当前浏览器 profile',
                apiUrl: settings.apiUrl,
                connectionToken: settings.connectionToken,
                syncSource: 'default',
                cookieStoreId: ''
            }
        });

        if (!response || !response.success) {
            throw new Error(response?.error || '同步失败');
        }

        let statusMessage = '✅ 当前 profile 同步成功\n';
        if (response.action === 'updated') {
            statusMessage += `Token 已更新到上游\n${response.message || 'Token 更新成功'}`;
        } else if (response.action === 'added') {
            statusMessage += `Token 已添加到上游\n${response.message || 'Token 添加成功'}`;
        } else {
            statusMessage += response.message || '同步成功';
        }

        showStatus(statusMessage, 'success');
    } catch (error) {
        showStatus(`❌ 同步失败：${error.message}`, 'error');
    }
}

function showStatus(message, type) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.style.display = 'block';

    if (statusTimer) {
        clearTimeout(statusTimer);
    }

    statusTimer = setTimeout(() => {
        statusEl.style.display = 'none';
    }, 5000);
}
