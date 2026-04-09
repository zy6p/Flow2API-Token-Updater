const extensionApi = globalThis.browser ?? globalThis.chrome;

const state = {
    accounts: [],
    selectedAccountId: null,
    storeOptions: [],
    browserInfo: null
};

let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadSetupData();
});

function bindEvents() {
    document.getElementById('accountSelect').addEventListener('change', (event) => {
        commitCurrentAccount();
        state.selectedAccountId = event.target.value;
        renderCurrentAccount();
    });

    document.getElementById('addAccountBtn').addEventListener('click', () => {
        commitCurrentAccount();

        const account = createEmptyAccount(`账号 ${state.accounts.length + 1}`);
        state.accounts.push(account);
        state.selectedAccountId = account.id;

        render();
        showStatus('已新增账号配置，填写后保存即可', 'info');
    });

    document.getElementById('removeAccountBtn').addEventListener('click', () => {
        commitCurrentAccount();

        const currentAccount = getCurrentAccount();
        if (!currentAccount) {
            return;
        }

        if (state.accounts.length === 1) {
            state.accounts = [createEmptyAccount('默认账号')];
            state.selectedAccountId = state.accounts[0].id;
            render();
            showStatus('已清空当前账号配置', 'info');
            return;
        }

        const accountName = currentAccount.name || '未命名账号';
        if (!confirm(`确定删除账号配置“${accountName}”吗？`)) {
            return;
        }

        state.accounts = state.accounts.filter((account) => account.id !== currentAccount.id);
        state.selectedAccountId = state.accounts[0]?.id || null;

        render();
        showStatus(`已删除账号配置：${accountName}`, 'success');
    });

    document.getElementById('syncSource').addEventListener('change', () => {
        updateCookieStoreVisibility();
    });

    document.getElementById('saveBtn').addEventListener('click', saveSettings);
    document.getElementById('testBtn').addEventListener('click', testCurrentAccount);

    document.getElementById('logsBtn').addEventListener('click', () => {
        window.location.href = 'logs.html';
    });
}

async function loadSetupData() {
    try {
        showStatus('正在加载配置和浏览器会话...', 'info');

        const response = await extensionApi.runtime.sendMessage({
            action: 'getSetupData'
        });

        if (!response || !response.success) {
            throw new Error(response?.error || '加载配置失败');
        }

        state.accounts = response.settings.accounts?.length
            ? response.settings.accounts
            : [createEmptyAccount('默认账号')];
        state.selectedAccountId = state.accounts[0].id;
        state.storeOptions = response.storeOptions || [];
        state.browserInfo = response.browserInfo || null;

        document.getElementById('refreshInterval').value = response.settings.refreshInterval || 60;

        render();
        showStatus('配置已加载', 'success');
    } catch (error) {
        showStatus(`加载失败：${error.message}`, 'error');
    }
}

function render() {
    renderAccountSelector();
    renderCurrentAccount();
    renderEnvironmentHint();
}

function renderAccountSelector() {
    const select = document.getElementById('accountSelect');
    select.innerHTML = '';

    state.accounts.forEach((account, index) => {
        const option = document.createElement('option');
        option.value = account.id;
        option.textContent = account.name || `账号 ${index + 1}`;
        select.appendChild(option);
    });

    if (!state.selectedAccountId && state.accounts.length) {
        state.selectedAccountId = state.accounts[0].id;
    }

    select.value = state.selectedAccountId || state.accounts[0]?.id || '';
}

function renderCurrentAccount() {
    let currentAccount = getCurrentAccount();

    if (!currentAccount) {
        currentAccount = createEmptyAccount('默认账号');
        state.accounts = [currentAccount];
        state.selectedAccountId = currentAccount.id;
        renderAccountSelector();
    }

    document.getElementById('accountName').value = currentAccount.name || '';
    document.getElementById('apiUrl').value = currentAccount.apiUrl || '';
    document.getElementById('connectionToken').value = currentAccount.connectionToken || '';
    document.getElementById('syncSource').value = currentAccount.syncSource || 'default';

    renderCookieStoreOptions(currentAccount.cookieStoreId);
    updateCookieStoreVisibility();
}

function renderCookieStoreOptions(selectedStoreId = '') {
    const select = document.getElementById('cookieStoreId');
    const storeOptions = state.storeOptions.filter((option) => (
        option.value !== 'default' && option.value !== 'activeTab'
    ));

    select.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = storeOptions.length
        ? '请选择要绑定的 cookie store'
        : '当前未检测到可固定绑定的 cookie store';
    select.appendChild(placeholder);

    storeOptions.forEach((option) => {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.description
            ? `${option.label} (${option.description})`
            : option.label;
        select.appendChild(element);
    });

    select.value = selectedStoreId || '';
}

function renderEnvironmentHint() {
    const environmentHint = document.getElementById('environmentHint');
    const browserName = state.browserInfo?.name
        ? `${state.browserInfo.name} ${state.browserInfo.version || ''}`.trim()
        : '当前浏览器';
    const manualStoreCount = state.storeOptions.filter((option) => (
        option.value !== 'default' && option.value !== 'activeTab'
    )).length;
    const supportsActiveTab = state.storeOptions.some((option) => option.value === 'activeTab');

    let message = `${browserName} 已连接。`;
    if (supportsActiveTab) {
        message += ' 已检测到可按当前活动标签区分的会话，适合 Zen / Firefox 的工作区、容器或多账号。';
    } else {
        message += ' 当前更适合使用默认会话，Chrome / Edge 一般直接这样配置即可。';
    }

    if (manualStoreCount > 0) {
        message += ` 另外发现 ${manualStoreCount} 个可手动绑定的 cookie store。`;
    }

    environmentHint.textContent = message;
}

function updateCookieStoreVisibility() {
    const syncSource = document.getElementById('syncSource').value;
    const cookieStoreGroup = document.getElementById('cookieStoreGroup');

    cookieStoreGroup.classList.toggle('hidden', syncSource !== 'store');
}

function getCurrentAccount() {
    return state.accounts.find((account) => account.id === state.selectedAccountId) || null;
}

function commitCurrentAccount() {
    const currentAccount = getCurrentAccount();
    if (!currentAccount) {
        return;
    }

    currentAccount.name = document.getElementById('accountName').value.trim();
    currentAccount.apiUrl = document.getElementById('apiUrl').value.trim();
    currentAccount.connectionToken = document.getElementById('connectionToken').value.trim();
    currentAccount.syncSource = document.getElementById('syncSource').value;
    currentAccount.cookieStoreId = document.getElementById('cookieStoreId').value;

    renderAccountSelector();
}

async function saveSettings() {
    try {
        commitCurrentAccount();

        const refreshInterval = parseInt(document.getElementById('refreshInterval').value, 10);
        const accounts = collectAccountsForSave();

        showStatus('正在保存配置...', 'info');

        const response = await extensionApi.runtime.sendMessage({
            action: 'saveSettings',
            settings: {
                accounts,
                refreshInterval
            }
        });

        if (!response || !response.success) {
            throw new Error(response?.error || '保存失败');
        }

        const selectedAccountId = state.selectedAccountId;
        state.accounts = response.settings.accounts;
        state.selectedAccountId = state.accounts.some((account) => account.id === selectedAccountId)
            ? selectedAccountId
            : state.accounts[0]?.id || null;
        document.getElementById('refreshInterval').value = response.settings.refreshInterval;

        render();
        showStatus('配置保存成功', 'success');
    } catch (error) {
        showStatus(error.message, 'error');
    }
}

async function testCurrentAccount() {
    try {
        commitCurrentAccount();

        const currentAccount = getCurrentAccount();
        const accountToTest = validateAccount(currentAccount, 0);

        showStatus(`正在测试账号：${accountToTest.name}...`, 'info');

        const response = await extensionApi.runtime.sendMessage({
            action: 'testNow',
            account: accountToTest
        });

        if (response && response.success) {
            let statusMessage = `✅ 测试成功：${response.accountName || accountToTest.name}\n`;

            if (response.action === 'updated') {
                statusMessage += `Token 已更新到上游\n${response.message}`;
            } else if (response.action === 'added') {
                statusMessage += `Token 已添加到上游\n${response.message}`;
            } else {
                statusMessage += response.message;
            }

            if (response.sourceLabel) {
                statusMessage += `\n会话来源：${response.sourceLabel}`;
            }

            showStatus(statusMessage, 'success');
            return;
        }

        throw new Error(response?.error || '未知错误');
    } catch (error) {
        showStatus(`❌ 测试失败：${error.message}`, 'error');
    }
}

function collectAccountsForSave() {
    const rawAccounts = state.accounts
        .map((account) => ({
            ...account,
            name: account.name.trim(),
            apiUrl: account.apiUrl.trim(),
            connectionToken: account.connectionToken.trim(),
            cookieStoreId: (account.cookieStoreId || '').trim()
        }))
        .filter((account) => (
            account.name ||
            account.apiUrl ||
            account.connectionToken ||
            account.syncSource !== 'default' ||
            account.cookieStoreId
        ));

    if (!rawAccounts.length) {
        throw new Error('至少配置一个账号');
    }

    return rawAccounts.map((account, index) => validateAccount(account, index));
}

function validateAccount(account, index) {
    if (!account) {
        throw new Error(`账号 ${index + 1} 配置不存在`);
    }

    const normalized = {
        id: account.id || createId(),
        name: (account.name || '').trim() || `账号 ${index + 1}`,
        apiUrl: (account.apiUrl || '').trim(),
        connectionToken: (account.connectionToken || '').trim(),
        syncSource: account.syncSource || 'default',
        cookieStoreId: (account.cookieStoreId || '').trim()
    };

    if (!normalized.apiUrl || !normalized.connectionToken) {
        throw new Error(`账号“${normalized.name}”请填写完整的连接接口和连接 Token`);
    }

    if (!/^https?:\/\//i.test(normalized.apiUrl)) {
        throw new Error(`账号“${normalized.name}”的连接接口必须是 http 或 https URL`);
    }

    if (normalized.syncSource === 'store' && !normalized.cookieStoreId) {
        throw new Error(`账号“${normalized.name}”请选择一个固定的 cookie store`);
    }

    return normalized;
}

function createEmptyAccount(name = '') {
    return {
        id: createId(),
        name,
        apiUrl: '',
        connectionToken: '',
        syncSource: 'default',
        cookieStoreId: ''
    };
}

function createId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `acct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
