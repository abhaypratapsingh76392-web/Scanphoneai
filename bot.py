#!/usr/bin/env python3
"""Nebula AI Telegram bot. Standard-library only; shares Render FM API keys."""
import os, json, time, urllib.request, urllib.error, urllib.parse, threading, zipfile, io, re, html, logging

logging.basicConfig(level=os.getenv("BOT_LOG_LEVEL","INFO"), format="%(asctime)s %(levelname)s %(message)s")
log=logging.getLogger("nebula-bot")
TOKEN=os.getenv("BOT_TOKEN","").strip()
BASE=os.getenv("FM_BASE_URL","https://freemodel.in/v1").rstrip("/")
APP_PASSWORD=os.getenv("APP_PASSWORD","")
TG="https://api.telegram.org/bot"+TOKEN
USER_STATE={}
MODEL_CACHE={"at":0,"items":[]}
MODEL_PAGE_SIZE=12
MAX_TELEGRAM=3900

def keys():
    out=[]
    for i in range(1,101):
        names=["FM_API_KEY"] if i==1 else [f"FM_API_KEY_{i}",f"FM_API_KEY{i}"]
        val=next((os.getenv(n,"").strip() for n in names if os.getenv(n,"").strip()),"")
        if val: out.append((i,val))
    return out

def request_json(url, data=None, headers=None, timeout=55):
    raw=None if data is None else json.dumps(data).encode()
    req=urllib.request.Request(url, data=raw, headers=headers or {}, method="GET" if data is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body=r.read()
        ct=r.headers.get("Content-Type","")
    try: return json.loads(body.decode("utf-8")),ct
    except Exception: return {"_text":body.decode("utf-8","replace")},ct

def provider(path, payload=None, timeout=90):
    ks=keys()
    if not ks: raise RuntimeError("Render secret FM_API_KEY set nahi hai.")
    last=None
    for pos,(slot,key) in enumerate(ks):
        headers={"Authorization":"Bearer "+key,"x-api-key":key,"Accept":"application/json"}
        if payload is not None: headers["Content-Type"]="application/json"
        try:
            return request_json(BASE+path,payload,headers,timeout)[0]
        except urllib.error.HTTPError as e:
            last=f"HTTP {e.code}: {e.read(500).decode('utf-8','replace')}"
            if e.code not in (401,402,403,408,425,429,500,502,503,504) or pos==len(ks)-1: break
            log.warning("FM key slot %s failed (%s), trying next",slot,e.code)
        except Exception as e:
            last=str(e)
            if pos==len(ks)-1: break
            log.warning("FM key slot %s request error: %s; trying next",slot,e)
    raise RuntimeError("All FM API keys failed. "+str(last))

def tg(method, payload=None, files=None, timeout=40):
    url=TG+"/"+method
    if files:
        boundary="----Nebula"+str(int(time.time()*1000))
        parts=[]
        for k,v in (payload or {}).items():
            parts += [f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()]
        for name,(filename,content,mime) in files.items():
            parts += [f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode(),content,b"\r\n"]
        parts += [f"--{boundary}--\r\n".encode()]
        req=urllib.request.Request(url,data=b"".join(parts),headers={"Content-Type":"multipart/form-data; boundary="+boundary})
    else:
        req=urllib.request.Request(url,data=json.dumps(payload or {}).encode(),headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=timeout) as r: result=json.loads(r.read().decode())
    if not result.get("ok"): raise RuntimeError(result.get("description","Telegram API error"))
    return result.get("result")

def send(chat,text,**kw):
    return tg("sendMessage",{"chat_id":chat,"text":text[:MAX_TELEGRAM],"disable_web_page_preview":True,**kw})

def edit(chat,msg,text,**kw):
    try: tg("editMessageText",{"chat_id":chat,"message_id":msg,"text":text[:MAX_TELEGRAM],"disable_web_page_preview":True,**kw})
    except Exception: pass

def answer_cb(cid,text=""):
    try: tg("answerCallbackQuery",{"callback_query_id":cid,"text":text[:180],"show_alert":False})
    except Exception: pass

def get_models(force=False):
    if not force and MODEL_CACHE["items"] and time.time()-MODEL_CACHE["at"]<300: return MODEL_CACHE["items"]
    data=provider("/models")
    items=data.get("data",[]) if isinstance(data,dict) else []
    result=[]
    for m in items:
        if not isinstance(m,dict) or not m.get("id"): continue
        typ=m.get("type")
        if typ and typ!="chat": continue
        result.append({"id":str(m["id"]),"name":str(m.get("name") or m["id"])})
    MODEL_CACHE.update(at=time.time(),items=result)
    return result

def model_keyboard(page=0):
    models=get_models()
    start=page*MODEL_PAGE_SIZE
    rows=[]
    for i in range(start,min(start+MODEL_PAGE_SIZE,len(models)),2):
        row=[]
        for m in models[i:i+2]:
            label=("✦ "+m["name"])[:60]
            row.append({"text":label,"callback_data":"m:"+m["id"][:55]})
        rows.append(row)
    nav=[]
    if page>0: nav.append({"text":"‹ Prev","callback_data":f"p:{page-1}"})
    if start+MODEL_PAGE_SIZE<len(models): nav.append({"text":"Next ›","callback_data":f"p:{page+1}"})
    if nav: rows.append(nav)
    return {"inline_keyboard":rows},len(models)

def model_prompt(chat):
    s=USER_STATE.setdefault(chat,{"model":None,"history":[]})
    try:
        kb,total=model_keyboard(0)
        send(chat,f"✦ <b>NEBULA AI MODEL STUDIO</b>\n\nAvailable chat models: {total}\nChoose a model to start chatting.",parse_mode="HTML",reply_markup=kb)
    except Exception as e: send(chat,"Model list load nahi hui: "+str(e)[:500])

def typing_loop(chat,stop):
    while not stop.is_set():
        try: tg("sendChatAction",{"chat_id":chat,"action":"typing"})
        except Exception: pass
        stop.wait(4)

def extract_files(text):
    # Preferred manifest: {"project_name":"...", "files":[{"path":"src/a.py","content":"..."}]}
    candidates=[text]
    candidates += re.findall(r"```(?:json)?\s*([\s\S]*?)```",text,re.I)
    for candidate in candidates:
        a=candidate.find("{"); b=candidate.rfind("}")
        if a<0 or b<=a: continue
        try: obj=json.loads(candidate[a:b+1])
        except Exception: continue
        fs=obj.get("files") if isinstance(obj,dict) else None
        if isinstance(fs,list):
            clean=[]
            for f in fs[:180]:
                if not isinstance(f,dict): continue
                p=str(f.get("path") or f.get("name") or "").replace("\\","/").lstrip("/")
                if not p or ".." in p.split("/") or len(p)>180: continue
                c=f.get("content",f.get("code",""))
                if not isinstance(c,str): c=json.dumps(c,ensure_ascii=False,indent=2)
                clean.append((p,c))
            if clean: return str(obj.get("project_name") or "nebula-project"),clean
    return None,[]

def zip_bytes(project,files):
    bio=io.BytesIO()
    with zipfile.ZipFile(bio,"w",zipfile.ZIP_DEFLATED) as z:
        for p,c in files: z.writestr(project+"/"+p,c)
    return bio.getvalue()

def split_send(chat,text):
    text=text.strip() or "(Empty response)"
    while text:
        chunk=text[:MAX_TELEGRAM]
        if len(text)>MAX_TELEGRAM:
            cut=chunk.rfind("\n")
            if cut>MAX_TELEGRAM//2: chunk=text[:cut]
        send(chat,chunk)
        text=text[len(chunk):].lstrip()

def ask_ai(chat,user_text):
    state=USER_STATE.setdefault(chat,{"model":None,"history":[]})
    if not state.get("model"):
        send(chat,"Pehle /models se apna AI model select karo.")
        return
    hist=state.setdefault("history",[])
    hist.append({"role":"user","content":user_text})
    hist[:]=hist[-16:]
    status=send(chat,"✦ Nebula is thinking…\n\n▰▱ Understanding your request\n▱▱ Generating response\n▱▱ Preparing files (if needed)")
    stop=threading.Event()
    th=threading.Thread(target=typing_loop,args=(chat,stop),daemon=True); th.start()
    try:
        system=("You are Nebula AI, a helpful coding and general assistant. Reply clearly. "
        "When the user asks for a project containing multiple files, return a valid JSON object "
        "with keys project_name and files; files must be an array of objects with path and content. "
        "Do not put the JSON inside markdown fences. Include every required folder in file paths. "
        "For a request that needs only one file, provide that file's complete code in one fenced code block.")
        payload={"model":state["model"],"messages":[{"role":"system","content":system}]+hist,"stream":False}
        data=provider("/chat/completions",payload,timeout=120)
        choices=data.get("choices",[]) if isinstance(data,dict) else []
        answer=choices[0].get("message",{}).get("content","") if choices else data.get("_text","")
        if isinstance(answer,list):
            answer="".join(x.get("text","") for x in answer if isinstance(x,dict))
        answer=str(answer).strip()
        if not answer: raise RuntimeError("Model ne empty response diya.")
        project,files=extract_files(answer)
        if files:
            edit(chat,status["message_id"],f"✦ Project ready\n\n✓ {len(files)} files created\n✓ Folder structure packed\n✓ ZIP prepared\n\nSending your project…")
            datazip=zip_bytes(project,files)
            tg("sendDocument",{"chat_id":chat,"caption":f"✦ {project}\n{len(files)} files • Complete folder structure","disable_content_type_detection":"true"},
               {"document":(re.sub(r"[^A-Za-z0-9_.-]","-",project)[:60]+".zip",datazip,"application/zip")},timeout=90)
            send(chat,"Project ZIP sent. Single-file code ke liye us file ka naam bolkar maango, main uska code chat mein de dunga.")
            hist.append({"role":"assistant","content":f"Created project {project} with {len(files)} files."})
        else:
            edit(chat,status["message_id"],"✦ Response generated\n\n✓ Model response received\n✓ Ready")
            split_send(chat,answer)
            hist.append({"role":"assistant","content":answer[:12000]})
        hist[:]=hist[-16:]
    except Exception as e:
        edit(chat,status["message_id"],"⚠️ Request failed\n\n"+str(e)[:3000])
        hist.pop() if hist and hist[-1].get("role")=="user" else None
    finally: stop.set()

def start(chat):
    send(chat,"✦ <b>NEBULA AI</b>\nYour AI chat & coding assistant.\n\nChoose a model, then send any question. I can reply with code or build multi-file projects and send a ZIP.\n\nCommands: /models /new /help",parse_mode="HTML")
    model_prompt(chat)

def handle_message(m):
    chat=m["chat"]["id"]; text=(m.get("text") or m.get("caption") or "").strip()
    if not text:
        send(chat,"Abhi text prompts supported hain. File/image understanding ko next bot update mein add kar sakte hain.")
        return
    if text.startswith("/start"): start(chat)
    elif text.startswith("/help"):
        send(chat,"Commands:\n/start — Start bot\n/models — Choose model\n/new — Clear conversation\n/help — Help\n\nSingle file: code reply mein milega. Multi-file project: ZIP document ke roop mein milega.")
    elif text.startswith("/models"): model_prompt(chat)
    elif text.startswith("/new"):
        USER_STATE[chat]={"model":USER_STATE.get(chat,{}).get("model"),"history":[]}
        send(chat,"New conversation started. Selected model retained.")
    else: ask_ai(chat,text)

def handle_callback(c):
    data=c.get("data",""); chat=c["message"]["chat"]["id"]; msg=c["message"]["message_id"]
    answer_cb(c["id"])
    if data.startswith("p:"):
        page=max(0,int(data.split(":",1)[1]))
        try:
            kb,total=model_keyboard(page)
            edit(chat,msg,f"✦ NEBULA AI MODEL STUDIO\n\nAvailable chat models: {total}\nChoose a model.",reply_markup=kb)
        except Exception as e: send(chat,str(e)[:500])
    elif data.startswith("m:"):
        model=data[2:]
        USER_STATE.setdefault(chat,{"history":[]})["model"]=model
        USER_STATE[chat].setdefault("history",[])
        send(chat,f"✓ Model selected: {model}\n\nNow send your prompt. Use /new to clear chat.")
        try: tg("editMessageReplyMarkup",{"chat_id":chat,"message_id":msg,"reply_markup":{"inline_keyboard":[]}})
        except Exception: pass

def main():
    if not TOKEN:
        log.info("BOT_TOKEN missing; Telegram bot is disabled.")
        return
    if not keys(): log.warning("No FM_API_KEY found. Bot will start but requests cannot run.")
    log.info("Nebula Telegram bot starting; API base=%s",BASE)
    offset=None
    while True:
        try:
            params={"timeout":50}
            if offset is not None: params["offset"]=offset
            qs=urllib.parse.urlencode(params)
            updates=tg("getUpdates") if False else request_json(TG+"/getUpdates?"+qs,timeout=60)[0].get("result",[])
            for u in updates:
                offset=u["update_id"]+1
                try:
                    if "message" in u: handle_message(u["message"])
                    elif "callback_query" in u: handle_callback(u["callback_query"])
                except Exception: log.exception("Update handling failed")
        except Exception as e:
            log.warning("Polling error: %s",e); time.sleep(3)

if __name__=="__main__": main()
