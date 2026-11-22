NEBULA AI — Intelligent Chat + Coding Workspace + Arena AI
========================================================

FEATURES
- Reference-inspired Nebula interface with a dark glass workspace, compact scrollable model picker, model badges, and mobile-friendly composer.
- Chat, image and video generation modes (provider models must support them).
- Build Project mode: asks the selected model for a complete JSON file manifest, previews the generated file tree and file contents, and packs the files into a downloadable ZIP in the browser.
- Arena AI: sends the same prompt to two selected chat models in parallel and lets you choose the preferred answer.
- Visible activity/status timeline while requests are running. These are task progress indicators, not a display of private model chain-of-thought.
- Upload text/code files, images and ZIP archives as context.
- API keys remain on the Render server.
- Automatic API key fallback across FM_API_KEY and numbered backup variables up to slot 100.

DEPLOY TO RENDER
1. Upload the complete freemodel-studio folder to your GitHub repository.
2. In Render create/update a Web Service and select Docker runtime.
3. Add environment variables in Render:
   FM_BASE_URL = https://freemodel.in/v1
   FM_API_KEY = your primary key
   FM_API_KEY_2 = your backup key
   FM_API_KEY_3 = another backup key (optional)
   APP_PASSWORD = choose a private app password (recommended)
4. Add more backups as FM_API_KEY_4, FM_API_KEY_5, ... up to FM_API_KEY_100.
5. Save changes and deploy/redeploy.

API KEY FALLBACK
- The server reads FM_API_KEY, then FM_API_KEY_2, FM_API_KEY_3, etc. It also accepts FM_API_KEY2 as an alias for slot 2 and similarly numbered aliases.
- When an upstream request returns an authentication, quota, rate-limit, timeout or retryable server error, the server retries the same request with the next configured key.
- Ordinary request errors such as invalid model/prompt (400/404/422) are not retried with other keys.
- Fallback uses the same FM_BASE_URL. It cannot repair an expired account, unsupported model, provider outage, or incompatible API format.

SECURITY
- Never put API keys in index.html or commit them to public GitHub.
- Set APP_PASSWORD to prevent other people from using your hosted API balance.
- If a key was exposed, revoke/rotate it at the provider.
- Uploaded files and generated chat history are handled in the browser; do not upload secrets or sensitive files unless you trust the hosting setup.

NOTES / LIMITATIONS
- Build Project mode depends on the selected model following the requested JSON file-manifest format. Very large projects may hit provider output-token limits; ask for a smaller project or generate it in modules.
- Generated ZIPs are assembled in the browser with JSZip (CDN required).
- Model progress labels show the app's current task stage. They do not expose hidden reasoning or guarantee that a provider is internally using a particular thinking mode.
- Image/video features depend on the upstream provider endpoints and model availability.

ENDPOINTS
GET /api/health  - server health
GET /api/info    - configured API key count only; never returns key values

MOBILE / PROJECT UX PATCH
- Mobile layout uses dynamic viewport height, safe-area padding, independent chat scrolling and a fixed-height composer region.
- Sidebar is an off-canvas drawer on phones; file preview and file tree stay within the screen.
- Welcome orb now has rotating luminous rings, glow and floating animation (respects reduced-motion preference).
- Explicit software/project creation requests from Chat mode are routed to Build Project mode so generated code is returned as separate files and a ZIP preview rather than one giant chat code block.
- Progress indicators now advance at actual application milestones instead of an automatic timer.

TELEGRAM BOT (SAME RENDER SERVICE)
=================================
- A single extra source file, bot.py, runs the Telegram bot using Python standard library only.
- Dockerfile installs python3. The existing Node server starts bot.py automatically when BOT_TOKEN is configured.
- Add BOT_TOKEN in Render Environment (Telegram @BotFather token). Keep it secret; never put it in GitHub or frontend code.
- The bot reads the same FM_BASE_URL, FM_API_KEY, FM_API_KEY_2 ... FM_API_KEY_100 and uses the same key fallback sequence.
- Telegram commands: /start, /models, /new, /help.
- /models fetches the provider's /models endpoint and shows a paginated inline model picker. Selected model is remembered per Telegram chat in process memory.
- Single-file answers are sent as chat text/code. Multi-file JSON manifests are written into a ZIP and sent as a Telegram document.
- The bot sends visible progress/status messages and Telegram typing actions. It does not expose private model chain-of-thought.
- No separate Render service is required. The website and bot run in the same Render web service/container.
- Note: Render restarts clear bot conversation state; use /new when needed. Provider must support OpenAI-compatible /models and /chat/completions endpoints.
