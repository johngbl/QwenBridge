---
name: Qwen Media Creator
description: >-
  Generate images and short videos with Qwen AI through the QwenBridge proxy.
  Use when the user wants to create an image or a video from a text description
  inside a chat ("gera uma imagem de...", "crie um vídeo de...", "make an image
  of...", "generate a picture of a..."). The skill drives the Qwen Media Creator
  MCP server (tools generate_image / generate_video), which talks to
  /v1/images/generations and /v1/videos/generations, returns the CDN URL and
  saves a local copy. Trigger whenever image or video generation is requested
  and the platform does not expose a native images endpoint.
---

# Qwen Media Creator

Generate images and short videos from a text description using the
**Qwen Media Creator** MCP server (a stdio Model Context Protocol server
included in this repo at `mcp/server.js`).

## When to use

Use this skill whenever the user asks for image or video generation and your
platform cannot call `POST /v1/images/generations` directly. The MCP server
(`mcp/server.cjs`) bundles that into two tools the chat model can call:

- `generate_image` — text → image (base64-free, returns CDN `url`, saves PNG)
- `generate_video` — text → video (returns CDN `url`, saves MP4; 30s–3min)
  with built-in task polling.

> The MCP file is `server.cjs` because the repo is `"type": "module"`; the
> server itself uses CommonJS (`require`) and has no dependencies.

## Rules

1. Always call the MCP tools through the **Qwen Media Creator** server. Do not
   hand-craft HTTP requests to QwenBridge unless the MCP tools are unavailable.
2. The `prompt` is required. Write a specific, descriptive prompt (subject,
   style, lighting, mood) for the best output.
3. Provide `save_dir`: the absolute path of the current conversation working
   directory so the file lands next to the conversation. If the caller provides
   a working directory, use it. If omitted, `generate_*` falls back to a global
   `generated/` folder — prefer passing the conversation dir.
4. Optional `model`: pick a media model (`qwen-image-max`, `qwen-image-plus`,
   `wan2.2-t2i-flash`, … for images; `wan2.2-t2v-flash`, `wan2.6-t2v-preview`,
   … for video). Default: `qwen3-vl-plus`.
5. Optional `size`: one of `16:9`, `9:16`, `1:1` (image also `4:3`).
6. Optional `filename`: leave unset to let the server auto-name with a
   timestamp + model.

## Result handling

After a successful tool call the result gives:

- the temporary CDN `URL`
- the permanent local `Saved to:` path (when `save_dir` was used)

In your reply to the user:

- embed the image inline: `![Generated image](<url>)`
- give the CDN link as a clickable link
- give the local path where it was saved
- tell the user the CDN link is temporary but the local file is permanent

## Examples

```
User:  Gera uma imagem de um gato laranja dormindo numa almofada azul
Agent: <call generate_image with prompt="A cute orange tabby cat sleeping on a
       blue cushion, soft natural lighting, cozy living room" size="16:9"
       model="qwen3-vl-plus" save_dir="<conversation working dir>">
```

```
User:  Create a 9:16 video of ocean waves at sunset
Agent: <call generate_video with prompt="Cinematic ocean waves crashing at
       golden-hour sunset, 9:16 vertical, realistic" size="9:16"
       model="wan2.2-t2v-flash" save_dir="<conversation working dir>">
```

## Configuration (reference)

The MCP server honors these environment variables:

| Variable       | Default                        | Description                            |
|----------------|--------------------------------|----------------------------------------|
| `QB_API_URL`   | `http://127.0.0.1:3000/v1`     | QwenBridge base URL                    |
| `QB_API_KEY`   | (empty)                        | Bearer API key sent when configured    |
| `QB_MEDIA_DIR` | cwd/`generated`                | Fallback save directory                |
| `QB_MEDIA_MODEL` | `qwen3-vl-plus`            | Default media model                   |

Connect it under the name **Qwen Media Creator**, e.g.:

```json
{
  "mcpServers": {
    "Qwen Media Creator": {
      "command": "node",
      "args": ["<repo>/mcp/server.cjs"]
    }
  }
}
```