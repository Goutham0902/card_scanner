const $ = id => document.getElementById(id);
let stream = null;

$('openCameraBtn').onclick = async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1200 } }
    });
    $('video').srcObject = stream;
    $('video').classList.remove('hidden');
    $('placeholder').classList.add('hidden');
    $('guide').classList.remove('hidden');
    $('openCameraBtn').classList.add('hidden');
    $('captureBtn').classList.remove('hidden');
  } catch (e) {
    alert('Camera unavailable — try "upload a photo" instead');
  }
};
function cropToGuide(videoEl, containerEl) {
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;   // real camera resolution
  const cw = containerEl.clientWidth, ch = containerEl.clientHeight; // on-screen box size

  // Work out which part of the camera frame "object-fit: cover" is showing
  const videoRatio = vw / vh, containerRatio = cw / ch;
  let sx, sy, sw, sh;
  if (videoRatio > containerRatio) {
    sh = vh; sw = vh * containerRatio; sx = (vw - sw) / 2; sy = 0;
  } else {
    sw = vw; sh = vw / containerRatio; sx = 0; sy = (vh - sh) / 2;
  }

  // The dashed guide box is inset 6% left/right, 10% top/bottom (matches the CSS)
  const insetX = 0.06, insetY = 0.10;
  const gx = sx + sw * insetX;
  const gy = sy + sh * insetY;
  const gw = sw * (1 - 2 * insetX);
  const gh = sh * (1 - 2 * insetY);

  const canvas = document.createElement('canvas');
  canvas.width = gw;
  canvas.height = gh;
  canvas.getContext('2d').drawImage(videoEl, gx, gy, gw, gh, 0, 0, gw, gh);
  return canvas;
}
function preprocessForOcr(sourceCanvas) {
  // 1. Upscale if the cropped card is small — bigger text is easier to read
  const minWidth = 1400;
  const scale = Math.max(1, minWidth / sourceCanvas.width);
  const out = document.createElement('canvas');
  out.width = Math.round(sourceCanvas.width * scale);
  out.height = Math.round(sourceCanvas.height * scale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, out.width, out.height);

  // 2. Grayscale + contrast stretch
  const imgData = ctx.getImageData(0, 0, out.width, out.height);
  const d = imgData.data; // [r,g,b,a, r,g,b,a, ...] for every pixel
  const gray = new Float32Array(out.width * out.height);
  let min = 255, max = 0;

  // First pass: convert each pixel to a single brightness value,
  // and track the darkest and lightest values in the image
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; // human-perceived brightness
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }

  // Second pass: stretch that brightness range so the darkest pixel
  // becomes pure black (0) and the lightest becomes pure white (255).
  // This is what fixes photos taken in dim or uneven light.
  const range = Math.max(1, max - min);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = (gray[p] - min) * (255 / range);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return out;
}
$('captureBtn').onclick = () => {
  const cropped = cropToGuide($('video'), $('viewport'));
  const cleaned = preprocessForOcr(cropped);
  const dataUrl = cleaned.toDataURL('image/jpeg', 0.95);

  $('captured').src = dataUrl;
  $('captured').classList.remove('hidden');
  $('video').classList.add('hidden');
  $('guide').classList.add('hidden');
  $('captureBtn').classList.add('hidden');
  $('retakeBtn').classList.remove('hidden');
  stream.getTracks().forEach(t => t.stop()); // turn the camera off once captured

  runOcr(dataUrl);
};
let worker = null; // create once, reuse for every scan — much faster than recreating it each time

async function getWorker() {
  if (worker) return worker;
  worker = await Tesseract.createWorker('eng', 1, {
    logger: m => {
      if (m.status && typeof m.progress === 'number') {
        $('progressLabel').textContent = m.status;
        $('progressPct').textContent = Math.round(m.progress * 100) + '%';
      }
    }
  });
  // PSM 6 = "assume one uniform block of text". Business cards scatter
  // text in unrelated chunks rather than flowing paragraphs — this mode
  // reads that layout far more reliably than Tesseract's default "auto" mode.
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  return worker;
}

function runOcr(dataUrl) {
  $('progressWrap').classList.remove('hidden');
  getWorker()
    .then(w => w.recognize(dataUrl))
    .then(result => {
      $('progressWrap').classList.add('hidden');
      populateResult(parseCardText(result.data.text));
    })
    .catch(err => {
      $('progressWrap').classList.add('hidden');
      alert('Could not read the card — try a clearer, well-lit photo');
      console.error(err);
    });
}
function parseCardText(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const phoneRe = /(\+?\d[\d\s\-().]{7,}\d)/g;
  const webRe = /((https?:\/\/)?(www\.)?[a-zA-Z0-9-]+\.(com|in|co|org|net|io)(\/\S*)?)/i;
  const titleKeywords = /(manager|director|founder|ceo|cto|cfo|president|engineer|consultant|executive|officer|analyst|designer|owner|partner|sales|marketing)/i;
  const companySuffix = /(pvt\.?\s*ltd|private limited|\bllc\b|\binc\.?\b|\bltd\b|limited|enterprises|solutions|technologies|group)/i;

  let email = '', phones = [], website = '', name = '', title = '', company = '', addressLines = [];
  const used = new Set(); // tracks which lines we've already claimed, so nothing gets double-counted

  // Order matters: claim the most distinctive patterns first (email, then
  // website, then phone) so later, looser guesses (like "this short line
  // is probably the name") don't accidentally grab a line that's really a phone number.
  lines.forEach((line, i) => { const m = line.match(emailRe); if (m && !email) { email = m[0]; used.add(i); } });
  lines.forEach((line, i) => { if (used.has(i) || line.includes('@')) return; const m = line.match(webRe); if (m && !website) { website = m[0]; used.add(i); } });
  lines.forEach((line, i) => {
    if (used.has(i)) return;
    const matches = line.match(phoneRe);
    if (matches) {
      matches.forEach(p => { const digits = p.replace(/\D/g, ''); if (digits.length >= 7 && digits.length <= 15) phones.push(p.trim()); });
      used.add(i);
    }
  });
  lines.forEach((line, i) => { if (used.has(i)) return; if (companySuffix.test(line)) { if (!company) company = line; used.add(i); } });
  lines.forEach((line, i) => { if (used.has(i)) return; if (titleKeywords.test(line)) { if (!title) title = line; used.add(i); } });

  // Name: the first remaining short, letters-only line
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    if (lines[i].split(/\s+/).length <= 4 && /^[A-Za-z.'\s]+$/.test(lines[i])) { name = lines[i]; used.add(i); break; }
  }
  // Company fallback: first unclaimed line, if the suffix check above found nothing
  if (!company) { for (let i = 0; i < lines.length; i++) { if (!used.has(i)) { company = lines[i]; used.add(i); break; } } }
  // Everything left over is probably the address
  lines.forEach((line, i) => { if (!used.has(i)) addressLines.push(line); });

  return { name, title, company, phone: phones[0] || '', phone2: phones[1] || '', email, website, address: addressLines.join(', '), raw };
}
function populateResult(f) {
  $('f_name').value = f.name; $('f_title').value = f.title; $('f_company').value = f.company;
  $('f_phone').value = f.phone; $('f_phone2').value = f.phone2; $('f_email').value = f.email;
  $('f_website').value = f.website; $('f_address').value = f.address;
  $('f_raw').value = f.raw;
  $('result').classList.remove('hidden');
}

$('retakeBtn').onclick = () => location.reload(); // simplest way to reset camera state cleanly

let records = [];

$('saveRowBtn').onclick = async () => {
  const fields = {
    name: $('f_name').value.trim(), title: $('f_title').value.trim(), company: $('f_company').value.trim(),
    phone: $('f_phone').value.trim(), phone2: $('f_phone2').value.trim(), email: $('f_email').value.trim(),
    website: $('f_website').value.trim(), address: $('f_address').value.trim()
  };
  records.unshift({ fields, saved: false });
  renderHistory();
  $('result').classList.add('hidden');

  const url = $('sheetUrl').value.trim();
  if (!url) return; // no sheet connected yet — it just stays in the session list

  try {
    // mode: 'no-cors' + text/plain avoids a browser security check (CORS
    // preflight) that Google Apps Script doesn't handle by default.
    // Trade-off: we can't read a response back, so we just assume success.
    await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(fields) });
    records[0].saved = true;
    renderHistory();
  } catch (e) { console.error(e); }
};

function renderHistory() {
  $('histCount').textContent = records.length;
  $('historyList').innerHTML = records.map(r => `
    <div class="history-item">
      <span>${r.fields.name || 'Unnamed'} — ${r.fields.company || ''}</span>
      <span>${r.saved ? 'Saved' : 'Session only'}</span>
    </div>`).join('');
  $('exportCsvBtn').classList.toggle('hidden', records.length === 0);
}

$('discardBtn').onclick = () => $('result').classList.add('hidden');

$('exportCsvBtn').onclick = () => {
  const headers = ['Name','Title','Company','Phone','Phone2','Email','Website','Address'];
  const rows = records.map(r => Object.values(r.fields));
  const csv = [headers, ...rows].map(row => row.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'scanned-cards.csv';
  link.click();
};
$('uploadBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const dataUrl = preprocessForOcr(canvas).toDataURL('image/jpeg', 0.95);
      $('captured').src = ev.target.result;
      $('captured').classList.remove('hidden');
      $('placeholder').classList.add('hidden');
      runOcr(dataUrl);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
};
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);
  sheet.appendRow([new Date(), data.name, data.title, data.company, data.phone, data.phone2, data.email, data.website, data.address]);
  return ContentService.createTextOutput(JSON.stringify({status:'success'})).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  return ContentService.createTextOutput(JSON.stringify({status:'ok', rows: sheet.getLastRow()})).setMimeType(ContentService.MimeType.JSON);
}
const params = new URLSearchParams(location.search);
if (params.get('sheet')) $('sheetUrl').value = decodeURIComponent(params.get('sheet'));

$('saveUrlBtn').onclick = () => {
  const p = new URLSearchParams(location.search);
  p.set('sheet', encodeURIComponent($('sheetUrl').value.trim()));
  history.replaceState(null, '', location.pathname + '?' + p.toString());
};

$('testConnBtn').onclick = async () => {
  try {
    const res = await fetch($('sheetUrl').value.trim());
    const data = await res.json();
    alert('Connected — sheet has ' + data.rows + ' row(s)');
  } catch { alert('Could not reach the sheet — check the URL'); }
};

$('settingsToggle').onclick = () => $('settingsPanel').classList.toggle('hidden');

