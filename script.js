const URL_GAS = "https://script.google.com/macros/s/AKfycbwd-ZWvaEIwbxwUCchK_6cYK7c1xnqRtqrEugYIrjj3On82kH68Hr_lSoN4u72r7Cxf/exec";
const MODEL_URL = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model/';

const video = document.getElementById('video');
const loadingBox = document.getElementById('loading');
const videoContainer = document.getElementById('videoContainer');
const instruction = document.getElementById('instruction');
const gpsStatus = document.getElementById('gpsStatus');

let faceMatcher = null;
let databaseSiswa = [];
let mode = 'absen';
let isProcessing = false;
let userLocation = null;
let isInsideArea = false; // Flag apakah user di dalam area sekolah

// INIT SISTEM
async function init() {
    try {
        loadingBox.style.display = 'flex';
        videoContainer.style.display = 'none';

        // 1. Minta Izin Lokasi Sekaligus Load Model
        await Promise.all([
            requestLocation(), // Ini akan memunculkan popup izin lokasi di browser
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);

        // 2. Load Database
        await loadDatabase();

        // 3. Hidupkan Kamera
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        
        loadingBox.style.display = 'none';
        videoContainer.style.display = 'block';
        
        instruction.innerText = "Sistem Siap! Silakan Hadap Kamera.";
        detect();
    } catch (e) {
        instruction.innerText = "Gagal Memulai: " + e.message;
    }
}

async function loadDatabase() {
    const res = await fetch(URL_GAS);
    databaseSiswa = await res.json();
    
    const validData = databaseSiswa.filter(s => s.descriptor && s.descriptor !== "");
    if(validData.length > 0) {
        const labeled = validData.map(s => new faceapi.LabeledFaceDescriptors(String(s.nis), [new Float32Array(JSON.parse(s.descriptor))]));
        faceMatcher = new faceapi.FaceMatcher(labeled, 0.55);
    }
    renderTable();
}

// ------------------------------------------------------------------
// GEOFENCING & LOKASI
// ------------------------------------------------------------------
function requestLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            gpsStatus.innerText = "❌ Browser tidak mendukung GPS!";
            resolve(); return;
        }
        
        // Meminta lokasi dan mengecek radius
        navigator.geolocation.watchPosition(
            (position) => {
                userLocation = [position.coords.latitude, position.coords.longitude]; // Format Lat, Lng
                checkGeofence();
                resolve();
            },
            (error) => {
                gpsStatus.className = "gps-status text-danger";
                gpsStatus.innerText = "❌ Izin Lokasi Ditolak! Anda tidak bisa absen.";
                isInsideArea = false;
                resolve(); // Tetap resolve agar sistem wajah tetap jalan, tapi absen ditolak nanti
            },
            { enableHighAccuracy: true }
        );
    });
}

function checkGeofence() {
    const savedArea = localStorage.getItem('schoolArea');
    if (!savedArea || !userLocation) {
        gpsStatus.innerText = "⚠️ Area belum di-mapping Admin.";
        isInsideArea = true; // Jika admin belum mapping, bebas absen
        return;
    }

    const polygon = JSON.parse(savedArea).coordinates[0]; 
    // Rumus Ray-Casting untuk cek titik dalam poligon
    let inside = false;
    let x = userLocation[1], y = userLocation[0]; // Leaflet pake Lng, Lat
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        let xi = polygon[i][0], yi = polygon[i][1];
        let xj = polygon[j][0], yj = polygon[j][1];
        let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }

    isInsideArea = inside;
    if (inside) {
        gpsStatus.className = "gps-status text-success";
        gpsStatus.innerText = "📍 Posisi Sesuai: Anda berada di Area Sekolah.";
    } else {
        gpsStatus.className = "gps-status text-danger";
        gpsStatus.innerText = "❌ Posisi Ditolak: Anda berada di Luar Area Sekolah!";
    }
}

// ------------------------------------------------------------------
// DETEKSI WAJAH & AUTO ABSEN
// ------------------------------------------------------------------
async function detect() {
    if (video.paused || video.ended || mode !== 'absen') {
        requestAnimationFrame(detect); return;
    }

    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 128 });
    const result = await faceapi.detectSingleFace(video, options).withFaceLandmarks().withFaceDescriptor();

    if (result && !isProcessing && faceMatcher) {
        const nose = result.landmarks.getNose();
        const jaw = result.landmarks.getJawOutline();
        const ratio = Math.abs(nose[0].x - jaw[16].x) / Math.abs(nose[0].x - jaw[0].x);

        const match = faceMatcher.findBestMatch(result.descriptor);

        if (match.label !== 'unknown') {
            const user = databaseSiswa.find(s => String(s.nis) === match.label);
            instruction.innerHTML = `<b>${user.nama}</b> dikenali!<br>Menoleh KANAN untuk absen...`;

            if (ratio < 0.50) { // Menoleh ke kanan terdeteksi
                if (!isInsideArea && localStorage.getItem('schoolArea')) {
                    instruction.innerHTML = "<span class='text-danger'>DITOLAK: Anda di luar jangkauan GPS sekolah!</span>";
                    setTimeout(() => { instruction.innerText = "Silakan Hadap Kamera"; }, 3000);
                    return requestAnimationFrame(detect);
                }

                isProcessing = true;
                instruction.innerHTML = `<span class='text-white'>Data dikirim ke server...</span>`;
                
                try {
                    // Fetch tanpa mode no-cors agar response JSON bisa dibaca
                    const response = await fetch(URL_GAS, {
                        method: 'POST',
                        body: JSON.stringify({ action: "absen_otomatis", nis: user.nis, nama: user.nama, kelas: user.kelas })
                    });
                    const resJson = await response.json();
                    
                    instruction.innerHTML = `<span class='text-warning'>${resJson.message}</span>`;
                } catch(e) {
                    instruction.innerText = "Gagal menghubungi server!";
                }
                
                setTimeout(() => { 
                    isProcessing = false; 
                    instruction.innerText = "Sistem Siap! Silakan Hadap Kamera.";
                }, 4000);
            }
        }
    }
    requestAnimationFrame(detect);
}

// ------------------------------------------------------------------
// IMPORT EXCEL (SheetJS) -> FETCH KE GAS DATABASE
// ------------------------------------------------------------------
function downloadExcelTemplate() {
    const data = [{ "Nama Lengkap": "", "Role": "Siswa/Guru", "NIS atau NIP": "", "NISN atau Kode Guru": "", "Kelas atau Mapel": "", "No HP Siswa": "", "No HP Orang Tua": "" }];
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template_Presensi");
    XLSX.writeFile(wb, "Template_Data_Addawah.xlsx");
}

function importExcel() {
    const file = document.getElementById('fileExcel').files[0];
    const btn = document.getElementById('btnImport');
    
    if(!file) return alert("Pilih file Excel dulu!");
    
    btn.innerText = "Memproses Excel...";
    const reader = new FileReader();
    
    reader.onload = async (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, {type: 'array'});
        const sheetName = workbook.SheetNames[0]; // Ambil Sheet Pertama
        const jsonArray = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        if(jsonArray.length === 0) return alert("Data Excel kosong!");

        btn.innerText = "Mengirim ke Database (Google Sheets)...";
        
        try {
            const response = await fetch(URL_GAS, {
                method: 'POST',
                body: JSON.stringify({ action: "import_data", data: jsonArray })
            });
            const result = await response.json();
            alert(result.message);
            location.reload(); // Refresh agar data baru termuat
        } catch(err) {
            alert("Gagal mengirim data ke server. Pastikan URL Web App benar.");
            btn.innerText = "Kirim Ke Database";
        }
    };
    reader.readAsArrayBuffer(file);
}

// ------------------------------------------------------------------
// REKAM WAJAH ADMIN
// ------------------------------------------------------------------
let adminStream, currentRekamNis;
async function openRekamModal(nis, nama) {
    currentRekamNis = nis;
    document.getElementById('rekamNama').innerText = "Merekam: " + nama;
    new bootstrap.Modal(document.getElementById('modalRekam')).show();
    adminStream = await navigator.mediaDevices.getUserMedia({ video: true });
    document.getElementById('videoAdmin').srcObject = adminStream;
}

async function startCaptureAlur() {
    const inst = document.getElementById('rekamInstruksi');
    const btn = document.getElementById('btnStartCapture');
    btn.disabled = true; // Matikan tombol agar tidak diklik berkali-kali
    
    try {
        inst.innerText = "Mendeteksi wajah... Diam 2 detik";
        await new Promise(r => setTimeout(r, 2000));

        // PERBAIKAN: Tambahkan .withFaceLandmarks() sebelum .withFaceDescriptor()
        const det = await faceapi.detectSingleFace(
            document.getElementById('videoAdmin'), 
            new faceapi.TinyFaceDetectorOptions()
        ).withFaceLandmarks().withFaceDescriptor();

        if (det) {
            inst.innerText = "Wajah tertangkap! Mengirim ke database...";
            
            // Kirim ke Google Apps Script
            const response = await fetch(URL_GAS, {
                method: 'POST',
                body: JSON.stringify({ 
                    action: "update_wajah", 
                    nis: currentRekamNis, 
                    descriptor: Array.from(det.descriptor) 
                })
            });
            
            const result = await response.json();
            if(result.status === "Success") {
                alert("Berhasil! Wajah " + currentRekamNis + " sudah terdaftar.");
                location.reload();
            } else {
                alert("Gagal: " + result.message);
                btn.disabled = false;
            }
        } else {
            inst.innerText = "Gagal! Wajah tidak jelas atau tidak terdeteksi.";
            btn.disabled = false;
            alert("Wajah tidak terdeteksi. Pastikan pencahayaan cukup dan wajah terlihat jelas.");
        }
    } catch (err) {
        console.error(err);
        alert("Terjadi kesalahan teknis. Cek console.");
        btn.disabled = false;
    }
}

function stopAdminCamera() { if(adminStream) adminStream.getTracks().forEach(t => t.stop()); }

// ------------------------------------------------------------------
// MAPPING LOKASI & TABEL PESERTA
// ------------------------------------------------------------------
let map, drawnItems, schoolPolygon;
// GANTI / SESUAIKAN BAGIAN INI SAJA DI script.js

function initMap() {
    if (map) {
        // Jika sudah ada, langsung paksa refresh ukuran
        setTimeout(() => map.invalidateSize(), 200);
        return;
    }

    // Inisialisasi Map (Koordinat Default Jakarta/Sekolah)
    map = L.map('map').setView([-6.2444, 106.8778], 16); 
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Load area jika ada di localStorage
    const saved = localStorage.getItem('schoolArea');
    if (saved) {
        try {
            const geojson = JSON.parse(saved);
            L.geoJSON(geojson, { 
                onEachFeature: (f, layer) => {
                    drawnItems.addLayer(layer);
                    schoolPolygon = f.geometry.coordinates[0];
                } 
            });
        } catch(e) { console.error("Gagal load area:", e); }
    }

    const drawControl = new L.Control.Draw({
        draw: { polyline: false, circle: false, marker: false, circlemarker: false, rectangle: true, polygon: true },
        edit: { featureGroup: drawnItems }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (e) => {
        drawnItems.clearLayers();
        drawnItems.addLayer(e.layer);
        schoolPolygon = e.layer.toGeoJSON().geometry.coordinates[0];
    });

    // TRICK UTAMA: Tunggu tab benar-benar muncul baru render
    setTimeout(() => {
        map.invalidateSize();
    }, 500);
}

// Tambahkan listener khusus untuk Tab Bootstrap agar Map tidak abu-abu saat diklik
document.addEventListener('shown.bs.tab', function (e) {
    if (e.target.getAttribute('href') === '#tabMap') {
        if (map) {
            setTimeout(() => {
                map.invalidateSize(true);
            }, 100);
        } else {
            initMap();
        }
    }
});

function switchMode(m) {
    mode = m;
    document.getElementById('absenArea').style.display = m === 'absen' ? 'block' : 'none';
    document.getElementById('waliArea').style.display = m === 'walikelas' ? 'block' : 'none';
    document.getElementById('adminArea').style.display = m === 'admin' ? 'block' : 'none';
    
    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
    
    if (m === 'absen') document.getElementById('navAbsen').classList.add('active');
    if (m === 'walikelas') document.getElementById('navWali').classList.add('active');
    
    if (m === 'admin') {
        document.getElementById('navAdmin').classList.add('active');
        // PENTING: Panggil initMap setiap kali tab admin dibuka
        // setTimeout memberikan waktu bagi browser untuk memunculkan elemen #adminArea dulu
        setTimeout(initMap, 300);
    }
}

function savePolygon() {
    if(!schoolPolygon) return alert("Gambar kotak area dulu!");
    localStorage.setItem('schoolArea', JSON.stringify({type: "Polygon", coordinates: [schoolPolygon]}));
    alert("Radius Sekolah Tersimpan!");
    checkGeofence(); // Update status langsung
}

function renderTable() {
    const filter = document.getElementById('filterRole').value;
    const table = document.getElementById('tablePeserta');
    table.innerHTML = "";

    const data = filter === "Semua" ? databaseSiswa : databaseSiswa.filter(s => s.role === filter);
    
    data.forEach(s => {
        const hasFace = s.descriptor && s.descriptor.length > 10;
        table.innerHTML += `<tr>
            <td><b>${s.nama}</b><br><small>${s.role}</small></td>
            <td>${s.nis}</td>
            <td>${hasFace ? '<span class="text-success">✔</span>' : '<span class="text-danger">✘</span>'}</td>
            <td>${!hasFace ? `<button onclick="openRekamModal('${s.nis}', '${s.nama}')" class="btn btn-sm btn-success">Rekam</button>` : '-'}</td>
        </tr>`;
    });
}

function switchMode(m) {
    mode = m;
    ['absenArea', 'waliArea', 'adminArea'].forEach(id => document.getElementById(id).style.display = 'none');
    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
    
    if(m === 'absen') { document.getElementById('absenArea').style.display = 'block'; document.getElementById('navAbsen').classList.add('active'); }
    if(m === 'walikelas') { document.getElementById('waliArea').style.display = 'block'; document.getElementById('navWali').classList.add('active'); }
    if(m === 'admin') { 
        document.getElementById('adminArea').style.display = 'block'; document.getElementById('navAdmin').classList.add('active'); 
        setTimeout(initMap, 500); 
    }
}

// Start
init();