#!/usr/bin/env node

/**
 * Qwen Media Creator - MCP Server (stdio, newline-delimited JSON)
 *
 * Exposes two tools:
 *   - generate_image: creates an image from a text prompt
 *   - generate_video: creates a video from a text prompt (with internal polling)
 *
 * Environment variables:
 *   QB_API_URL    - QwenBridge base URL (default: http://127.0.0.1:3000/v1)
 *   QB_API_KEY    - optional API key sent as Authorization: Bearer
 *   QB_MEDIA_DIR  - fallback directory for saved media
 *   QB_MEDIA_MODEL- default media model (image)
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const API_URL = (process.env.QB_API_URL || 'http://127.0.0.1:3000/v1').replace(/\/+$/, '');
const API_KEY = process.env.QB_API_KEY || '';
const DEFAULT_MODEL = process.env.QB_MEDIA_MODEL || 'qwen3-vl-plus';
const POLL_INTERVAL_MS = 5000;
const VIDEO_TIMEOUT_MS = 240000; // 4 minutes max for video generation

// Smart directory detection:
// 1. Explicit env var (QB_MEDIA_DIR)
// 2. Working directory from AionUI conversation (process.cwd()) + /generated
// 3. Fallback to hardcoded path
function detectMediaDir() {
    if (process.env.QB_MEDIA_DIR) {
        return process.env.QB_MEDIA_DIR;
    }
    const cwd = process.cwd();
    if (cwd && cwd !== path.dirname(process.execPath)) {
        return path.join(cwd, 'generated');
    }
    return path.join(__dirname, 'generated');
}

const MEDIA_DIR = detectMediaDir();

// Detailed logging for debugging (stderr, never pollutes MCP stdout)
function log(...args) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}]`, ...args);
}

log('Qwen Media Creator MCP Server starting...');
log(`API_URL: ${API_URL}`);
log(`MEDIA_DIR: ${MEDIA_DIR}`);
log(`DEFAULT_MODEL: ${DEFAULT_MODEL}`);
log(`process.cwd(): ${process.cwd()}`);

// ─── Retry Configuration ─────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const POLL_CONSECUTIVE_FAILURE_WARN = 3;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RateLimitError';
        this.isRateLimit = true;
    }
}

function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (API_KEY) {
        headers.Authorization = `Bearer ${API_KEY}`;
    }
    return headers;
}

/**
 * Fetch with retry logic for transient errors and rate limit detection.
 * - 429 → immediate throw with rate limit message
 * - 5xx → retry up to MAX_RETRIES with RETRY_DELAY_MS
 * - Network error → retry up to MAX_RETRIES
 * - 4xx (non-429) → immediate throw (client error, no retry)
 */
async function fetchWithRetry(url, options, context = 'request') {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(url, options);

            // Rate limit — do not retry, propagate immediately
            if (res.status === 429) {
                const retryAfter = res.headers.get('Retry-After');
                const body = await res.text().catch(() => '');
                const msg = `Rate limit exceeded: all Qwen accounts are temporarily blocked.${retryAfter ? ` Retry after ${retryAfter}s.` : ''}${body ? ` Details: ${body}` : ''}`;
                log(`❌ [${context}] 429 Rate Limited`);
                throw new RateLimitError(msg);
            }

            // Client error (4xx) — do not retry
            if (res.status >= 400 && res.status < 500) {
                return res;
            }

            // Server error (5xx) — retry if attempts remain
            if (res.status >= 500 && attempt < MAX_RETRIES) {
                log(`⚠️ [${context}] Transient error ${res.status}, retrying (${attempt}/${MAX_RETRIES}) in ${RETRY_DELAY_MS}ms...`);
                await sleep(RETRY_DELAY_MS);
                continue;
            }

            return res;
        } catch (e) {
            if (e instanceof RateLimitError) throw e;
            lastError = e;
            if (attempt < MAX_RETRIES) {
                log(`⚠️ [${context}] Network error: ${e.message}, retrying (${attempt}/${MAX_RETRIES}) in ${RETRY_DELAY_MS}ms...`);
                await sleep(RETRY_DELAY_MS);
            }
        }
    }
    throw lastError || new Error(`${context} failed after ${MAX_RETRIES} attempts`);
}

// ─── MCP Protocol (newline-delimited JSON over stdio) ────────────────────────

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

let messageBuffer = '';

rl.on('line', (line) => {
    if (line.trim() === '') return;
    messageBuffer += line;

    try {
        const message = JSON.parse(messageBuffer);
        messageBuffer = '';
        handleMessage(message);
    } catch (e) {
        // Continue buffering (multi-line JSON)
    }
});

function sendResponse(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'generate_image',
        description: 'Generate an image from a text description using Qwen AI. Returns a URL to the generated image and saves it locally. The URL is temporary but the local file is permanent.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Text description of the image to generate. Be specific and descriptive for best results.'
                },
                size: {
                    type: 'string',
                    enum: ['16:9', '9:16', '1:1', '4:3'],
                    description: 'Aspect ratio of the image. Default: 16:9'
                },
                model: {
                    type: 'string',
                    description: `Model to use for image generation. Default: ${DEFAULT_MODEL} (qwen3-vl-plus). Generation-specific options: qwen-image-max, qwen-image-plus, qwen-image, wan2.6-t2i, wan2.5-t2i-preview, wan2.2-t2i-flash`
                },
                save_dir: {
                    type: 'string',
                    description: 'REQUIRED: absolute path to the current conversation\'s working directory where the image should be saved. Pass the conversation working directory (temp directory or project directory). Do NOT omit this parameter — without it files are saved to a global fallback location. Example: "C:\\Users\\user\\AppData\\Roaming\\AionUi\\aionui\\conversations\\users\\system_default_user\\2026\\08\\01\\aionrs-temp-abc123"'
                },
                filename: {
                    type: 'string',
                    description: 'Optional: filename for the saved image (without path). Default: auto-generated as {timestamp}_{model}.png'
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'generate_video',
        description: 'Generate a short video from a text description using Qwen AI. Returns a URL to the generated video and saves it locally. Generation takes 30s to 3min. The URL is temporary but the local file is permanent.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Text description of the video to generate. Describe motion, scene, and style.'
                },
                size: {
                    type: 'string',
                    enum: ['16:9', '9:16', '1:1'],
                    description: 'Aspect ratio of the video. Default: 16:9'
                },
                model: {
                    type: 'string',
                    description: `Model to use for video generation. Default: ${DEFAULT_MODEL} (qwen3-vl-plus). Generation-specific options: wan2.6-t2v, wan2.6-t2v-preview, wan2.2-t2v-flash`
                },
                save_dir: {
                    type: 'string',
                    description: 'REQUIRED: absolute path to the current conversation\'s working directory where the video should be saved. Pass the conversation working directory (temp directory or project directory). Do NOT omit this parameter — without it files are saved to a global fallback location.'
                },
                filename: {
                    type: 'string',
                    description: 'Optional: filename for the saved video (without path). Default: auto-generated as {timestamp}_{model}.mp4'
                }
            },
            required: ['prompt']
        }
    }
];

// ─── Message Handler ─────────────────────────────────────────────────────────

async function handleMessage(message) {
    const { method, id, params } = message;

    switch (method) {
        case 'initialize':
            sendResponse(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'Qwen Media Creator', version: '1.1.0' }
            });
            break;

        case 'notifications/initialized':
            break;

        case 'tools/list':
            sendResponse(id, { tools: TOOLS });
            break;

        case 'tools/call':
            await handleToolCall(id, params);
            break;

        case 'ping':
            sendResponse(id, {});
            break;

        default:
            if (id !== undefined) {
                sendError(id, -32601, `Method not found: ${method}`);
            }
    }
}

async function handleToolCall(id, params) {
    const { name, arguments: args } = params || {};

    try {
        let result;

        switch (name) {
            case 'generate_image':
                result = await generateImage(args || {});
                break;
            case 'generate_video':
                result = await generateVideo(args || {});
                break;
            default:
                sendResponse(id, {
                    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                    isError: true
                });
                return;
        }

        sendResponse(id, result);
    } catch (error) {
        log(`❌ Tool error (${name}): ${error.message}`);
        sendResponse(id, {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true
        });
    }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

function generateFilename(model, ext) {
    const timestamp = Date.now();
    const safeModel = (model || 'default').replace(/[^a-z0-9-]/gi, '_');
    return `${timestamp}_${safeModel}.${ext}`;
}

async function downloadAndSave(url, saveDir, filename, defaultExt) {
    const targetDir = saveDir || MEDIA_DIR;
    log(`💾 downloadAndSave: targetDir=${targetDir}, filename=${filename}, defaultExt=${defaultExt}`);
    log(`💾 downloadAndSave: process.cwd()=${process.cwd()}`);
    log(`💾 downloadAndSave: MEDIA_DIR=${MEDIA_DIR}`);

    if (!fs.existsSync(targetDir)) {
        log(`💾 downloadAndSave: creating directory ${targetDir}`);
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetFilename = filename || generateFilename(null, defaultExt);
    const fullPath = path.join(targetDir, targetFilename);
    log(`💾 downloadAndSave: fullPath=${fullPath}`);

    // Download with retry for transient network errors
    log(`💾 downloadAndSave: fetching ${url.substring(0, 100)}...`);
    const res = await fetchWithRetry(url, {}, 'downloadMedia');
    if (!res.ok) {
        log(`❌ downloadAndSave: fetch failed with status ${res.status}`);
        throw new Error(`Failed to download media: ${res.status}`);
    }

    const buffer = await res.arrayBuffer();
    log(`💾 downloadAndSave: downloaded ${(buffer.byteLength / 1024).toFixed(1)} KB`);
    fs.writeFileSync(fullPath, Buffer.from(buffer));
    log(`💾 downloadAndSave: written to ${fullPath}`);

    // Verify file exists
    if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        log(`✅ downloadAndSave: verified file exists, size=${(stats.size / 1024).toFixed(1)} KB`);
    } else {
        log(`❌ downloadAndSave: file NOT found after write!`);
    }

    return fullPath;
}

// ─── Tool Implementations ────────────────────────────────────────────────────

async function generateImage({ prompt, size = '16:9', model = DEFAULT_MODEL, save_dir = null, filename = null }) {
    log(`📸 generateImage called: model=${model}, size=${size}, save_dir=${save_dir}, filename=${filename}`);

    const res = await fetchWithRetry(`${API_URL}/images/generations`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt, size, model })
    }, 'generateImage');

    if (!res.ok) {
        const body = await res.text();
        log(`❌ Proxy error: ${res.status} - ${body}`);
        throw new Error(`Image generation failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    log(`✅ Proxy response received`);

    if (data.error) {
        log(`❌ Error in response:`, data.error);
        throw new Error(`Image generation error: ${data.error.message || data.error}`);
    }

    const url = data.data?.[0]?.url;
    if (!url) {
        log(`❌ No URL in response`);
        throw new Error('Image generation returned no URL. The proxy may be down or the account may have hit its limit.');
    }

    log(`🔗 Image URL: ${url.substring(0, 100)}...`);

    // Download and save locally
    let localPath = null;
    try {
        log(`💾 Downloading and saving to: ${save_dir || MEDIA_DIR}`);
        localPath = await downloadAndSave(url, save_dir, filename, 'png');
        log(`✅ Saved to: ${localPath}`);
    } catch (e) {
        log(`⚠️ Failed to save image locally: ${e.message}`);
    }

    const resultText = localPath
        ? `Image generated successfully.\n\nURL: ${url}\n\nSaved to: ${localPath}\n\nIMPORTANT: You MUST include ALL of the following in your response to the user:\n1. The image inline using markdown: ![Generated image](${url})\n2. The CDN link as clickable text: [Download from CDN](${url})\n3. The local path where it was saved: ${localPath}\n4. A note that the CDN link is temporary, but the local file is permanent.`
        : `Image generated successfully.\n\nURL: ${url}\n\nIMPORTANT: You MUST include the image in your response to the user using markdown format: ![Generated image](${url})\n\nNote: This is a temporary CDN link. Tell the user to download it if they need to keep it.`;

    log(`📤 Returning result to agent`);
    return {
        content: [
            {
                type: 'text',
                text: resultText
            }
        ]
    };
}

async function generateVideo({ prompt, size = '16:9', model = DEFAULT_MODEL, save_dir = null, filename = null }) {
    log(`🎬 generateVideo called: model=${model}, size=${size}, save_dir=${save_dir}, filename=${filename}`);

    // Step 1: Create task. QwenBridge blocks until completion (wait: true), so the
    // response usually carries the final video URL inline.
    const createRes = await fetchWithRetry(`${API_URL}/videos/generations`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt, size, model, wait: true })
    }, 'generateVideo.create');

    if (!createRes.ok) {
        const body = await createRes.text();
        log(`❌ Video creation failed: ${createRes.status} - ${body}`);
        throw new Error(`Video generation failed (${createRes.status}): ${body}`);
    }

    const createData = await createRes.json();

    if (createData.error) {
        log(`❌ Video creation error:`, createData.error);
        throw new Error(`Video generation error: ${createData.error.message || createData.error}`);
    }

    // Direct URL response (no task_id)
    const directUrl = createData.data?.[0]?.url || createData.video_url;
    if (directUrl) {
        log(`✅ Direct video URL received (no polling needed)`);
        let localPath = null;
        try {
            localPath = await downloadAndSave(directUrl, save_dir, filename, 'mp4');
            log(`✅ Saved to: ${localPath}`);
        } catch (e) {
            log(`⚠️ Failed to save video locally: ${e.message}`);
        }

        const resultText = localPath
            ? `Video generated successfully.\n\nURL: ${directUrl}\n\nSaved to: ${localPath}\n\nIMPORTANT: You MUST include ALL of the following in your response to the user:\n1. The video as a clickable link: [Generated video](${directUrl})\n2. The local path where it was saved: ${localPath}\n3. A note that the CDN link is temporary, but the local file is permanent.`
            : `Video generated successfully.\n\nURL: ${directUrl}\n\nNote: This is a temporary CDN link. Download it if you need to keep it.`;

        return {
            content: [{ type: 'text', text: resultText }]
        };
    }

    const taskId = createData.task_id;
    if (!taskId) {
        throw new Error('Video generation returned no task_id. Response: ' + JSON.stringify(createData));
    }

    log(`📋 Task created: ${taskId} — starting polling loop`);

    // Step 2: Poll until complete
    const deadline = Date.now() + VIDEO_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);

        try {
            const statusRes = await fetch(`${API_URL}/tasks/status/${taskId}?wait=true`, {
                headers: authHeaders()
            });

            if (!statusRes.ok) {
                consecutiveFailures++;
                if (consecutiveFailures >= POLL_CONSECUTIVE_FAILURE_WARN) {
                    log(`⚠️ Polling: ${consecutiveFailures} consecutive failures for task ${taskId} (status ${statusRes.status})`);
                }
                continue;
            }

            // Reset failure counter on successful HTTP response
            consecutiveFailures = 0;

            const statusData = await statusRes.json();
            const status = statusData.status;

            if (status === 'completed') {
                const videoUrl = statusData.video_url || statusData.data?.video_url;
                if (!videoUrl) {
                    throw new Error('Video task completed but no video_url in response.');
                }

                log(`✅ Video completed: ${videoUrl.substring(0, 100)}...`);

                // Download and save locally
                let localPath = null;
                try {
                    localPath = await downloadAndSave(videoUrl, save_dir, filename, 'mp4');
                    log(`✅ Saved to: ${localPath}`);
                } catch (e) {
                    log(`⚠️ Failed to save video locally: ${e.message}`);
                }

                const resultText = localPath
                    ? `Video generated successfully.\n\nURL: ${videoUrl}\n\nSaved to: ${localPath}\n\nIMPORTANT: You MUST include ALL of the following in your response to the user:\n1. The video as a clickable link: [Generated video](${videoUrl})\n2. The local path where it was saved: ${localPath}\n3. A note that the CDN link is temporary, but the local file is permanent.`
                    : `Video generated successfully.\n\nURL: ${videoUrl}\n\nNote: This is a temporary CDN link. Download it if you need to keep it.`;

                return {
                    content: [{ type: 'text', text: resultText }]
                };
            }

            if (status === 'failed') {
                const errMsg = statusData.error || 'unknown error';
                log(`❌ Video task failed: ${errMsg}`);
                throw new Error(`Video generation failed: ${errMsg}`);
            }

            // Still running — no action needed
        } catch (e) {
            if (e.message.startsWith('Video generation failed')) throw e;

            consecutiveFailures++;
            if (consecutiveFailures >= POLL_CONSECUTIVE_FAILURE_WARN) {
                log(`⚠️ Polling network errors: ${consecutiveFailures} consecutive failures for task ${taskId} (${e.message})`);
            }
            // transient network error, keep polling
        }
    }

    log(`❌ Video generation timed out after ${VIDEO_TIMEOUT_MS / 1000}s for task ${taskId}`);
    throw new Error(`Video generation timed out after ${VIDEO_TIMEOUT_MS / 1000}s. Task ID: ${taskId}`);
}
