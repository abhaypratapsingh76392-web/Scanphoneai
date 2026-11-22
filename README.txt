NEBULA AI v2 — Website + Telegram bot (ek hi Render service, sirf Node, Python nahi)

GITHUB: is zip ke ANDAR ki files repo ke root me daalo (Dockerfile, server.js, bot.js, auth.js, public/ ...). Folder ke andar folder nahi.

RENDER ENVIRONMENT:
  BOT_TOKEN        = BotFather token
  ADMIN_ID         = admin ka Telegram numeric user id (multiple: 123,456)   [@userinfobot se milega]
  FM_API_KEY       = provider key (backup: FM_API_KEY_2, _3 ...)
  FM_BASE_URL      = https://freemodel.in/v1
  FIREBASE_DB_URL  = https://xxxx-default-rtdb.firebaseio.com   (recommended: passwords restart pe delete na ho)
  FIREBASE_SECRET  = Firebase database secret (optional, agar rules locked hain)
APP_PASSWORD ab nahi chahiye — delete kar do.

ADMIN COMMANDS (sirf ADMIN_ID wale ko):
  /newpass naam   -> naya password banata hai
  /passes         -> list (kis IP / Telegram se lock hai)
  /revoke ID      -> password delete + uske saare login band
  /resetip ID     -> lock reset (user ka IP badal gaya ho to)

LOGIN RULES:
  - Website: password pehli baar jis IP se use hua, usi IP pe lock. Doosre IP se wahi password reject.
  - Login ek baar, phir session browser me save — logout nahi hota (IP badalne pe bhi).
  - Telegram bot: password pehle Telegram account pe lock (Telegram IP nahi deta). Ek baar login = hamesha login.
  - Strict mode (optional): STRICT_SESSION_IP=1 -> session bhi IP badalne pe band.

FREE RENDER: 15 min inactivity pe sleep hota hai, tab bot band ho jata hai.
  uptimerobot.com pe https://<tumhara-url>/api/health ko 5 min me ping karao.
CHECK: https://<url>/bot-status  aur Render Logs me "Telegram authenticated as @..."
