#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadAmoCredentials } = require(path.join(ROOT_DIR, 'scripts', 'amo_credentials.js'));
const API_BASE = process.env.AMO_API_BASE || 'https://addons.mozilla.org/api/v5';
const ADDON_ID = (process.env.AMO_ADDON_ID || 'flow2api-token-updater').trim();
const { apiKey: API_KEY, apiSecret: API_SECRET } = loadAmoCredentials(ROOT_DIR);
const UPLOAD_TIMEOUT_MS = Number(process.env.AMO_UPLOAD_TIMEOUT_MS || 120000);
const UPLOAD_POLL_INTERVAL_MS = Number(process.env.AMO_UPLOAD_POLL_INTERVAL_MS || 2000);
const ALLOW_THROTTLE_SKIP = `${process.env.AMO_ALLOW_THROTTLE_SKIP || '1'}` !== '0';
const AMO_LISTED_ENABLED = `${process.env.AMO_LISTED_ENABLED || '0'}` === '1';


const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'manifest.json'), 'utf8')
);
const metadata = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'store/amo/metadata.listed.json'), 'utf8')
);
const eulaPolicy = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'store/amo/eula-policy.json'), 'utf8')
);
const packagePath = path.join(
    ROOT_DIR,
    'web-ext-artifacts',
    `flow2api-token-updater-amo-${manifest.version}.zip`
);

async function main() {
    if (!AMO_LISTED_ENABLED) {
        console.log('AMO listed release is disabled by default during testing. Set AMO_LISTED_ENABLED=1 to publish.');
        return;
    }

    ensureFileExists(packagePath);

    const currentAddon = await getAddon();
    const currentVersion = currentAddon.current_version?.version || null;
    if (currentVersion === manifest.version) {
        console.log(`AMO already points at listed version ${manifest.version}`);
        if (currentAddon.current_version?.edit_url) {
            console.log(`AMO edit URL: ${currentAddon.current_version.edit_url}`);
        }
        return;
    }

    try {
        await updateAddonListing();
        await updateAddonEulaPolicy();

        const upload = await createUpload(packagePath);
        const processedUpload = await waitForProcessedUpload(upload);

        if (!processedUpload.valid) {
            printValidationErrors(processedUpload.validation);
            throw new Error('AMO upload validation failed');
        }

        const version = await createListedVersion({
            uploadUuid: processedUpload.uuid,
            approvalNotes: metadata.version?.approval_notes || ''
        });

        console.log(`AMO listed version created: ${version.version}`);
        console.log(`AMO version id: ${version.id}`);
        console.log(`AMO edit URL: ${version.edit_url}`);
    } catch (error) {
        if (ALLOW_THROTTLE_SKIP && isAmoThrottleError(error)) {
            console.warn(
                `AMO listed release throttled for ${manifest.version}; leaving listed channel at ${currentVersion || 'unknown'} and continuing other release channels`
            );
            return;
        }

        throw error;
    }
}

function ensureFileExists(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`AMO package not found: ${filePath}`);
    }
}

function createJwt() {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
        iss: API_KEY,
        jti: crypto.randomUUID(),
        iat: issuedAt,
        exp: issuedAt + 60
    };

    const encodedHeader = encodeBase64Url(JSON.stringify(header));
    const encodedPayload = encodeBase64Url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = crypto
        .createHmac('sha256', API_SECRET)
        .update(signingInput)
        .digest('base64url');

    return `${signingInput}.${signature}`;
}

function encodeBase64Url(value) {
    return Buffer.from(value).toString('base64url');
}

async function amoFetch(url, options = {}) {
    const headers = {
        Authorization: `JWT ${createJwt()}`,
        ...(options.headers || {})
    };

    const response = await fetch(url, {
        ...options,
        headers
    });
    const rawText = await response.text();
    let data = null;

    if (rawText) {
        try {
            data = JSON.parse(rawText);
        } catch (error) {
            data = rawText;
        }
    }

    if (!response.ok) {
        const details = typeof data === 'string'
            ? data
            : JSON.stringify(data);
        throw new Error(`AMO request failed (${response.status}): ${details}`);
    }

    return data;
}

async function getAddon() {
    return amoFetch(`${API_BASE}/addons/addon/${ADDON_ID}/`);
}

async function updateAddonListing() {
    const payload = buildListingPayload(metadata);
    if (Object.keys(payload).length === 0) {
        return;
    }

    let addon;
    try {
        addon = await amoFetch(`${API_BASE}/addons/addon/${ADDON_ID}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        if (isAmoThrottleError(error)) {
            console.warn(`AMO throttled listing metadata update for ${ADDON_ID}; continuing without PATCH`);
            return;
        }

        throw error;
    }

    console.log(`AMO listing metadata updated for addon ${addon.slug || ADDON_ID}`);
}

async function updateAddonEulaPolicy() {
    const payload = buildEulaPolicyPayload(eulaPolicy);
    if (Object.keys(payload).length === 0) {
        return;
    }

    try {
        await amoFetch(`${API_BASE}/addons/addon/${ADDON_ID}/eula_policy/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        if (isAmoThrottleError(error)) {
            console.warn(`AMO throttled privacy policy update for ${ADDON_ID}; continuing without PATCH`);
            return;
        }

        throw error;
    }

    console.log(`AMO privacy policy updated for addon ${ADDON_ID}`);
}

async function createUpload(filePath) {
    const form = new FormData();
    const filename = path.basename(filePath);
    const file = new File([fs.readFileSync(filePath)], filename, {
        type: 'application/zip'
    });

    form.append('upload', file);
    form.append('channel', 'listed');

    const upload = await amoFetch(`${API_BASE}/addons/upload/`, {
        method: 'POST',
        body: form
    });

    console.log(`AMO upload created: ${upload.uuid}`);
    return upload;
}

async function waitForProcessedUpload(upload) {
    const startedAt = Date.now();
    let current = upload;

    while (!current.processed) {
        if (Date.now() - startedAt > UPLOAD_TIMEOUT_MS) {
            throw new Error(`AMO upload processing timed out: ${current.uuid}`);
        }

        await sleep(UPLOAD_POLL_INTERVAL_MS);
        current = await amoFetch(current.url);
    }

    return current;
}

async function createListedVersion({
    uploadUuid,
    approvalNotes
}) {
    return amoFetch(`${API_BASE}/addons/addon/${ADDON_ID}/versions/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            upload: uploadUuid,
            approval_notes: approvalNotes
        })
    });
}

function printValidationErrors(validation) {
    const messages = Array.isArray(validation?.messages)
        ? validation.messages
        : [];

    if (!messages.length) {
        return;
    }

    console.error('AMO validation errors:');
    for (const message of messages) {
        console.error(`- [${message.type || 'unknown'}] ${message.message || JSON.stringify(message)}`);
    }
}

function buildListingPayload(source) {
    const payload = {};

    if (Array.isArray(source.categories) && source.categories.length > 0) {
        payload.categories = {
            firefox: source.categories
        };
    }

    if (isLocaleMap(source.summary)) {
        payload.summary = source.summary;
    }

    if (isLocaleMap(source.description)) {
        payload.description = source.description;
    }

    if (isLocaleMap(source.homepage)) {
        payload.homepage = source.homepage;
    }

    return payload;
}

function buildEulaPolicyPayload(source) {
    const payload = {};

    if (isLocaleMap(source.privacy_policy)) {
        payload.privacy_policy = source.privacy_policy;
    }

    if (isLocaleMap(source.eula)) {
        payload.eula = source.eula;
    }

    return payload;
}

function isLocaleMap(value) {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.keys(value).length > 0;
}

function isAmoThrottleError(error) {
    return /\(429\)/.test(`${error?.message || error || ''}`);
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
