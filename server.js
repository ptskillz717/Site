const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { EmailClient } = require("@azure/communication-email");
const { SmsClient } = require("@azure/communication-sms"); // NEW: SMS
const stripeKey = process.env.STRIPE_KEY;
const stripe = stripeKey ? require('stripe')(stripeKey) : null;

const app = express();
const port = process.env.PORT || 8080;

// --- CONFIGURATION ---
const AZURE_ACC = "platinumvault11108";
const AZURE_CON = "finished-masters";
const GAL_CON = "gallery-assets";
const WEB_CON = "$web";
const AZURE_SAS = "?se=2035-11-26T04%3A41Z&sp=rwdlacup&spr=https&sv=2022-11-02&ss=b&srt=co&sig=U5KMAeALiYVZanmWR5X%2BC2JbGEKVuEI9KEF13R%2BRxa8%3D";
const IMPERSONATE_EMAIL = 'teo@ptskillz.org';
const ADMIN_EMAIL = 'ptskillz717@melodysmusic.onmicrosoft.com';
const MAIN_SITE = "https://platinumpro-13791.azurewebsites.net";
const CONFIG_FILE = "site_config.json";
const LEAD_FILE_NAME = "PLATINUM_LEADS.json";

const STRIPE_LINKS = {
    mastering: "https://buy.stripe.com/eVq7sN4TT9NHcW1aaN0gw05",
    summing: "https://buy.stripe.com/4gM6oJaed8JD5tzgzb0gw04",
    recording: "https://buy.stripe.com/fZu3cx5XX4tn4pvciV0gw02"
};

const STUDIO_INFO = {
    name: "Platinum Skillz",
    address: "3807 Derry St, Harrisburg PA",
    phone: "(717) 547-0033",
    rates: "Mastering $90 | Summing $180 | Rec $60/hr"
};

// --- DATABASE (Comments Only) ---
const dbURI = 'mongodb+srv://admin:Platinum2025@cluster0.qixmbcs.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(dbURI).then(() => console.log("✅ DB Connected")).catch(e => console.error("❌ DB Error:", e.message));
const CommentSchema = new mongoose.Schema({ client: String, filename: String, time: Number, text: String, date: { type: Date, default: Date.now } });
const Comment = mongoose.models.Comment || mongoose.model('Comment', CommentSchema);

// --- GOOGLE DRIVE ENGINE ---
async function getDriveClient() {
    if (!process.env.GOOGLE_CREDENTIALS) return null;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS), scopes: ['https://www.googleapis.com/auth/drive'], clientOptions: { subject: IMPERSONATE_EMAIL } });
    return google.drive({ version: 'v3', auth });
}
async function fetchLeadsFromDrive() {
    const d = await getDriveClient(); if(!d) return [];
    try { const l = await d.files.list({q:`name='${LEAD_FILE_NAME}' and '${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents`, fields:'files(id)'}); if(!l.data.files.length)return []; const r = await d.files.get({fileId:l.data.files[0].id, alt:'media'}); return typeof r.data==='object'?r.data:JSON.parse(r.data); } catch(e){return[];}
}
async function saveLeadsToDrive(leads) {
    const d = await getDriveClient(); if(!d) return;
    leads.sort((a,b)=>(a.name||a.email).localeCompare(b.name||b.email));
    try { const l = await d.files.list({q:`name='${LEAD_FILE_NAME}' and '${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents`, fields:'files(id)'}); const m={mimeType:'application/json', body:JSON.stringify(leads,null,2)}; if(l.data.files.length) await d.files.update({fileId:l.data.files[0].id, media:m}); else await d.files.create({requestBody:{name:LEAD_FILE_NAME, parents:[process.env.GOOGLE_DRIVE_FOLDER_ID]}, media:m}); } catch(e){}
}

// --- COMMS (EMAIL & SMS) ---
let emailClient = null;
let smsClient = null;
if (process.env.ACS_CONNECTION_STRING) { 
    try { 
        emailClient = new EmailClient(process.env.ACS_CONNECTION_STRING); 
        smsClient = new SmsClient(process.env.ACS_CONNECTION_STRING);
        console.log("✅ Comms Ready"); 
    } catch (e) {} 
}

async function sendAzureEmail(to, sub, txt) {
    if (!emailClient || !process.env.ACS_SENDER_ADDRESS) return;
    const html = `<div style="font-family:Arial;">${txt.replace(/\n/g, '<br>')}</div><br><hr><p style="font-size:12px;color:#666;"><b>${STUDIO_INFO.name}</b><br><a href="${MAIN_SITE}">VISIT WEBSITE</a></p>`;
    try { await emailClient.beginSend({ senderAddress: process.env.ACS_SENDER_ADDRESS, content: { subject: sub, plainText: txt, html }, recipients: { to: [{ address: to }] } }); } catch (e) {}
}

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
app.use(express.text({ type: 'text/html', limit: '50mb' })); 
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 📨 NEW: SMS & PROMOTION ROUTES
// ==========================================

// 1. SEND SMS
app.post('/api/send-sms', async (req, res) => {
    const { phone, message } = req.body;
    if (!smsClient || !process.env.ACS_PHONE_NUMBER) return res.status(500).json({ error: "SMS not configured." });
    
    try {
        await smsClient.send({
            from: process.env.ACS_PHONE_NUMBER,
            to: [phone],
            message: message
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. PROMOTE LEAD TO CLIENT (Create Folder + Link)
app.post('/api/promote-lead', async (req, res) => {
    const { email, name, phone } = req.body;
    // Generate Code: Jermaine Cole -> JERMAINE_COLE
    const code = (name || email.split('@')[0]).trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
    
    try {
        // 1. Create Azure Folder
        await putBlob(`${code}/init.txt`, "Init");
        
        // 2. Update Database (Drive)
        const leads = await fetchLeadsFromDrive();
        const idx = leads.findIndex(l => l.email === email);
        if (idx >= 0) {
            leads[idx] = { ...leads[idx], name, phone, clientCode: code, source: "Promoted" };
        } else {
            leads.push({ name, email, phone, clientCode: code, source: "Promoted", date: new Date() });
        }
        await saveLeadsToDrive(leads);
        
        // 3. Email User
        sendAzureEmail(email, "🔓 Vault Access Granted", `Welcome to the family, ${name}!\n\nYour Client Vault is ready.\n\nCODE: ${code}\nLINK: ${MAIN_SITE}/client.html?p=${code}`);
        
        res.json({ success: true, code });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STANDARD ROUTES ---
// (AI, Leads, Uploads, etc. kept intact)
async function listAllFiles() { try { const u=`https://${AZURE_ACC}.blob.core.windows.net/${AZURE_CON}${AZURE_SAS}&restype=container&comp=list`; const r=await fetch(u); const t=await r.text(); const m=[...t.matchAll(/<Name>(.*?)<\/Name>/g)]; return m.map(x=>x[1]).filter(f=>f.endsWith('.mp3')||f.endsWith('.wav')); } catch(e){return[];} }
app.post('/api/ai', async (req, res) => { const { message, userEmail, mode, audioEnabled } = req.body; if (userEmail) { try { const leads = await fetchLeadsFromDrive(); if (!leads.some(l => l.email === userEmail)) { leads.push({ email: userEmail, source: "Bot", date: new Date() }); saveLeadsToDrive(leads); } sendAzureEmail(ADMIN_EMAIL, '🤖 New Lead', `User: ${userEmail}\nMode: ${mode}\nRequest: ${message}`); } catch(e) {} } if(mode==='producer'){ const f=await listAllFiles(); const cat=f.slice(0,100).join(", "); const p=`Music Sup. User: "${message}". Files: [${cat}]. Return JSON array 5 files.`; if(!process.env.AZURE_OPENAI_KEY)return res.json({reply:"[]"}); try{ const r=await fetch(`${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2023-05-15`,{method:'POST',headers:{'Content-Type':'application/json','api-key':process.env.AZURE_OPENAI_KEY},body:JSON.stringify({messages:[{role:"system",content:p},{role:"user",content:"Go"}]})}); const d=await r.json(); res.json({reply:d.choices[0].message.content}); }catch(e){res.json({reply:"[]"});} return; } if(!process.env.AZURE_OPENAI_KEY) return res.json({ reply: "AI Offline." }); try { let sys = mode === 'marketing' ? `Marketing Expert. JSON {subject,body}` : `Receptionist.`; const payload = { messages: [{ role: "system", content: sys }, { role: "user", content: message }] }; if (audioEnabled) { payload.modalities = ["text", "audio"]; payload.audio = { voice: "alloy", format: "wav" }; } const apiVer = audioEnabled ? "2024-10-01-preview" : "2023-05-15"; const r = await fetch(`${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${apiVer}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_KEY }, body: JSON.stringify(payload) }); const d = await r.json(); res.json({ reply: d.choices[0].message.content, audio: d.choices[0].message.audio?.data }); } catch (e) { res.json({ reply: "Error" }); } });
function parseContactsCSV(t){const l=t.replace(/^\uFEFF/,'').split(/\r?\n/);const hI=l.findIndex(x=>x.includes("E-mail")||x.includes("First Name"));if(hI===-1)return[];const h=l[hI].split(',').map(x=>x.trim().replace(/^"|"$/g,''));const eI=h.indexOf("E-mail Address");const fI=h.indexOf("First Name");const lI=h.indexOf("Last Name");const pI=h.indexOf("Mobile Phone");const r=[];const rx=/,(?=(?:(?:[^"]*"){2})*[^"]*$)/;for(let i=hI+1;i<l.length;i++){if(!l[i].trim())continue;const row=l[i].split(rx).map(c=>c.trim().replace(/^"|"$/g,''));const em=row[eI];if(em&&em.includes('@')){const nm=`${row[fI]||''} ${row[lI]||''}`.trim()||"Unknown";r.push({name:nm,email:em,phone:row[pI]||"",source:"CSV",date:new Date()});}}return r;}
app.post('/api/upload-leads-csv', multer().single('file'), async (req, res) => { try { const n=parseContactsCSV(req.file.buffer.toString('utf8')); if(!n.length)return res.json({error:"No leads"}); const c=await fetchLeadsFromDrive(); let k=0; n.forEach(l=>{if(!c.some(x=>x.email.toLowerCase()===l.email.toLowerCase())){c.push(l);k++;}}); if(k>0)await saveLeadsToDrive(c); res.json({success:true,count:k}); } catch(e){res.status(500).json({error:e.message});} });

app.get('/api/leads', async (req, res) => { res.json(await fetchLeadsFromDrive()); });
app.post('/api/add-lead', async (req, res) => { const l = await fetchLeadsFromDrive(); if(!l.some(x=>x.email===req.body.email)){ l.push({...req.body, date:new Date()}); await saveLeadsToDrive(l); } res.json({success:true}); });
app.post('/api/delete-lead', async (req, res) => { let l = await fetchLeadsFromDrive(); if(req.body.email==='ALL')l=[]; else l=l.filter(x=>x.email!==req.body.email); await saveLeadsToDrive(l); res.json({success:true}); });
app.post('/api/save-client-info', async (req, res) => { const {name,email,phone,clientCode}=req.body; const l=await fetchLeadsFromDrive(); const i=l.findIndex(x=>x.email===email); if(i>=0)l[i]={...l[i],name,phone,clientCode}; else l.push({name,email,phone,clientCode,date:new Date()}); await saveLeadsToDrive(l); sendAzureEmail(ADMIN_EMAIL, `Info: ${name}`, `${name}\n${email}\n${phone}`); res.json({success:true}); });

// Utils
async function putBlob(p, d) { const u=`https://${AZURE_ACC}.blob.core.windows.net/${AZURE_CON}/${p}${AZURE_SAS}`; await fetch(u,{method:'PUT',headers:{'x-ms-blob-type':'BlockBlob'},body:d}); }
async function headBlob(p) { try{return (await fetch(`https://${AZURE_ACC}.blob.core.windows.net/${AZURE_CON}/${p}${AZURE_SAS}`,{method:'HEAD'})).ok;}catch{return false;} }
app.get('/api/stream', async (req, res) => { const f=req.query.file; if(!f)return res.status(400).send("No file"); const u=`https://${AZURE_ACC}.blob.core.windows.net/${AZURE_CON}/${encodeURIComponent(f)}${AZURE_SAS}`; try{const r=await fetch(u); if(!r.ok)return res.status(404).send("404"); res.setHeader('Content-Type','audio/mpeg'); Readable.fromWeb(r.body).pipe(res); }catch(e){res.status(500).send("Err");} });
app.get(['/before.mp3', '/after.mp3'], async (req, res) => { const f=req.path.substring(1); const u=`https://${AZURE_ACC}.blob.core.windows.net/${WEB_CON}/${f}${AZURE_SAS}`; try{const r=await fetch(u); if(!r.ok)return res.status(404).end(); res.setHeader('Content-Type','audio/mpeg'); Readable.fromWeb(r.body).pipe(res); }catch(e){res.status(500).end();} });
app.post('/api/send-promo', async (req, res) => { await sendAzureEmail(req.body.email, req.body.subject, req.body.body); res.json({ success: true }); });
app.post('/api/send-promo-all', async (req, res) => { const l=await fetchLeadsFromDrive(); for(const x of l) await sendAzureEmail(x.email, req.body.subject, req.body.body); res.json({ success: true, count: l.length }); });
app.post('/api/email-client', (req, res) => { sendAzureEmail(req.body.email, `Update`, `${req.body.message}\n\nLink: ${MAIN_SITE}/client.html?p=${req.body.client}`); res.json({ success: true }); });
app.post('/api/login', async (req, res) => { res.json({ valid: await headBlob(`${req.body.code.trim().toUpperCase()}/init.txt`) }); });
app.post('/api/status', async (req, res) => { await putBlob(`${req.body.client}/status.txt`, req.body.status); res.json({ success: true }); });
app.get('/api/comments', async (req, res) => { try{res.json(await Comment.find({client:req.query.client, filename:req.query.filename}).sort({time:1}));}catch{res.json([]);} });
app.post('/api/comments', async (req, res) => { try{await Comment.create(req.body); sendAzureEmail(ADMIN_EMAIL, `Note: ${req.body.client}`, req.body.text); res.json({success:true});}catch{res.status(500).send();} });
app.post('/admin/save', (req, res) => { if(req.headers['x-pin']!==ADMIN_PIN)return res.status(403).send('Denied'); fs.writeFile('index.html', req.body, ()=>res.status(200).send('OK')); });
app.post('/notify-chat', (req, res) => { sendAzureEmail(ADMIN_EMAIL, 'Chat: '+req.body.client, req.body.msg); res.sendStatus(200); });
app.get('/upload', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'upload.html')); });
app.post('/upload-beat', multer({storage:multer.memoryStorage()}).single('file'), async (req, res) => { try{const c=req.query.client||"Unknown"; sendAzureEmail(ADMIN_EMAIL,'File: '+c,req.file.originalname); if(c!=="Unknown")putBlob(`${c}/msg_${Date.now()}_CLIENT.txt`, "UPLOAD: "+req.file.originalname); res.json({id:"ok"});}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/config', async (req, res) => { try{const r=await fetch(`https://${AZURE_ACC}.blob.core.windows.net/${GAL_CON}/${CONFIG_FILE}${AZURE_SAS}&t=${Date.now()}`); if(r.ok)return res.json(await r.json()); res.json({});}catch{res.json({});} });
app.post('/api/config', async (req, res) => { try{await fetch(`https://${AZURE_ACC}.blob.core.windows.net/${GAL_CON}/${CONFIG_FILE}${AZURE_SAS}`,{method:'PUT',headers:{'x-ms-blob-type':'BlockBlob','Content-Type':'application/json'},body:JSON.stringify(req.body)}); res.json({success:true});}catch{res.status(500).json({error:"Fail"});} });
app.post('/api/stripe-webhook', async (req, res) => { if (event.type === 'checkout.session.completed') { const s = event.data.object; const code = s.customer_details.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_'); await putBlob(`${code}/init.txt`, "Init"); sendAzureEmail(s.customer_details.email, "Access", `Link: ${MAIN_SITE}/client.html?p=${code}`); const l = {email: s.customer_details.email, name: s.customer_details.name, clientCode: code, source:"Stripe", date: new Date()}; saveLeadsToDrive([l]); } res.send(); });

app.listen(port, () => { console.log('Platinum Server running on ' + port); });