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
