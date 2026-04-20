#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function loadCwsCredentials(rootDir) {
    const envCredentials = normalizeCredentials({
        clientId: process.env.CWS_CLIENT_ID,
        clientSecret: process.env.CWS_CLIENT_SECRET,
        refreshToken: process.env.CWS_REFRESH_TOKEN,
        publisherId: process.env.CWS_PUBLISHER_ID,
        extensionId: process.env.CWS_EXTENSION_ID
    });

    if (hasMinimumOAuthCredentials(envCredentials)) {
        return envCredentials;
    }

    const localPath = path.join(rootDir, '.chrome-web-store-credentials.txt');
    if (!fs.existsSync(localPath)) {
        throw new Error(
            'CWS_CLIENT_ID, CWS_CLIENT_SECRET, and CWS_REFRESH_TOKEN are required, or .chrome-web-store-credentials.txt must exist.'
        );
    }

    const raw = fs.readFileSync(localPath, 'utf8');
    const parsedCredentials = normalizeCredentials({
        clientId: matchShellValue(raw, 'CWS_CLIENT_ID'),
        clientSecret: matchShellValue(raw, 'CWS_CLIENT_SECRET'),
        refreshToken: matchShellValue(raw, 'CWS_REFRESH_TOKEN'),
        publisherId: matchShellValue(raw, 'CWS_PUBLISHER_ID'),
        extensionId: matchShellValue(raw, 'CWS_EXTENSION_ID')
    });

    if (hasMinimumOAuthCredentials(parsedCredentials)) {
        return parsedCredentials;
    }

    throw new Error('Unable to parse Chrome Web Store credentials from .chrome-web-store-credentials.txt');
}

function normalizeCredentials(raw = {}) {
    return {
        clientId: `${raw.clientId || ''}`.trim(),
        clientSecret: `${raw.clientSecret || ''}`.trim(),
        refreshToken: `${raw.refreshToken || ''}`.trim(),
        publisherId: `${raw.publisherId || ''}`.trim(),
        extensionId: `${raw.extensionId || ''}`.trim()
    };
}

function hasMinimumOAuthCredentials(credentials) {
    return Boolean(
        credentials.clientId
        && credentials.clientSecret
        && credentials.refreshToken
    );
}

function matchShellValue(raw, key) {
    const regex = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?${escapeRegex(key)}=(["']?)([^\\n]*)\\1`, 'm');
    const match = raw.match(regex);
    if (!match) {
        return '';
    }

    return `${match[2] || ''}`.trim();
}

function escapeRegex(value) {
    return `${value}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    loadCwsCredentials
};
