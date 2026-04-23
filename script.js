const URL_GAS = "https://script.google.com/macros/s/AKfycbwd-ZWvaEIwbxwUCchK_6cYK7c1xnqRtqrEugYIrjj3On82kH68Hr_lSoN4u72r7Cxf/exec";
const MODEL_URL = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model/';

const video = document.getElementById('video');
const loadingBox = document.getElementById('loading');
const videoContainer = document.getElementById('videoContainer');
const instruction = document.getElementById('instruction');
const gpsStatus = document.getElementById('gpsStatus');

let faceMatcher = null;
let databaseSiswa = [];
let databaseAbsen = [];
let mode = 'absen';
let isProcessing = false;
let userLocation = null;
let isInsideArea = false;

// Variabel Pengaturan Server
let schoolPolygonData = null;
let schoolPolygon = null;
let serverJamMasuk = '07:00';
let serverJamPulang = '14:00';

// INIT SISTEM
async function init() {
    try {
        loadingBox.style.display = 'flex';
        videoContainer.style.display = 'none';

        // 1. Minta Izin Lokasi Sekaligus Load Model
        await Promise.all([
            requestLocation(),
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);

        // 2. Load Database Pengaturan, Pengguna & Absen
        await loadSettings(); 
        await loadDatabase();
        await loadAbsenData();

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

// ------------------------------------------------------------------
// PENGATURAN DARI SERVER (MAP, JAM, & WA)
// ------------------------------------------------------------------
async function loadSettings() {
    try {
        const response = await fetch(URL_GAS, {
            method: 'POST',
            body: JSON.stringify({ action: "get_settings" })
        });
        const res = await response.json();
        
        if (res.status === "Success" && res.data) {
            // Load Jam
            if (res.data.jamMasuk) serverJamMasuk = res.data.jamMasuk;
            if (res.data.jamPulang) serverJamPulang = res.data.jamPulang;
            
            document.getElementById('setJamMasuk').value = serverJamMasuk;
            document.getElementById('setJamPulang').value = serverJamPulang;
            document.getElementById('infoJamServer').innerText = "✅ Tersinkronisasi dengan server.";
            document.getElementById('infoJamServer').className = "text-success mt-2";

            // Load Token & ID Grup Fonnte WA
            if (res.data.fonnteToken) document.getElementById('fonnteToken').value = res.data.fonnteToken;
            if (res.data.fonnteGrupId) document.getElementById('fonnteGrupId').value = res.data.fonnteGrupId;

            // Load Polygon
            if (res.data.polygon && res.data.polygon !== "") {
                schoolPolygonData = JSON.parse(res.data.polygon);
                schoolPolygon = schoolPolygonData.coordinates[0];
                document.getElementById('statusMapAdmin').className = "alert alert-success";
                document.getElementById('statusMapAdmin').innerText = "Status Peta: Koordinat berhasil dimuat dari Server.";
                
                // 👇 INI KUNCI PERBAIKANNYA 👇
                // Panggil ulang pengecekan GPS agar statusnya langsung berubah 
                // dari "Mendownload data..." menjadi "Posisi Sesuai"
                if (typeof checkGeofence === "function") {
                    checkGeofence();
                }
            }
        }
    } catch (e) {
        console.error("Gagal memuat pengaturan dari server", e);
    }
}

async function loadDatabase() {
    try {
        const res = await fetch(URL_GAS);
        databaseSiswa = await res.json();
        
        const validData = databaseSiswa.filter(s => s.descriptor && s.descriptor !== "");
        if(validData.length > 0) {
            const labeled = validData.map(s => new faceapi.LabeledFaceDescriptors(String(s.nis), [new Float32Array(JSON.parse(s.descriptor))]));
            faceMatcher = new faceapi.FaceMatcher(labeled, 0.55);
        }
        renderTable();
        populateKelasDropdown(); 
    } catch (e) {
        console.error("Gagal memuat database siswa", e);
    }
}

function populateKelasDropdown() {
    const filterWali = document.getElementById('filterKelasWali');
    const uniqueKelas = [...new Set(databaseSiswa.filter(s => s.kelas).map(s => s.kelas))];
    
    filterWali.innerHTML = '<option value="">-- Pilih Kelas --</option>';
    uniqueKelas.forEach(kelas => {
        filterWali.innerHTML += `<option value="${kelas}">${kelas}</option>`;
    });
}

// ------------------------------------------------------------------
// DATA ABSENSI
// ------------------------------------------------------------------
async function loadAbsenData() {
    try {
        const response = await fetch(URL_GAS, {
            method: 'POST',
            body: JSON.stringify({ action: "get_absen" })
        });
        const res = await response.json();
        if (res.status === "Success") {
            databaseAbsen = res.message; 
            renderWaliKelas();
            renderAdminAbsen();
        }
    } catch (e) {
        console.error("Gagal menarik data absen", e);
    }
}

function renderWaliKelas() {
    const filterKelas = document.getElementById('filterKelasWali').value;
    const table = document.getElementById('tableWaliKelas');
    table.innerHTML = "";

    const tglHariIni = new Date().toLocaleDateString('en-CA'); 
    let siswaKelas = databaseSiswa.filter(s => s.role === 'Siswa' && (filterKelas === "" || s.kelas === filterKelas));

    if(siswaKelas.length === 0) {
        table.innerHTML = `<tr><td colspan="3" class="text-center">Silakan pilih kelas terlebih dahulu.</td></tr>`;
        return;
    }

    siswaKelas.forEach(siswa => {
        let absenHariIni = databaseAbsen.find(a => a.nis === String(siswa.nis) && a.tanggal === tglHariIni);
        
        let jamMasuk = absenHariIni ? `<span class="badge bg-success">${absenHariIni.jam_masuk}</span>` : `<span class="badge bg-danger">Belum Hadir</span>`;
        let jamPulang = (absenHariIni && absenHariIni.jam_pulang) ? `<span class="badge bg-info">${absenHariIni.jam_pulang}</span>` : `<span class="text-muted">-</span>`;

        table.innerHTML += `<tr>
            <td><b>${siswa.nama}</b><br><small class="text-muted">${siswa.nis}</small></td>
            <td>${jamMasuk}</td>
            <td>${jamPulang}</td>
        </tr>`;
    });
}

document.getElementById('filterKelasWali').addEventListener('change', renderWaliKelas);

function renderAdminAbsen() {
    const table = document.getElementById('tableAbsenAdmin');
    if(!table) return;
    table.innerHTML = "";
    
    const filterTgl = document.getElementById('filterTanggalAdmin').value;
    let dataTampil = databaseAbsen;
    
    if(filterTgl) {
        dataTampil = dataTampil.filter(a => a.tanggal === filterTgl);
    }

    if(dataTampil.length === 0) {
        table.innerHTML = `<tr><td colspan="5" class="text-center">Tidak ada absen pada tanggal ini.</td></tr>`;
        return;
    }

    [...dataTampil].reverse().forEach(a => {
        table.innerHTML += `<tr>
            <td>${a.tanggal}</td>
            <td><b>${a.nama}</b><br><small>${a.nis}</small></td>
            <td>${a.kelas}</td>
            <td><span class="badge bg-success">${a.jam_masuk}</span></td>
            <td>${a.jam_pulang ? `<span class="badge bg-info">${a.jam_pulang}</span>` : '-'}</td>
        </tr>`;
    });
}

// ------------------------------------------------------------------
// GEOFENCING & LOKASI
// ------------------------------------------------------------------
function requestLocation() {
    return new Promise((resolve, reject) => {
        const urlParams = new URLSearchParams(window.location.search);
        // Jika URL ditambahkan ?mode=mesin_sekolah, otomatis lolos GPS
        if (urlParams.get('mode') === 'mesin_sekolah') {
            userLocation = [-6.123456, 106.123456]; // Isi dengan koordinat palsu (titik sekolah) agar sistem tidak error
            isInsideArea = true;
            gpsStatus.className = "gps-status text-success";
            gpsStatus.innerHTML = "📍 Posisi Sesuai: Menggunakan Mesin Utama Sekolah.";
            resolve();
            return; // Hentikan proses pencarian GPS HP di sini
        }
        if (!navigator.geolocation) {
            gpsStatus.innerText = "❌ Browser tidak mendukung GPS!";
            resolve(); return;
        }
        
        gpsStatus.innerText = "⏳ Sedang mencari titik lokasi akurat...";
        
        navigator.geolocation.watchPosition(
            (position) => {
                userLocation = [position.coords.latitude, position.coords.longitude]; 
                checkGeofence();
                resolve();
            },
            (error) => {
                gpsStatus.className = "gps-status text-danger";
                gpsStatus.innerText = "❌ Izin Lokasi Ditolak / GPS Lemah! Anda tidak bisa absen.";
                isInsideArea = false;
                resolve(); 
            },
            // PENAMBAHAN PENTING: Paksa akurasi tinggi, jangan pakai cache, beri batas waktu
            { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
        );
    });
}

function checkGeofence() {
    // --- TAMBAHAN PENTING: Kunci Bypass untuk Mesin ---
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('mode') === 'mesin_sekolah') {
        isInsideArea = true;
        gpsStatus.className = "gps-status text-success";
        gpsStatus.innerHTML = "📍 Posisi Sesuai: Menggunakan Mesin Utama Sekolah.";
        return; // Hentikan fungsi di sini, jangan hitung poligon!
    }
    // ---------------------------------------------------

    // Pisahkan pengecekan agar pesannya jelas penyebabnya lambat di mana
    if (!schoolPolygon) {
        gpsStatus.innerText = "⏳ Mendownload data area sekolah dari server...";
        isInsideArea = true; // Default true jika server belum diset
        return;
    }

    if (!userLocation) {
        gpsStatus.innerText = "⏳ Menunggu koordinat GPS dari HP Anda...";
        return;
    }

    let inside = false;
    let x = userLocation[1], y = userLocation[0]; 
    for (let i = 0, j = schoolPolygon.length - 1; i < schoolPolygon.length; j = i++) {
        let xi = schoolPolygon[i][0], yi = schoolPolygon[i][1];
        let xj = schoolPolygon[j][0], yj = schoolPolygon[j][1];
        let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }

    isInsideArea = inside;
    if (inside) {
        gpsStatus.className = "gps-status text-success";
        gpsStatus.innerText = "📍 Posisi Sesuai: Anda berada di Area Sekolah.";
    } else { 
        gpsStatus.className = "gps-status text-danger";
        gpsStatus.innerHTML = `
            ❌ Posisi Ditolak: Anda berada di Luar Area Sekolah!<br>
            <span style="font-size: 12px; color: #6c757d;">
                <em>⏳ Jika Anda sudah di sekolah, diamkan HP 15-30 detik sampai GPS akurat. Jangan di-refresh.</em>
            </span>
        `;
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

            if (ratio < 0.50) { 
                if (!isInsideArea && schoolPolygon) {
                    instruction.innerHTML = "<span class='text-danger'>DITOLAK: Anda di luar jangkauan GPS sekolah!</span>";
                    setTimeout(() => { instruction.innerText = "Silakan Hadap Kamera"; }, 3000);
                    return requestAnimationFrame(detect);
                }

                isProcessing = true;
                instruction.innerHTML = `<span class='text-white'>Data dikirim ke server...</span>`;
                
                try {
                    const response = await fetch(URL_GAS, {
                        method: 'POST',
                        body: JSON.stringify({ 
                            action: "absen_otomatis", 
                            nis: user.nis, 
                            nama: user.nama, 
                            kelas: user.kelas,
                            role: user.role, 
                            jamBatasMasuk: serverJamMasuk,
                            jamBatasPulang: serverJamPulang
                        })
                    });
                    const resJson = await response.json();
                    
                    instruction.innerHTML = `<span class='text-warning'>${resJson.message}</span>`;
                    
                    // PENEMPATAN SUARA DI SINI (Hanya bunyi saat sukses absen)
                    if (resJson.status === "Success" || resJson.message.toLowerCase().includes("berhasil")) {
                        bicara(`Terima kasih ${user.nama}, absen berhasil.`);
                    }

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
// TABEL PESERTA & EDIT DATA
// ------------------------------------------------------------------
function renderTable() {
    const filter = document.getElementById('filterRole').value;
    const table = document.getElementById('tablePeserta');
    table.innerHTML = "";

    const data = filter === "Semua" ? databaseSiswa : databaseSiswa.filter(s => s.role === filter);
    
    data.forEach(s => {
        const hasFace = s.descriptor && s.descriptor.length > 10;
        table.innerHTML += `<tr>
            <td><b>${s.nama}</b><br><small>${s.role} - ${s.kelas}</small></td>
            <td>${s.nis}</td>
            <td>${hasFace ? '<span class="text-success fw-bold">✔ Ada</span>' : '<span class="text-danger">✘ Belum</span>'}</td>
            <td>
                <button onclick="openEditModal('${s.nis}')" class="btn btn-sm btn-warning fw-bold text-dark mb-1">✏️ Edit</button>
                ${!hasFace ? `<button onclick="openRekamModal('${s.nis}', '${s.nama}')" class="btn btn-sm btn-success mb-1">📸 Rekam</button>` : ''}
            </td>
        </tr>`;
    });
}

function openEditModal(nisTarget) {
    const user = databaseSiswa.find(s => String(s.nis) === String(nisTarget));
    if(!user) return;
    
    document.getElementById('editNisLama').value = user.nis;
    document.getElementById('editNama').value = user.nama;
    document.getElementById('editRole').value = user.role;
    document.getElementById('editNis').value = user.nis;
    document.getElementById('editNisn').value = user.nisn || '';
    document.getElementById('editKelas').value = user.kelas || '';
    document.getElementById('editHpSiswa').value = user.no_siswa || '';
    document.getElementById('editHpOrtu').value = user.no_ortu || '';

    new bootstrap.Modal(document.getElementById('modalEditUser')).show();
}

async function simpanEditUser() {
    const btn = event.target;
    btn.innerText = "Menyimpan...";
    btn.disabled = true;

    const payload = {
        action: "edit_user",
        nis: document.getElementById('editNisLama').value,
        nama: document.getElementById('editNama').value,
        role: document.getElementById('editRole').value,
        nis_baru: document.getElementById('editNis').value,
        nisn: document.getElementById('editNisn').value,
        kelas: document.getElementById('editKelas').value,
        no_siswa: document.getElementById('editHpSiswa').value,
        no_ortu: document.getElementById('editHpOrtu').value
    };

    try {
        const response = await fetch(URL_GAS, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const res = await response.json();
        alert(res.message);
        location.reload(); 
    } catch(e) {
        alert("Gagal menyimpan perubahan. Cek koneksi.");
        btn.innerText = "Simpan Perubahan";
        btn.disabled = false;
    }
}

// ------------------------------------------------------------------
// IMPORT EXCEL
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
        const sheetName = workbook.SheetNames[0]; 
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
            location.reload(); 
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
    btn.disabled = true; 
    
    try {
        inst.innerText = "Mendeteksi wajah... Diam 2 detik";
        await new Promise(r => setTimeout(r, 2000));

        const det = await faceapi.detectSingleFace(
            document.getElementById('videoAdmin'), 
            new faceapi.TinyFaceDetectorOptions()
        ).withFaceLandmarks().withFaceDescriptor();

        if (det) {
            inst.innerText = "Wajah tertangkap! Mengirim ke database...";
            
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
// MAPPING LOKASI & NAVIGASI
// ------------------------------------------------------------------
let map, drawnItems;

function initMap() {
    if (map) {
        setTimeout(() => map.invalidateSize(), 200);
        return;
    }

    map = L.map('map').setView([-6.2444, 106.8778], 16); 
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    if (schoolPolygonData) {
        try {
            L.geoJSON(schoolPolygonData, { 
                onEachFeature: (f, layer) => {
                    drawnItems.addLayer(layer);
                    schoolPolygon = f.geometry.coordinates[0];
                } 
            });
            map.fitBounds(drawnItems.getBounds());
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

    setTimeout(() => {
        map.invalidateSize();
    }, 500);
}

document.addEventListener('shown.bs.tab', function (e) {
    if (e.target.getAttribute('href') === '#tabMap') {
        if (map) {
            setTimeout(() => { map.invalidateSize(true); }, 100);
        } else {
            initMap();
        }
    }
});

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

// SIMPAN PETA KE SERVER (GOOGLE SHEETS)
async function savePolygon() {
    if(!schoolPolygon) return alert("Gambar kotak area dulu!");
    
    const geoJsonString = JSON.stringify({type: "Polygon", coordinates: [schoolPolygon]});
    const btn = event.target;
    btn.innerText = "Menyimpan ke Server...";
    btn.disabled = true;

    try {
        const response = await fetch(URL_GAS, {
            method: 'POST',
            body: JSON.stringify({ 
                action: "save_settings", 
                type: "polygon",
                value: geoJsonString 
            })
        });
        const res = await response.json();
        alert(res.message);
        checkGeofence();
    } catch(e) {
        alert("Gagal menyimpan radius sekolah. Cek koneksi internet.");
    } finally {
        btn.innerText = "Simpan Radius Sekolah ke Server";
        btn.disabled = false;
    }
}

// SIMPAN JAM KE SERVER (GOOGLE SHEETS)
async function simpanPengaturanJam() {
    const m = document.getElementById('setJamMasuk').value;
    const p = document.getElementById('setJamPulang').value;
    const btn = document.getElementById('btnSimpanJam');
    
    btn.innerText = "Menyimpan...";
    btn.disabled = true;

    try {
        const response = await fetch(URL_GAS, {
            method: 'POST',
            body: JSON.stringify({ 
                action: "save_settings", 
                type: "jam",
                jamMasuk: m,
                jamPulang: p
            })
        });
        const res = await response.json();
        
        serverJamMasuk = m;
        serverJamPulang = p;
        alert(res.message);
    } catch(e) {
        alert("Gagal menyimpan pengaturan jam.");
    } finally {
        btn.innerText = "💾 Simpan Jam";
        btn.disabled = false;
    }
}

// SIMPAN SETTING WA FONNTE KE SERVER (BARU DITAMBAHKAN)
async function saveFonnteSettings() {
    const token = document.getElementById('fonnteToken').value;
    const grupId = document.getElementById('fonnteGrupId').value;
    const btn = event.target;
    
    if(!token) return alert("Token WA tidak boleh kosong!");
    
    btn.innerText = "Menyimpan WA...";
    btn.disabled = true;

    try {
        const response = await fetch(URL_GAS, {
            method: 'POST',
            body: JSON.stringify({ 
                action: "save_settings", 
                type: "fonnte",
                token: token,
                grupId: grupId
            })
        });
        const res = await response.json();
        alert(res.message);
    } catch(e) {
        alert("Gagal menyimpan pengaturan WA.");
    } finally {
        btn.innerText = "Simpan WA";
        btn.disabled = false;
    }
}


// --- FITUR ADMIN: DOWNLOAD EXCEL HADIR ---
function exportExcelHadir() {
    let dataTampil = databaseAbsen || []; 
    if(dataTampil.length === 0) return alert("Belum ada data kehadiran!");

    const dataBersih = dataTampil.map(d => ({
        "Tanggal": d.tanggal_indo || d.tanggal, 
        "NIS/NIP": d.nis,
        "Nama Lengkap": d.nama,
        "Kelas/Role": d.kelas,
        "Status Kehadiran": d.status || 'Hadir',
        "Jam Masuk": d.jam_masuk,
        "Jam Pulang": (!d.jam_pulang || d.jam_pulang === "" || d.jam_pulang === "undefined") ? "Belum Pulang" : d.jam_pulang
    }));

    const ws = XLSX.utils.json_to_sheet(dataBersih);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Rekap_Kehadiran");
    XLSX.writeFile(wb, `Rekap_Absen_SMK.xlsx`);
}

// =========================================================
// FITUR BARU: SUARA, BLAST GRUP, DAN REKAP BULANAN
// =========================================================

// 1. Fungsi Text-to-Speech (Suara)
function bicara(teks) {
  if ('speechSynthesis' in window) {
    const msg = new SpeechSynthesisUtterance(teks);
    msg.lang = 'id-ID'; 
    msg.rate = 1.0; 
    window.speechSynthesis.speak(msg);
  }
}

// 2. Fungsi Tombol Blast ke Grup WA
async function blastKeGrup() {
  if(!confirm("Kirim rekap dan jadwal ke grup WA sekarang?")) return;
  
  const btn = event.target;
  const teksLama = btn.innerText;
  btn.innerText = "Mengirim pesan...";
  btn.disabled = true;
  document.body.style.cursor = 'wait';
  
  try {
    const res = await fetch(URL_GAS, { 
      method: "POST",
      body: JSON.stringify({ action: "blast_grup" })
    });
    const data = await res.json();
    alert(data.message);
  } catch (err) {
    alert("Gagal kirim blast: " + err);
  } finally {
    btn.innerText = teksLama;
    btn.disabled = false;
    document.body.style.cursor = 'default';
  }
}

// 3. Fungsi Input Manual (Sakit/Izin/Alpa)
async function setStatusManual(nis, nama, kelas, status) {
  const tgl = new Date().toISOString().split('T')[0]; 
  
  if(!confirm(`Set status ${nama} menjadi ${status} pada hari ini?`)) return;

  document.body.style.cursor = 'wait';
  try {
    const res = await fetch(URL_GAS, {
      method: "POST",
      body: JSON.stringify({
        action: "input_manual",
        nis: nis,
        nama: nama,
        kelas: kelas,
        status: status,
        tanggal: tgl
      })
    });
    const data = await res.json();
    alert(data.message);
    loadRekapBulanan(); // Otomatis refresh tabel
  } catch (err) {
    alert("Error: " + err);
  } finally {
    document.body.style.cursor = 'default';
  }
}

// 4. Fungsi Menampilkan Data Rekap di Tabel
async function loadRekapBulanan() {
  const val = document.getElementById("filterBulan").value;
  if(!val) return;
  const [tahun, bulan] = val.split("-");

  document.body.style.cursor = 'wait';
  try {
    const res = await fetch(URL_GAS, {
      method: "POST",
      body: JSON.stringify({ action: "get_rekap_bulanan", bulan: bulan, tahun: tahun })
    });
    const response = await res.json();
    const rekap = response.data || {};

    const container = document.getElementById("listSiswaManual");
    container.innerHTML = ""; 
    
    // Perbaikan: Pakai databaseSiswa, difilter hanya yang statusnya "Siswa"
    const dataSiswa = databaseSiswa.filter(s => s.role === "Siswa");

    if (dataSiswa.length > 0) {
      dataSiswa.forEach(u => {
        const r = rekap[u.nis] || { hadir: 0, telat: 0, sakit: 0, izin: 0, alpa: 0 };
        const row = `
          <tr>
            <td>${u.nama}</td>
            <td>${u.kelas}</td>
            <td>
              <div class="btn-group btn-group-sm">
                <button class="btn btn-warning" onclick="setStatusManual('${u.nis}','${u.nama}','${u.kelas}','SAKIT')">Sakit</button>
                <button class="btn btn-info" onclick="setStatusManual('${u.nis}','${u.nama}','${u.kelas}','IZIN')">Izin</button>
                <button class="btn btn-danger" onclick="setStatusManual('${u.nis}','${u.nama}','${u.kelas}','ALPA')">Alpa</button>
              </div>
            </td>
            <td>
              <small>H:${r.hadir} | T:${r.telat} | S:${r.sakit} | I:${r.izin} | A:${r.alpa}</small>
            </td>
          </tr>
        `;
        container.innerHTML += row;
      });
    } else {
      container.innerHTML = "<tr><td colspan='4' class='text-center'>Data siswa belum dimuat atau kosong.</td></tr>";
    }
  } catch (err) {
    console.error(err);
    alert("Gagal memuat rekap bulanan!");
  } finally {
    document.body.style.cursor = 'default';
  }
}

// Start
init();
