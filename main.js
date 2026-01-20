// Usamos la versión CDN para que funcione directamente en GitHub sin procesos de compilación complejos
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://lpsupabase.ferrisoluciones.com';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzE1MDUwODAwLAogICJleHAiOiAxODcyODE3MjAwCn0.mKBTuXoyxw3lXRGl1VpSlGbSeiMnRardlIx1q5n-o0k';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Exponer supabase en window para debugging desde consola
window.supabase = supabase;

// ESTADO GLOBAL
let appState = {
    user: null,
    products: [],
    suppliers: [],
    searchQuery: '',
    loading: false,
    cache: null, 
    isScanning: false,
    tempPhotos: { 1: null, 2: null },
    activeCameraSlot: null,
    videoStream: null
};

// ELEMENTOS DOM
const loginScreen = document.getElementById('loginScreen');
const appScreen = document.getElementById('appScreen');
const productList = document.getElementById('productList');
const searchInput = document.getElementById('searchInput');
const editModal = document.getElementById('editModal');
const editForm = document.getElementById('editForm');
const suppliersSelect = document.getElementById('editProveedor');

// INICIALIZACIÓN
async function init() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        setupApp(session.user);
    } else {
        showLogin();
    }
}

function showLogin() {
    loginScreen.classList.remove('hidden');
    loginScreen.classList.add('fade-in-screen');
    appScreen.classList.add('hidden');
}

function setupApp(user) {
    appState.user = user;
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    appScreen.classList.add('fade-in-screen');
    loadSuppliers();
    
    // Carga inicial (directa de DB para rapidez visual)
    loadProducts();
    
    // Iniciar carga de caché en segundo plano
    iniciarCargaCache();
}

/**
 * Carga todo el inventario en memoria para búsquedas instantáneas
 */
async function iniciarCargaCache() {
    console.log('🔄 Iniciando carga de caché...');
    const progressBar = document.getElementById('cacheProgress');
    if (progressBar) {
        progressBar.style.width = '30%';
        progressBar.classList.add('cache-loading');
    }

    try {
        const { data, error } = await supabase
            .from('inventario')
            .select(`
                id, codigo, producto, stock, zona, proveedor_id,
                proveedores (empresa)
            `)
            .order('producto');

        if (error) throw error;

        appState.cache = data || [];
        console.log(`✅ Caché listo: ${appState.cache.length} productos cargados.`);
        
        if (progressBar) {
            progressBar.style.width = '100%';
            progressBar.classList.remove('cache-loading');
            setTimeout(() => {
                progressBar.style.opacity = '0';
                setTimeout(() => progressBar.remove(), 500);
            }, 1000);
        }

        // Si el usuario ya tiene algo escrito, re-filtrar con el caché
        if (searchInput.value) {
            loadProducts(searchInput.value);
        }
    } catch (error) {
        console.error('❌ Error cargando caché:', error);
        if (progressBar) progressBar.style.backgroundColor = 'red';
    }
}

// AUTENTICACIÓN
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const msg = document.getElementById('loginMessage');

    msg.textContent = 'Iniciando sesión...';
    
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) {
        msg.textContent = 'Error: ' + error.message;
        msg.style.color = 'red';
    } else {
        setupApp(data.user);
    }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
});

// DATOS
async function loadSuppliers() {
    const { data } = await supabase.from('proveedores').select('id, empresa').order('empresa');
    appState.suppliers = data || [];
    renderSuppliersSelect();
}

function renderSuppliersSelect() {
    suppliersSelect.innerHTML = appState.suppliers.map(s => 
        `<option value="${s.id}">${s.empresa}</option>`
    ).join('');
}

async function loadProducts(query = '', exactMatch = false) {
    const queryTrimmed = query.trim();

    // Si hay caché disponible, realizar búsqueda local instantánea sin mostrar "Cargando..."
    if (appState.cache) {
        // Si el query está vacío, mostrar los primeros 50 del caché
        if (queryTrimmed.length === 0) {
            appState.products = appState.cache.slice(0, 50);
            renderProducts();
        } else {
            if (exactMatch) {
                appState.products = appState.cache.filter(p => p.codigo === queryTrimmed);
                renderProducts();
            } else {
                buscarEnCache(queryTrimmed);
            }
        }
        return;
    }

    // FALLBACK: Si no hay caché (solo sucede los primeros segundos al abrir la app)
    appState.loading = true;
    renderProducts();

    try {
        let dbQuery = supabase
            .from('inventario')
            .select(`
                id, codigo, producto, stock, zona, proveedor_id,
                proveedores (empresa)
            `);

        if (queryTrimmed) {
            if (exactMatch) {
                dbQuery = dbQuery.eq('codigo', queryTrimmed);
            } else {
                const isNumeric = /^\d+$/.test(queryTrimmed);
                if (isNumeric && queryTrimmed.length >= 4) {
                    dbQuery = dbQuery.ilike('codigo', `${queryTrimmed}%`);
                } else {
                    const words = queryTrimmed.split(' ').filter(w => w.length > 0);
                    words.forEach(word => {
                        dbQuery = dbQuery.ilike('producto', `%${word}%`);
                    });
                }
            }
        }

        const { data, error } = await dbQuery.limit(50).order('producto');
        
        if (error) throw error;
        
        appState.products = data || [];
    } catch (error) {
        console.error('Error cargando productos:', error);
    } finally {
        appState.loading = false;
        renderProducts();
    }
}

/**
 * Filtra el inventario en memoria para resultados instantáneos
 */
function buscarEnCache(query) {
    const termino = query.toLowerCase().trim();
    const palabras = termino.split(/\s+/).filter(p => p.length > 0);
    const esNumerico = /^\d+$/.test(termino);

    appState.products = appState.cache.filter(p => {
        const codigo = (p.codigo || '').toLowerCase();
        const nombre = (p.producto || '').toLowerCase();

        // Si es escaneo de código (numérico de 4+ dígitos)
        if (esNumerico && termino.length >= 4) {
            return codigo.startsWith(termino);
        }

        // Búsqueda por palabras (todas deben estar presentes)
        return palabras.every(palabra => nombre.includes(palabra) || codigo.includes(palabra));
    });

    // Limitar a 50 resultados para mantener performance de renderizado
    appState.products = appState.products.slice(0, 50);
    renderProducts();
}

// RENDERIZADO
function renderProducts() {
    if (appState.loading) {
        productList.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Buscando...</p></div>';
        return;
    }

    if (appState.products.length === 0) {
        productList.innerHTML = '<div class="loading-state"><p>No se encontraron productos.</p></div>';
        return;
    }

    productList.innerHTML = appState.products.map(p => `
        <div class="product-card">
            <div class="product-info">
                <h3>${p.producto}</h3>
                <div class="product-meta">
                    <div>Código: <b>${p.codigo}</b></div>
                    <div>Stock: <b>${p.stock}</b></div>
                    <div>Zona: <span class="badge-zona">${p.zona || 'N/A'}</span></div>
                    <div>Proveedor: <b>${p.proveedores?.empresa || 'Desconocido'}</b></div>
                </div>
            </div>
            <div class="card-footer">
                <button class="btn-edit" onclick="openEditModal('${p.id}')">
                    <i class="fas fa-edit"></i> Editar
                </button>
            </div>
        </div>
    `).join('');
}

// BÚSQUEDA
let searchTimeout;
let html5QrCode = null;

// Botones de Scanner
const startScanBtn = document.getElementById('startScanBtn');
const stopScanBtn = document.getElementById('stopScanBtn');
const readerContainer = document.getElementById('readerContainer');

if (startScanBtn) {
    startScanBtn.addEventListener('click', iniciarEscaneo);
}

if (stopScanBtn) {
    stopScanBtn.addEventListener('click', detenerEscaneo);
}

async function iniciarEscaneo() {
    readerContainer.classList.remove('hidden');
    html5QrCode = new Html5Qrcode("reader");
    
    const config = { fps: 10, qrbox: { width: 250, height: 150 } };
    
    try {
        await html5QrCode.start(
            { facingMode: "environment" }, 
            config, 
            (decodedText) => {
                detenerEscaneo();
                procesarEscaneo(decodedText);
            }
        );
    } catch (err) {
        console.error("Error al iniciar cámara:", err);
        alert("No se pudo acceder a la cámara.");
        readerContainer.classList.add('hidden');
    }
}

function detenerEscaneo() {
    if (html5QrCode) {
        html5QrCode.stop().then(() => {
            readerContainer.classList.add('hidden');
        }).catch(err => console.error(err));
    } else {
        readerContainer.classList.add('hidden');
    }
}

/**
 * Procesa el código escaneado: limpia ceros y busca coincidencia exacta
 */
function procesarEscaneo(codigo) {
    // Limpiar ceros iniciales
    let codigoLimpio = codigo.replace(/^0+/, '');
    
    // Validar: solo numérico y >= 4 dígitos
    const esNumericoValido = /^\d+$/.test(codigoLimpio) && codigoLimpio.length >= 4;
    
    if (!esNumericoValido) {
        alert("Código no válido (debe ser numérico de 4+ dígitos): " + codigoLimpio);
        return;
    }

    searchInput.value = codigoLimpio;
    
    // Buscar coincidencia exacta (siempre a través de loadProducts para uniformidad)
    loadProducts(codigoLimpio, true);
}

searchInput.addEventListener('input', (e) => {
    const query = e.target.value;
    
    // Si hay caché, buscamos INSTANTÁNEAMENTE sin esperas
    if (appState.cache) {
        loadProducts(query);
        return;
    }

    // Si no hay caché, usamos el debounce para no saturar la red
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        loadProducts(query);
    }, 400);
});

// ESCÁNER (Enter key in search)
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        loadProducts(searchInput.value);
    }
});

// EDICIÓN
window.openEditModal = async (id) => {
    // Reset fotos temporales
    appState.tempPhotos = { 1: null, 2: null };
    resetPreview(1);
    resetPreview(2);
    
    try {
        // Consultamos datos frescos directamente de la DB para evitar trabajar sobre caché viejo
        const { data: p, error } = await supabase
            .from('inventario')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;
        if (!p) return;

        // Rellenar el formulario con los datos más recientes de la BD
        document.getElementById('editProductId').value = p.id;
        document.getElementById('editCodigo').value = p.codigo;
        document.getElementById('editNombre').value = p.producto;
        document.getElementById('editStock').value = p.stock;
        document.getElementById('editZona').value = p.zona;
        document.getElementById('editProveedor').value = p.proveedor_id;

        // Cargar fotos existentes
        if (p.url_foto) {
            try {
                const urls = JSON.parse(p.url_foto);
                if (Array.isArray(urls)) {
                    if (urls[0]) showPreview(1, urls[0]);
                    if (urls[1]) showPreview(2, urls[1]);
                }
            } catch (e) {
                // Si no es JSON, intentar cargar como string único
                if (p.url_foto.startsWith('http')) showPreview(1, p.url_foto);
            }
        }

        editModal.classList.remove('hidden');
    } catch (error) {
        console.error('Error al obtener producto de DB:', error);
        alert('No se pudo obtener la información actualizada del producto.');
    }
};

// GESTIÓN DE IMÁGENES CON CÁMARA CUSTOM
window.openCamera = async (index) => {
    appState.activeCameraSlot = index;
    const cameraInterface = document.getElementById('cameraInterface');
    const video = document.getElementById('videoPreview');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });
        
        appState.videoStream = stream;
        video.srcObject = stream;
        cameraInterface.classList.remove('hidden');
    } catch (err) {
        console.error("Error al acceder a la cámara:", err);
        alert("No se pudo acceder a la cámara. Revisa los permisos.");
    }
};

window.closeCamera = () => {
    const cameraInterface = document.getElementById('cameraInterface');
    const video = document.getElementById('videoPreview');

    if (appState.videoStream) {
        appState.videoStream.getTracks().forEach(track => track.stop());
        appState.videoStream = null;
    }
    
    video.srcObject = null;
    cameraInterface.classList.add('hidden');
};

window.takeSnapshot = async () => {
    const video = document.getElementById('videoPreview');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Queremos una foto cuadrada (1:1)
    const size = 800; // Tamaño fijo para uniformidad
    canvas.width = size;
    canvas.height = size;

    // Calcular recorte para que sea cuadrado y centrado
    const vWidth = video.videoWidth;
    const vHeight = video.videoHeight;
    const minSide = Math.min(vWidth, vHeight);
    
    // El punto de inicio para centrar el recorte
    const sx = (vWidth - minSide) / 2;
    const sy = (vHeight - minSide) / 2;

    // Dibujar el recorte en el canvas
    ctx.drawImage(video, sx, sy, minSide, minSide, 0, 0, size, size);

    // Convertir a WebP
    canvas.toBlob(async (blob) => {
        if (blob) {
            const index = appState.activeCameraSlot;
            appState.tempPhotos[index] = blob;
            
            const previewUrl = URL.createObjectURL(blob);
            showPreview(index, previewUrl);
            
            closeCamera();
        }
    }, 'image/webp', 0.8);
};

function showPreview(index, url) {
    const img = document.getElementById(`preview${index}`);
    const placeholder = document.getElementById(`placeholder${index}`);
    if (img) {
        img.src = url;
        img.classList.remove('hidden');
    }
    if (placeholder) {
        placeholder.classList.add('hidden');
    }
}

function resetPreview(index) {
    const img = document.getElementById(`preview${index}`);
    const placeholder = document.getElementById(`placeholder${index}`);
    if (img) {
        img.src = "";
        img.classList.add('hidden');
    }
    if (placeholder) {
        placeholder.classList.remove('hidden');
    }
}

/**
 * Sube imagen al bucket 'ferreteria'
 */
async function subirImagen(blob, productId, index) {
    if (!blob) throw new Error("No hay imagen para subir");

    const timestamp = Date.now();
    const fileName = `foto_${productId}_${index}_${timestamp}.webp`;
    
    console.log(`📤 Intentando subir: ${fileName} (${(blob.size/1024).toFixed(2)} KB)...`);

    // Probamos sin especificar contentType (como en INKA CORP que funciona)
    const { data, error } = await supabase.storage
        .from('ferreteria')
        .upload(fileName, blob, {
            cacheControl: '3600',
            upsert: false
        });

    if (error) {
        console.error("❌ Error de Storage:", error);
        console.error("❌ Error name:", error.name);
        console.error("❌ Error message:", error.message);
        console.error("❌ Error status:", error.statusCode || error.status);
        
        // Si falla, intentar con upsert por si el archivo ya existe
        if (error.message?.includes('already exists') || error.statusCode === 409) {
            console.log("🔄 Intentando con upsert=true...");
            const { data: data2, error: error2 } = await supabase.storage
                .from('ferreteria')
                .upload(fileName, blob, {
                    cacheControl: '3600',
                    upsert: true
                });
            if (error2) {
                console.error("❌ Error incluso con upsert:", error2);
                throw error2;
            }
            console.log("✅ Subida exitosa (upsert):", data2.path);
            const { data: { publicUrl } } = supabase.storage
                .from('ferreteria')
                .getPublicUrl(fileName);
            return publicUrl;
        }
        throw error;
    }

    console.log("✅ Subida exitosa:", data.path);

    const { data: { publicUrl } } = supabase.storage
        .from('ferreteria')
        .getPublicUrl(fileName);

    return publicUrl;
}

document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
        editModal.classList.add('hidden');
    });
});

editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editProductId').value;
    
    const submitBtn = editForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    
    try {
        // Validar que existan fotos (ya sean cargadas o nuevas)
        const currentPreview1 = document.getElementById('preview1').src;
        const currentPreview2 = document.getElementById('preview2').src;

        // En JS, si el src está vacío es la URL de la página o vacío. 
        // Verificamos si la imagen está oculta o no tiene src válido.
        const isFoto1Ready = !document.getElementById('preview1').classList.contains('hidden');
        const isFoto2Ready = !document.getElementById('preview2').classList.contains('hidden');

        if (!isFoto1Ready || !isFoto2Ready) {
            alert("Es obligatorio subir 2 fotos del producto.");
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Subiendo fotos...';

        let finalUrls = [];
        
        // Obtener URLs actuales o subir nuevas
        for (let i = 1; i <= 2; i++) {
            if (appState.tempPhotos[i]) {
                // Subir nueva foto
                const url = await subirImagen(appState.tempPhotos[i], id, i);
                finalUrls.push(url);
            } else {
                // Mantener foto anterior
                const prevSrc = document.getElementById(`preview${i}`).src;
                if (prevSrc.startsWith('http')) {
                    finalUrls.push(prevSrc);
                }
            }
        }

        submitBtn.textContent = 'Guardando datos...';

        const updates = {
            producto: document.getElementById('editNombre').value,
            stock: parseFloat(document.getElementById('editStock').value),
            zona: parseInt(document.getElementById('editZona').value),
            proveedor_id: document.getElementById('editProveedor').value,
            url_foto: JSON.stringify(finalUrls),
            updated_at: new Date().toISOString()
        };

        const { error } = await supabase
            .from('inventario')
            .update(updates)
            .eq('id', id);

        if (error) throw error;

        // Actualizar el caché local para que no sea necesario recargar de la red
        if (appState.cache) {
            const index = appState.cache.findIndex(p => p.id === id);
            if (index !== -1) {
                // Actualizamos los datos, incluyendo el nombre del proveedor para la UI
                const supplier = appState.suppliers.find(s => s.id === updates.proveedor_id);
                appState.cache[index] = {
                    ...appState.cache[index],
                    ...updates,
                    proveedores: supplier ? { empresa: supplier.empresa } : appState.cache[index].proveedores
                };
            }
        }

        editModal.classList.add('hidden');
        loadProducts(searchInput.value);
        alert("Producto actualizado con éxito.");

    } catch (error) {
        console.error('Error al guardar:', error);
        alert('Error al guardar: ' + error.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
});

// Iniciar app
init();
