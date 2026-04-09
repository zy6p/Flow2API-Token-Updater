const extensionApi = globalThis.browser ?? globalThis.chrome;

// 格式化时间
function formatTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;

    // 如果是今天
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // 如果是昨天
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    // 其他日期
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function createEmptyState(icon, text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';

    const iconEl = document.createElement('div');
    iconEl.className = 'empty-state-icon';
    iconEl.textContent = icon;

    const textEl = document.createElement('div');
    textEl.textContent = text;

    wrapper.appendChild(iconEl);
    wrapper.appendChild(textEl);

    return wrapper;
}

// 渲染日志
function renderLogs(logs) {
    const container = document.getElementById('logsContainer');
    container.replaceChildren();

    if (!logs || logs.length === 0) {
        container.appendChild(createEmptyState('📝', '暂无日志记录'));
        return;
    }

    logs.forEach((log) => {
        const entry = document.createElement('div');
        entry.className = `log-entry ${log.level}`;

        const header = document.createElement('div');
        header.className = 'log-header';

        const level = document.createElement('span');
        level.className = `log-level ${log.level}`;
        level.textContent = log.level;

        const time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = formatTime(log.timestamp);

        header.appendChild(level);
        header.appendChild(time);

        const message = document.createElement('div');
        message.className = 'log-message';
        message.textContent = log.message;

        entry.appendChild(header);
        entry.appendChild(message);

        if (log.details) {
            const details = document.createElement('div');
            details.className = 'log-details';
            details.textContent = JSON.stringify(log.details, null, 2);
            entry.appendChild(details);
        }

        container.appendChild(entry);
    });
}

// 加载日志
async function loadLogs() {
    const response = await extensionApi.runtime.sendMessage({ action: 'getLogs' });

    if (response && response.success) {
        renderLogs(response.logs);
        return;
    }

    const container = document.getElementById('logsContainer');
    container.replaceChildren(createEmptyState('❌', '加载日志失败'));
}

// 清空日志
async function clearLogs() {
    if (!confirm('确定要清空所有日志吗？')) {
        return;
    }

    const response = await extensionApi.runtime.sendMessage({ action: 'clearLogs' });
    if (response && response.success) {
        loadLogs();
    }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadLogs();

    // 刷新按钮
    document.getElementById('refreshBtn').addEventListener('click', loadLogs);

    // 清空按钮
    document.getElementById('clearBtn').addEventListener('click', clearLogs);

    // 返回按钮
    document.getElementById('backBtn').addEventListener('click', () => {
        window.location.href = 'popup.html';
    });

    // 自动刷新（每5秒）
    setInterval(loadLogs, 5000);
});
