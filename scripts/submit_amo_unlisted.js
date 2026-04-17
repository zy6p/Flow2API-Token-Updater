#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadAmoCredentials } = require(path.join(ROOT_DIR, 'scripts', 'amo_credentials.js'));
const SIGNING_API_BASE = (process.env.AMO_SIGNING_API_BASE || 'https://addons.mozilla.org/api/v3').trim().replace(/\/$/, '');
const { apiKey: API_KEY, apiSecret: API_SECRET } = loadAmoCredentials(ROOT_DIR);
const PUBLIC_BASE_URL = (process.env.FLOW2API_PUBLIC_BASE_URL || 'https://banana.rematrixed.com').trim().replace(/\/$/, '');
const UPDATE_PATH = (process.env.FLOW2API_GECKO_UPDATES_PATH || '/downloads/updates.json').trim();
const POLL_TIMEOUT_MS = Number(process.env.AMO_SIGNING_TIMEOUT_MS || 600000);
const POLL_INTERVAL_MS = Number(process.env.AMO_SIGNING_POLL_INTERVAL_MS || 3000);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'manifest.json'), 'utf8'));
const BASE_VERSION = manifest.version;
const SELFHOST_VERSION = `${process.env.FLOW2API_GECKO_SELFHOST_VERSION || `${BASE_VERSION}.2`}`.trim();
const UPDATE_URL = `${PUBLIC_BASE_URL}${UPDATE_PATH}`;
const GUID = manifest.browser_specific_settings?.gecko?.id;
const OUTPUT_NAME = `flow2api_token_updater-selfhost-${SELFHOST_VERSION}.xpi`;
const OUTPUT_PATH = path.join(ROOT_DIR, 'dist', 'firefox', OUTPUT_NAME);

if (!GUID) {
    console.error('manifest browser_specific_settings.gecko.id is required for self-hosted signing.');
    process.exit(1);
}

async function main() {
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow2api-gecko-selfhost-'));
    const uploadPackage = path.join(os.tmpdir(), `flow2api_token_updater-selfhost-${SELFHOST_VERSION}-${Date.now()}.xpi`);

    try {
        prepareSelfHostedSource(stageDir, UPDATE_URL, SELFHOST_VERSION);
        zipDirectory(stageDir, uploadPackage);

        const initial = await submitOrFetchExisting(uploadPackage, SELFHOST_VERSION);
        const signed = await waitForSignedStatus(initial.url || signingStatusUrl(SELFHOST_VERSION));
        const downloadUrl = signed.files?.[0]?.download_url || '';
        if (!downloadUrl) {
            throw new Error('Mozilla signing API did not return a signed download URL');
        }

        await downloadFile(downloadUrl, OUTPUT_PATH);
        console.log(`Downloaded signed self-hosted XPI: ${OUTPUT_PATH}`);
    } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
        fs.rmSync(uploadPackage, { force: true });
    }
}

function prepareSelfHostedSource(stageDir, updateUrl, versionOverride) {
    const scriptPath = path.join(ROOT_DIR, 'scripts', 'prepare_gecko_source.sh');
    const result = spawnSync(scriptPath, [stageDir], {
        cwd: ROOT_DIR,
        env: {
            ...process.env,
            GECKO_UPDATE_URL: updateUrl,
            GECKO_VERSION_OVERRIDE: versionOverride
        },
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        throw new Error(`prepare_gecko_source.sh failed with exit code ${result.status}`);
    }
}

function zipDirectory(stageDir, outputFile) {
    const result = spawnSync('zip', ['-qr', outputFile, '.'], {
        cwd: stageDir,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        throw new Error(`zip failed with exit code ${result.status}`);
    }
}

async function submitOrFetchExisting(filePath, version) {
    try {
        const response = await signingPut(signingStatusUrl(version), filePath);
        console.log(`Submitted self-hosted signing request for ${version}`);
        return response;
    } catch (error) {
        if (!error.message.includes('(409)')) {
            throw error;
        }

        const existing = await signingGet(signingStatusUrl(version));
        console.log(`Self-hosted signing request for ${version} already exists`);
        return existing;
    }
}

function signingStatusUrl(version) {
    return `${SIGNING_API_BASE}/addons/${encodeURIComponent(GUID)}/versions/${encodeURIComponent(version)}/`;
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

async function signingGet(url) {
    return signingFetch(url, { method: 'GET' });
}

async function signingPut(url, filePath) {
    const form = new FormData();
    const filename = path.basename(filePath);
    const file = new File([fs.readFileSync(filePath)], filename, {
        type: 'application/x-xpinstall'
    });

    form.append('upload', file);
    form.append('channel', 'unlisted');

    return signingFetch(url, {
        method: 'PUT',
        body: form
    });
}

async function signingFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Authorization: `JWT ${createJwt()}`,
            ...(options.headers || {})
        }
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
        const details = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`Mozilla signing request failed (${response.status}): ${details}`);
    }

    return data;
}

async function waitForSignedStatus(statusUrl) {
    const startedAt = Date.now();
    let lastSnapshot = '';

    while (true) {
        const current = await signingGet(statusUrl);
        const file = current.files?.[0] || null;
        const snapshot = JSON.stringify({
            processed: Boolean(current.processed),
            valid: Boolean(current.valid),
            signed: Boolean(file?.signed),
            reviewed: Boolean(current.reviewed),
            active: Boolean(current.active),
            download_url: file?.download_url || ''
        });

        if (snapshot !== lastSnapshot) {
            console.log(`Self-hosted signing status: ${snapshot}`);
            lastSnapshot = snapshot;
        }

        if (current.processed && current.valid && file?.download_url) {
            return current;
        }

        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            throw new Error(`Mozilla signing request timed out for ${SELFHOST_VERSION}`);
        }

        await sleep(POLL_INTERVAL_MS);
    }
}

async function downloadFile(url, outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const response = await fetch(url, {
        headers: {
            Authorization: `JWT ${createJwt()}`
        },
        redirect: 'follow'
    });

    if (!response.ok) {
        throw new Error(`Failed to download signed XPI (${response.status}) from ${url}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
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
