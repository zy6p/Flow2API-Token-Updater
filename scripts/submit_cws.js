#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadCwsCredentials } = require(path.join(ROOT_DIR, 'scripts', 'cws_credentials.js'));

const API_BASE = (process.env.CWS_API_BASE || 'https://chromewebstore.googleapis.com').trim().replace(/\/$/, '');
const OAUTH_TOKEN_URL = (process.env.CWS_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token').trim();
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'manifest.json'), 'utf8')).version;
const DEFAULT_PACKAGE = path.join(ROOT_DIR, 'dist', 'chromium', `Flow2API-Token-Updater-chromium-${VERSION}.zip`);
const PACKAGE_PATH = path.resolve(process.env.CWS_PACKAGE_PATH || DEFAULT_PACKAGE);
const MODE = `${process.env.CWS_MODE || 'update'}`.trim().toLowerCase();
const PUBLISH_AFTER_UPLOAD = `${process.env.CWS_PUBLISH_AFTER_UPLOAD || (MODE === 'update' ? '1' : '0')}` !== '0';
const PUBLISH_TARGET = `${process.env.CWS_PUBLISH_TARGET || 'default'}`.trim();
const POLL_TIMEOUT_MS = Number(process.env.CWS_UPLOAD_TIMEOUT_MS || 120000);
const POLL_INTERVAL_MS = Number(process.env.CWS_UPLOAD_POLL_INTERVAL_MS || 3000);
const credentials = loadCwsCredentials(ROOT_DIR);

async function main() {
    ensureFileExists(PACKAGE_PATH);

    const accessToken = await refreshAccessToken();

    if (MODE === 'insert') {
        const inserted = await insertNewItem(accessToken, PACKAGE_PATH);
        console.log(`Chrome Web Store item inserted: ${inserted.id || inserted.crx_id || 'unknown-id'}`);
        console.log(`Upload state: ${inserted.uploadState || inserted.upload_state || 'unknown'}`);
        console.log('You still need to complete the Chrome Web Store listing/privacy tabs before first publish.');

        if (PUBLISH_AFTER_UPLOAD) {
            const itemId = inserted.id || inserted.crx_id || credentials.extensionId;
            if (!itemId) {
                throw new Error('Insert succeeded but no extension id was returned; cannot publish automatically.');
            }

            const published = await publishV1(accessToken, itemId);
            printPublishResult(published);
        }

        return;
    }

    if (!credentials.publisherId || !credentials.extensionId) {
        throw new Error('CWS_PUBLISHER_ID and CWS_EXTENSION_ID are required in update mode.');
    }

    const uploadResult = await uploadExistingItem(accessToken, PACKAGE_PATH);
    printUploadResult(uploadResult);

    const status = await waitForUploadStatus(accessToken);
    printStatusResult(status);

    if (!PUBLISH_AFTER_UPLOAD) {
        console.log('Skipping Chrome Web Store publish; CWS_PUBLISH_AFTER_UPLOAD=0');
        return;
    }

    const published = await publishV2(accessToken);
    printPublishResult(published);
}

function ensureFileExists(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Chrome Web Store package not found: ${filePath}`);
    }
}

async function refreshAccessToken() {
    const body = new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token'
    });

    const response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(`Google OAuth token refresh failed (${response.status}): ${stringifyPayload(payload)}`);
    }

    if (!payload.access_token) {
        throw new Error(`Google OAuth token refresh returned no access token: ${stringifyPayload(payload)}`);
    }

    return payload.access_token;
}

async function insertNewItem(accessToken, filePath) {
    const response = await fetch('https://www.googleapis.com/upload/chromewebstore/v1.1/items', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'x-goog-api-version': '2',
            'Content-Type': 'application/zip'
        },
        body: fs.readFileSync(filePath)
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(`Chrome Web Store insert failed (${response.status}): ${stringifyPayload(payload)}`);
    }

    return payload;
}

async function uploadExistingItem(accessToken, filePath) {
    const response = await fetch(
        `${API_BASE}/upload/v2/publishers/${encodeURIComponent(credentials.publisherId)}/items/${encodeURIComponent(credentials.extensionId)}:upload`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/zip'
            },
            body: fs.readFileSync(filePath)
        }
    );

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(`Chrome Web Store upload failed (${response.status}): ${stringifyPayload(payload)}`);
    }

    return payload;
}

async function waitForUploadStatus(accessToken) {
    const startedAt = Date.now();
    let current = await fetchStatus(accessToken);

    while (current.uploadState === 'UPLOAD_IN_PROGRESS') {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            throw new Error('Chrome Web Store upload processing timed out');
        }

        await sleep(POLL_INTERVAL_MS);
        current = await fetchStatus(accessToken);
    }

    return current;
}

async function fetchStatus(accessToken) {
    const response = await fetch(
        `${API_BASE}/v2/publishers/${encodeURIComponent(credentials.publisherId)}/items/${encodeURIComponent(credentials.extensionId)}:fetchStatus`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        }
    );

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(`Chrome Web Store fetchStatus failed (${response.status}): ${stringifyPayload(payload)}`);
    }

    return payload;
}

async function publishV2(accessToken) {
    const publishUrl = new URL(
        `${API_BASE}/v2/publishers/${encodeURIComponent(credentials.publisherId)}/items/${encodeURIComponent(credentials.extensionId)}:publish`
    );
    if (PUBLISH_TARGET) {
        publishUrl.searchParams.set('publishTarget', PUBLISH_TARGET);
    }

    const response = await fetch(publishUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(`Chrome Web Store publish failed (${response.status}): ${stringifyPayload(payload)}`);
    }

    return payload;
}

async function publishV1(accessToken, extensionId) {
    const publishUrl = new URL(
        `https://www.googleapis.com/chromewebstore/v1.1/items/${encodeURIComponent(extensionId)}/publish`
    );
    if (PUBLISH_TARGET) {
        publishUrl.searchParams.set('publishTarget', PUBLISH_TARGET);
    }

    const response = await fetch(publishUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'x-goog-api-version': '2'
        }
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(`Chrome Web Store v1 publish failed (${response.status}): ${stringifyPayload(payload)}`);
    }

    return payload;
}

async function parseJsonResponse(response) {
    const text = await response.text();
    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        return { raw: text };
    }
}

function printUploadResult(result) {
    console.log(`Chrome Web Store upload state: ${result.uploadState || 'unknown'}`);
    if (result.itemId) {
        console.log(`Chrome Web Store item id: ${result.itemId}`);
    }
}

function printStatusResult(result) {
    console.log(`Chrome Web Store item state: ${result.itemState || 'unknown'}`);
    console.log(`Chrome Web Store upload state: ${result.uploadState || 'unknown'}`);
    if (Array.isArray(result.validationMessages) && result.validationMessages.length > 0) {
        console.log('Chrome Web Store validation messages:');
        for (const message of result.validationMessages) {
            console.log(`- [${message.severity || 'info'}] ${message.message || JSON.stringify(message)}`);
        }
    }
}

function printPublishResult(result) {
    console.log(`Chrome Web Store publish status: ${result.status || result.itemState || 'submitted'}`);
    if (Array.isArray(result.statusDetail) && result.statusDetail.length > 0) {
        console.log(`Chrome Web Store publish details: ${result.statusDetail.join(', ')}`);
    }
    if (result.item_id || result.itemId) {
        console.log(`Chrome Web Store item id: ${result.item_id || result.itemId}`);
    }
}

function stringifyPayload(payload) {
    return typeof payload === 'string'
        ? payload
        : JSON.stringify(payload);
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
