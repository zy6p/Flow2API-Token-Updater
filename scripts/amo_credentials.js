#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function loadAmoCredentials(rootDir) {
    const apiKey = `${process.env.AMO_API_KEY || ''}`.trim();
    const apiSecret = `${process.env.AMO_API_SECRET || ''}`.trim();

    if (apiKey && apiSecret) {
        return { apiKey, apiSecret, source: 'env' };
    }

    const tokenPath = path.join(rootDir, '.firefox-developers-token.txt');
    if (!fs.existsSync(tokenPath)) {
        throw new Error('AMO_API_KEY and AMO_API_SECRET are required, or .firefox-developers-token.txt must exist.');
    }

    const raw = fs.readFileSync(tokenPath, 'utf8');
    const shellKey = matchShellValue(raw, 'AMO_API_KEY');
    const shellSecret = matchShellValue(raw, 'AMO_API_SECRET');
    if (shellKey && shellSecret) {
        return { apiKey: shellKey, apiSecret: shellSecret, source: tokenPath };
    }

    const labeledKey = matchLabeledValue(raw, 'JWT 签发者');
    const labeledSecret = matchLabeledValue(raw, 'JWT 私钥');
    if (labeledKey && labeledSecret) {
        return { apiKey: labeledKey, apiSecret: labeledSecret, source: tokenPath };
    }

    throw new Error('Unable to parse AMO credentials from .firefox-developers-token.txt');
}

function matchShellValue(text, key) {
    const pattern = new RegExp(`^\s*(?:export\s+)?${escapeRegExp(key)}\s*=\s*(.+?)\s*$`, 'm');
    const match = text.match(pattern);
    if (!match) {
        return '';
    }

    return stripQuotes(match[1].trim());
}

function matchLabeledValue(text, label) {
    const pattern = new RegExp(`${escapeRegExp(label)}\s*[\r\n]+\s*([^\r\n]+)`);
    const match = text.match(pattern);
    return match ? match[1].trim() : '';
}

function stripQuotes(value) {
    if (!value) {
        return value;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }

    return value;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    loadAmoCredentials
};
