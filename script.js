/* SIGECO 28 - Frontend
   Desarrollado por SmartFastSolution LATAM · infosfs@sfslatams.com */
'use strict';

const API_URL = '/api';
const TOKEN_KEY = 'sigecoToken';
// 3 MB reales -> ~4 MB en Base64: cabe en el límite de 4.5 MB por petición de Vercel.
const MAX_ARCHIVO = 3_000_000;

const app = {
    token: null, usuario: null,
    usuarios: [], pagos: [], ingresos: [], egresos: [], contratos: [], actas: [], actividades: [],
    cursoFiltro: 'TODOS', cerrando: false
};

const MENU_STAFF = [
    ['resumen', 'bi-grid-1x2-fill', 'Resumen General'],
    ['curso', 'bi-bar-chart-fill', 'Resumen por Curso'],
    ['pagos', 'bi-journal-check', 'Control de Pagos'],
    ['egresos', 'bi-cart-fill', 'Egresos'],
    ['actividades', 'bi-cash-coin', 'Actividades Extra'],
    ['contratos', 'bi-file-earmark-text-fill', 'Contratos'],
    ['actas', 'bi-briefcase-fill', 'Actas de Comité']
];
const MENU_SOLO_ADMIN = [
    ['usuarios', 'bi-people-fill', 'Usuarios'],
    ['cuotas', 'bi-wallet2', 'Cuotas']
];
const MENU_PADRE = [
    ['estado', 'bi-clock-history', 'Estado de Cuenta'],
    ['gastos', 'bi-cart-x-fill', 'Transparencia de Gastos'],
    ['documentos', 'bi-folder2-open-fill', 'Documentos y Actas']
];

/* ══════════ Utilidades ══════════ */
const $id = (id) => document.getElementById(id);

// Escapa texto antes de meterlo en innerHTML (evita XSS con datos de usuarios).
function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const dinero = (n) => (n < 0 ? '-$' : '$') + Math.abs(num(n)).toFixed(2);
const fechaCorta = (f) => String(f ?? '').slice(0, 10);
const hoy = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const mismoCurso = (a, b) => !!a && !!b &&
    String(a).toUpperCase().replace(/\s+/g, '') === String(b).toUpperCase().replace(/\s+/g, '');
const esTodos = (c) => String(c ?? '').trim().toUpperCase() === 'TODOS';
const esStaff = () => !!app.usuario && (app.usuario.rol === 'ADMIN' || app.usuario.rol === 'COMITE');
const setHTML = (id, html) => { const el = $id(id); if (el) el.innerHTML = html; };
const setTxt = (id, t) => { const el = $id(id); if (el) el.textContent = t; };
const filaVacia = (cols, msg) => `<tr><td colspan="${cols}" class="text-muted py-4">${esc(msg)}</td></tr>`;

class ApiFail extends Error {
    constructor(mensaje, status = 0, sesion = false) { super(mensaje); this.status = status; this.sesion = sesion; }
}

function mostrarAlerta(mensaje, icono = '✅') {
    const modal = $id('modalAlertaSistema');
    if (!modal) { alert(`${icono} ${mensaje}`); return; }
    setTxt('alerta-icono', icono);
    setTxt('alerta-mensaje', mensaje);
    bootstrap.Modal.getOrCreateInstance(modal).show();
}

// Cierra un modal y espera a que termine la animación (evita choques con la alerta siguiente).
function cerrarModal(id) {
    return new Promise((resolve) => {
        const el = $id(id);
        const inst = el && bootstrap.Modal.getInstance(el);
        if (!inst || !el.classList.contains('show')) return resolve();
        el.addEventListener('hidden.bs.modal', () => resolve(), { once: true });
        inst.hide();
    });
}
const abrirModal = (id) => bootstrap.Modal.getOrCreateInstance($id(id)).show();

/* ══════════ Comunicación con la API ══════════ */
async function api(ruta, { method = 'GET', body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && app.token) headers.Authorization = `Bearer ${app.token}`;

    let resp;
    try {
        resp = await fetch(API_URL + ruta, {
            method, headers, cache: 'no-store',
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
    } catch {
        throw new ApiFail('Error de conexión con el servidor.');
    }
    let data = null;
    try { data = await resp.json(); } catch { /* respuesta sin JSON */ }

    if (resp.status === 401 && auth) {
        sesionExpirada(data && data.mensaje);
        throw new ApiFail((data && data.mensaje) || 'Sesión expirada.', 401, true);
    }
    if (!resp.ok || !data || data.exito === false) {
        const msg = (data && data.mensaje) ||
            (resp.status === 413 ? 'El archivo es demasiado grande.' : `Error del servidor (${resp.status}).`);
        throw new ApiFail(msg, resp.status);
    }
    return data;
}

function sesionExpirada(mensaje) {
    if (app.cerrando || !app.token) return;
    cerrarSesion();
    mostrarAlerta(mensaje || 'Su sesión expiró. Inicie sesión nuevamente.', '⏱️');
}

async function cargarDatos() {
    const d = await api('/datos');
    app.usuarios = d.usuarios || [];
    app.pagos = d.pagos || [];
    app.ingresos = d.ingresos || [];
    app.egresos = d.egresos || [];
    app.contratos = d.contratos || [];
    app.actas = d.actas || [];
    app.actividades = d.actividades || [];
}

// Recarga los datos y vuelve a dibujar la pantalla del rol actual.
async function refrescar() {
    try {
        await cargarDatos();
        if (esStaff()) renderAdmin(); else renderPadre();
    } catch (e) {
        if (!e.sesion) mostrarAlerta(e.message, '❌');
    }
}

// Evita doble envío y centraliza el manejo de errores de los formularios.
async function manejarEnvio(e, tarea) {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try { await tarea(); }
    catch (err) { if (!err.sesion) mostrarAlerta(err.message || 'Ocurrió un error inesperado.', err.status === 0 ? '❌' : '⚠️'); }
    finally { if (btn) btn.disabled = false; }
}

/* ══════════ Archivos ══════════ */
function leerComoDataURL(blob) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new ApiFail('No se pudo leer el archivo.'));
        r.readAsDataURL(blob);
    });
}

async function leerPDF(file) {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))
        throw new ApiFail('Solo se permiten archivos PDF.');
    if (file.size > MAX_ARCHIVO) throw new ApiFail('El archivo supera los 3 MB permitidos.');
    return leerComoDataURL(file);
}

// Los vouchers tomados con el celular suelen pesar varios MB: se reducen automáticamente.
async function leerImagenJPG(file) {
    if (file.type !== 'image/jpeg' && !/\.jpe?g$/i.test(file.name))
        throw new ApiFail('Solo se permiten imágenes JPG / JPEG (no PDF ni PNG).');
    if (file.size <= 1_000_000) return leerComoDataURL(file);
    try {
        const bmp = await createImageBitmap(file);
        const escala = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * escala);
        canvas.height = Math.round(bmp.height * escala);
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
        if (blob && blob.size <= MAX_ARCHIVO) return leerComoDataURL(blob);
    } catch { /* si el navegador no puede, se intenta con el original */ }
    if (file.size > MAX_ARCHIVO) throw new ApiFail('La imagen es demasiado pesada (máx. 3 MB).');
    return leerComoDataURL(file);
}

async function descargarArchivo(ruta, nombre) {
    try {
        const d = await api(ruta);
        let b64 = d.base64 || '';
        if (!b64.startsWith('data:')) {
            const mime = b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('iVBOR') ? 'image/png' : 'application/pdf';
            b64 = `data:${mime};base64,${b64}`;
        }
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(b64);
        if (!m) throw new ApiFail('El documento está dañado.');
        const bin = atob(m[2]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: m[1] }));
        const a = document.createElement('a');
        a.href = url; a.download = nombre; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
    } catch (e) {
        if (!e.sesion) mostrarAlerta(e.message || 'No se pudo descargar el archivo.', '❌');
    }
}
const abrirVoucher = (id) => descargarArchivo(`/pagos/ver/${id}`, `voucher_pago_${id}.jpg`);
const verDocumentoPDF = (id) => descargarArchivo(`/documentos/ver/${id}`, `documento_contrato_${id}.pdf`);
const verActaPDF = (id) => descargarArchivo(`/actas/ver/${id}`, `acta_reunion_${id}.pdf`);
const verEgresoPDF = (id) => descargarArchivo(`/egresos/ver/${id}`, `factura_egreso_${id}.pdf`);
const verActividadPDF = (id) => descargarArchivo(`/actividades/ver/${id}`, `respaldo_actividad_${id}.pdf`);

/* ══════════ Sesión ══════════ */
function mostrarLogin() {
    $id('vista-app').classList.add('oculto');
    $id('vista-login').classList.remove('oculto');
}

async function iniciarSesion(e) {
    e.preventDefault();
    const errDiv = $id('mensaje-error');
    const btn = e.target.querySelector('[type="submit"]');
    errDiv.classList.add('oculto');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
        const data = await api('/login', {
            method: 'POST', auth: false,
            body: { username: $id('username').value.trim(), password: $id('password').value }
        });
        app.token = data.token;
        sessionStorage.setItem(TOKEN_KEY, data.token);
        $id('form-login').reset();
        await entrarSesion(data.usuario);
    } catch (err) {
        if (err.sesion) return;
        errDiv.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-2"></i>${esc(err.message)}`;
        errDiv.classList.remove('oculto');
    } finally { btn.disabled = false; }
}

async function entrarSesion(usuario) {
    app.usuario = usuario;
    // El cambio de clave obligatorio no se puede saltar recargando la página.
    if (Number(usuario.debe_cambiar_clave) === 1) {
        $id('vista-login').classList.add('oculto');
        $id('vista-app').classList.add('oculto');
        abrirModal('modalForzarClave');
        return;
    }
    await cargarDatos();
    mostrarApp();
}

async function guardarClaveForzada(e) {
    await manejarEnvio(e, async () => {
        const clave = $id('nueva-clave-forzada').value;
        if (clave !== $id('nueva-clave-confirmar').value) throw new ApiFail('Las contraseñas no coinciden.');
        const d = await api('/usuarios/clave', { method: 'POST', body: { username: app.usuario.username, password: clave } });
        app.token = d.token;
        sessionStorage.setItem(TOKEN_KEY, d.token);
        app.usuario.debe_cambiar_clave = 0;
        $id('form-forzar-clave').reset();
        await cerrarModal('modalForzarClave');
        await cargarDatos();
        mostrarApp();
        mostrarAlerta('Contraseña actualizada con éxito.', '🔐');
    });
}

function cerrarSesion() {
    app.cerrando = true;
    app.token = null; app.usuario = null;
    Object.assign(app, { usuarios: [], pagos: [], ingresos: [], egresos: [], contratos: [], actas: [], actividades: [], cursoFiltro: 'TODOS' });
    sessionStorage.removeItem(TOKEN_KEY);
    document.querySelectorAll('.modal.show').forEach((m) => bootstrap.Modal.getInstance(m)?.hide());
    $id('portal-admin').classList.add('oculto');
    $id('portal-padre').classList.add('oculto');
    $id('menu-navegacion').innerHTML = '';
    $id('form-login').reset();
    $id('mensaje-error').classList.add('oculto');
    mostrarLogin();
    app.cerrando = false;
}

/* ══════════ Navegación ══════════ */
function mostrarApp() {
    const u = app.usuario;
    $id('vista-login').classList.add('oculto');
    $id('vista-app').classList.remove('oculto');
    setTxt('nav-nombre-usuario', u.nombre);
    setTxt('badge-rol', u.rol);

    if (esStaff()) {
        const items = u.rol === 'ADMIN' ? [...MENU_STAFF, ...MENU_SOLO_ADMIN] : MENU_STAFF;
        setHTML('menu-navegacion', items.map(([id, icono, texto], i) => itemMenu('nav-admin', id, icono, texto, i === 0)).join(''));
        $id('portal-admin').classList.remove('oculto');
        $id('portal-padre').classList.add('oculto');
        renderAdmin();
        mostrarModuloAdmin('resumen', document.querySelector('#menu-navegacion .nav-link'));
    } else {
        setHTML('menu-navegacion', MENU_PADRE.map(([id, icono, texto], i) => itemMenu('nav-padre', id, icono, texto, i === 0)).join(''));
        $id('portal-padre').classList.remove('oculto');
        $id('portal-admin').classList.add('oculto');
        renderPadre();
        mostrarVistaPadre('estado', document.querySelector('#menu-navegacion .nav-link'));
    }
}

const itemMenu = (accion, id, icono, texto, activo) =>
    `<li class="nav-item"><a href="#" class="nav-link${activo ? ' active' : ''}" data-accion="${accion}" data-id="${id}">` +
    `<i class="bi ${icono} me-2"></i>${esc(texto)}</a></li>`;

function cerrarMenuMobile() {
    const sb = $id('sidebarMenu');
    if (sb && sb.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(sb).hide();
}

function activarMenu(el) {
    document.querySelectorAll('#menu-navegacion .nav-link').forEach((n) => n.classList.remove('active'));
    if (el) el.classList.add('active');
    cerrarMenuMobile();
}

function mostrarModuloAdmin(modulo, el) {
    document.querySelectorAll('#portal-admin > [id^="admin-modulo-"]').forEach((d) => d.classList.add('oculto'));
    $id(`admin-modulo-${modulo}`)?.classList.remove('oculto');
    activarMenu(el);
}
async function cambiarModuloAdmin(modulo, el) { mostrarModuloAdmin(modulo, el); await refrescar(); }

function mostrarVistaPadre(vista, el) {
    document.querySelectorAll('#portal-padre > div').forEach((d) => d.classList.add('oculto'));
    $id(`padre-vista-${vista}`)?.classList.remove('oculto');
    activarMenu(el);
}
async function cambiarVistaPadre(vista, el) { mostrarVistaPadre(vista, el); await refrescar(); }

/* ══════════ Panel Admin / Comité ══════════ */
const cursosUnicos = () => [...new Set(app.usuarios.map((u) => (u.curso || '').trim()).filter(Boolean))].sort();

function actualizarSelectCursos() {
    const cursos = cursosUnicos();
    const opciones = (c) => `<option value="${esc(c)}">${esc(c)}</option>`;

    const filtro = $id('select-filtro-curso');
    if (filtro) {
        const previo = app.cursoFiltro;
        filtro.innerHTML = '<option value="TODOS">Todos los Cursos (General)</option>' +
            cursos.map((c) => `<option value="${esc(c)}">Solo mostrar ${esc(c)}</option>`).join('');
        if (cursos.includes(previo)) filtro.value = previo; else app.cursoFiltro = 'TODOS';
    }
    const modal = $id('act-curso');
    if (modal) {
        const previo = modal.value;
        modal.innerHTML = '<option value="">-- Seleccione un Curso --</option><option value="TODOS">🌐 Todos los Cursos (General)</option>' +
            cursos.map(opciones).join('');
        if (previo === 'TODOS' || cursos.includes(previo)) modal.value = previo;
    }
}

function datosFiltrados() {
    const f = app.cursoFiltro;
    if (f === 'TODOS') return { usuarios: app.usuarios, pagos: app.pagos, actividades: app.actividades };
    const usuarios = app.usuarios.filter((u) => mismoCurso(u.curso, f));
    const logins = new Set(usuarios.map((u) => u.username));
    return {
        usuarios,
        pagos: app.pagos.filter((p) => logins.has(p.usuario)),
        actividades: app.actividades.filter((a) => mismoCurso(a.curso, f) || esTodos(a.curso))
    };
}

const totalValidado = (pagos) => pagos.filter((p) => p.estado === 'VALIDADO').reduce((s, p) => s + num(p.valor), 0);

function renderAdmin() {
    actualizarSelectCursos();
    const { usuarios, pagos, actividades } = datosFiltrados();
    const padres = usuarios.filter((u) => u.rol === 'PADRE');
    const nombreDe = new Map(app.usuarios.map((u) => [u.username, u]));

    renderResumen(pagos, actividades);
    renderDashboardCurso();

    // Usuarios
    setHTML('tabla-usuarios-admin', usuarios.length === 0 ? filaVacia(7, 'No hay usuarios para mostrar.') : usuarios.map((u) => {
        const activo = u.estado === 'ACTIVO';
        const btnEstado = activo
            ? `<button class="btn btn-sm btn-outline-danger fw-bold shadow-sm" data-accion="toggle-usuario" data-id="${esc(u.username)}"><i class="bi bi-x-circle-fill me-1"></i>Desactivar</button>`
            : `<button class="btn btn-sm btn-success fw-bold shadow-sm" data-accion="toggle-usuario" data-id="${esc(u.username)}"><i class="bi bi-check-circle-fill me-1"></i>Activar</button>`;
        const fiesta = u.asiste_fiesta === 'SI' ? `<span class="badge bg-info text-dark">SÍ (${num(u.adultos_fiesta)}A + ${num(u.ninos_fiesta)}N)</span>` : '<span class="text-muted">-</span>';
        return `<tr><td class="text-primary fw-bold">${esc(u.username)}</td><td>${esc(u.nombre)}</td>
            <td><span class="badge bg-primary px-2">${esc(u.rol)}</span></td>
            <td><span class="badge bg-dark">${esc(u.curso || '-')}</span></td>
            <td><span class="badge ${activo ? 'bg-success' : 'bg-secondary'} px-2 py-1">${esc(u.estado)}</span></td>
            <td>${fiesta}</td>
            <td><div class="d-flex flex-column flex-md-row justify-content-center align-items-center gap-1">
                <button class="btn btn-sm btn-primary fw-bold shadow-sm" data-accion="editar-usuario" data-id="${esc(u.username)}"><i class="bi bi-pencil-fill me-1"></i>Editar</button>${btnEstado}
            </div></td></tr>`;
    }).join(''));

    // Pagos
    setHTML('tabla-pagos', pagos.length === 0 ? filaVacia(7, 'No hay pagos para mostrar.') : pagos.map((p) => {
        const du = nombreDe.get(p.usuario);
        const btnVoucher = p.tiene_voucher ? `<button class="btn btn-sm btn-info text-white fw-bold ms-2 shadow-sm" data-accion="voucher" data-id="${num(p.id)}"><i class="bi bi-image me-1"></i>Voucher</button>` : '';
        const validado = p.estado === 'VALIDADO';
        const accion = validado ? '<i class="bi bi-check-circle-fill text-success fs-5"></i>'
            : `<button class="btn btn-sm btn-primary fw-bold shadow-sm" data-accion="aprobar-pago" data-id="${num(p.id)}"><i class="bi bi-check2 me-1"></i>Aprobar</button>`;
        return `<tr><td class="fw-bold text-dark text-start">${esc(du ? du.nombre : 'Usuario desconocido')}<br><small class="text-muted">${esc(du ? du.curso : '')}</small></td>
            <td class="text-primary fw-bold">${esc(p.usuario)}</td><td>${esc(fechaCorta(p.fecha))}</td>
            <td>${esc(p.voucher)} ${btnVoucher}</td><td class="fw-bold text-success">${dinero(p.valor)}</td>
            <td><span class="badge ${validado ? 'bg-success' : 'bg-warning text-dark'} px-2 py-1">${esc(p.estado)}</span></td><td>${accion}</td></tr>`;
    }).join(''));

    // Actividades
    setHTML('tabla-actividades', actividades.length === 0 ? filaVacia(5, 'No hay actividades registradas en este curso.') : actividades.map((a) => {
        const btn = a.tiene_doc ? `<button class="btn btn-sm btn-outline-success fw-bold shadow-sm" data-accion="doc-actividad" data-id="${num(a.id)}"><i class="bi bi-file-pdf-fill me-1"></i>Ver Respaldo</button>` : '-';
        return `<tr><td>${esc(fechaCorta(a.fecha))}</td><td><span class="badge bg-dark">${esc(a.curso)}</span></td>
            <td class="fw-bold text-dark">${esc(a.descripcion)}</td><td class="fw-bold text-success">+${dinero(a.valor)}</td><td>${btn}</td></tr>`;
    }).join(''));

    // Egresos
    setHTML('tabla-egresos', app.egresos.length === 0 ? filaVacia(6, 'No hay egresos registrados.') : app.egresos.map((e) => {
        const pagado = (e.estado_pago || 'PENDIENTE') === 'PAGADO';
        const btnDoc = e.tiene_doc ? `<button class="btn btn-sm btn-outline-danger fw-bold shadow-sm" data-accion="doc-egreso" data-id="${num(e.id)}"><i class="bi bi-file-pdf-fill me-1"></i>Factura</button>` : '';
        const btnEstado = pagado
            ? `<button class="btn btn-sm btn-warning fw-bold shadow-sm" data-accion="egreso-estado" data-id="${num(e.id)}" data-estado="PENDIENTE"><i class="bi bi-arrow-counterclockwise"></i> Revertir</button>`
            : `<button class="btn btn-sm btn-success fw-bold shadow-sm" data-accion="egreso-estado" data-id="${num(e.id)}" data-estado="PAGADO"><i class="bi bi-check2"></i> Marcar Pagado</button>`;
        return `<tr><td>${esc(fechaCorta(e.fecha))}</td><td class="fw-bold text-dark">${esc(e.descripcion)}</td><td>${esc(e.proveedor)}</td>
            <td class="fw-bold text-danger">-${dinero(e.valor)}</td>
            <td><span class="badge ${pagado ? 'bg-success' : 'bg-warning text-dark'} px-2 py-1">${pagado ? 'PAGADO' : 'PENDIENTE'}</span></td>
            <td><div class="d-flex gap-1 justify-content-center">${btnDoc} ${btnEstado}</div></td></tr>`;
    }).join(''));

    // Actas
    setHTML('tabla-actas', app.actas.length === 0 ? filaVacia(3, 'No hay actas registradas.') : app.actas.map((a) => {
        const btn = a.tiene_doc ? `<button class="btn btn-sm btn-dark fw-bold shadow-sm" data-accion="doc-acta" data-id="${num(a.id)}"><i class="bi bi-file-pdf-fill me-1"></i>Abrir Acta</button>` : '-';
        return `<tr><td>${esc(fechaCorta(a.fecha))}</td><td class="fw-bold text-dark">${esc(a.descripcion)}</td><td>${btn}</td></tr>`;
    }).join(''));

    // Cuotas
    const abonado = new Map();
    app.pagos.filter((p) => p.estado === 'VALIDADO').forEach((p) => abonado.set(p.usuario, (abonado.get(p.usuario) || 0) + num(p.valor)));
    setHTML('tabla-cuotas', padres.length === 0 ? filaVacia(5, 'No hay padres de familia para mostrar.') : padres.map((u) => {
        const cuota = num(u.valor_total_pagar);
        const pagado = abonado.get(u.username) || 0;
        const saldo = cuota - pagado;
        return `<tr><td class="text-primary fw-bold">${esc(u.username)}</td>
            <td>${esc(u.nombre)}<br><span class="badge bg-dark">${esc(u.curso || 'Sin curso')}</span></td>
            <td class="fw-bold">${dinero(cuota)}</td>
            <td><div class="small text-success mb-1">Abonado: <span class="fw-bold">${dinero(pagado)}</span></div>
                <div class="fw-bold ${saldo > 0 ? 'text-danger' : 'text-success'} border-top pt-1">${saldo >= 0 ? 'Saldo pendiente' : 'Saldo a favor'}: ${dinero(Math.abs(saldo))}</div></td>
            <td><button class="btn btn-sm btn-warning fw-bold shadow-sm" data-accion="editar-cuota" data-id="${esc(u.username)}" data-valor="${cuota}"><i class="bi bi-pencil-fill me-1"></i>Modificar Base</button></td></tr>`;
    }).join(''));

    // Contratos
    setHTML('tabla-contratos', app.contratos.length === 0 ? filaVacia(6, 'No hay contratos registrados.') : app.contratos.map((c) => {
        const btn = c.tiene_doc ? `<button class="btn btn-sm btn-outline-secondary fw-bold shadow-sm" data-accion="doc-contrato" data-id="${num(c.id)}"><i class="bi bi-file-pdf-fill me-1"></i>Ver</button>` : '-';
        return `<tr><td>${esc(fechaCorta(c.fecha))}</td><td class="fw-bold text-dark">${esc(c.descripcion)}</td><td>${esc(c.proveedor)}</td>
            <td class="fw-bold text-success">${dinero(c.valor)}</td><td>${btn}</td>
            <td><div class="form-check form-switch d-flex justify-content-center"><input class="form-check-input" type="checkbox" ${Number(c.visible) ? 'checked' : ''} data-cambio="toggle-visible" data-id="${num(c.id)}" aria-label="Visible para padres"></div></td></tr>`;
    }).join(''));

    // Select de padres para registrar pagos manuales (todos los activos, sin importar el filtro)
    const sel = $id('pago-usuario');
    if (sel && esStaff()) {
        sel.innerHTML = '<option value="">-- Seleccione un padre --</option>' +
            app.usuarios.filter((u) => u.rol === 'PADRE' && u.estado === 'ACTIVO')
                .map((u) => `<option value="${esc(u.username)}">${esc(u.nombre)} (${esc(u.username)} - ${esc(u.curso || 'Sin curso')})</option>`).join('');
    }
}

function renderResumen(pagos, actividades) {
    const todos = app.cursoFiltro === 'TODOS';
    const ingresos = (todos ? app.ingresos.reduce((s, i) => s + num(i.valor), 0) : 0)
        + totalValidado(pagos) + actividades.reduce((s, a) => s + num(a.valor), 0);
    const egresos = todos ? app.egresos.reduce((s, e) => s + num(e.valor), 0) : 0;
    const meta = app.usuarios.filter((u) => u.rol === 'PADRE' && (todos || mismoCurso(u.curso, app.cursoFiltro)))
        .reduce((s, u) => s + num(u.valor_total_pagar), 0);
    setTxt('dash-ingresos', dinero(ingresos));
    setTxt('dash-egresos', dinero(egresos));
    setTxt('dash-saldo', dinero(ingresos - egresos));
    setTxt('dash-meta', dinero(meta));
}

function renderDashboardCurso() {
    let cursos = cursosUnicos();
    if (app.cursoFiltro !== 'TODOS') cursos = cursos.filter((c) => mismoCurso(c, app.cursoFiltro));
    if (cursos.length === 0) {
        setHTML('tabla-dashboard-curso', filaVacia(4, 'No hay datos para mostrar.'));
        setHTML('lista-barras-progreso', '<p class="text-muted mb-0">No hay datos de avance para mostrar.</p>');
        return;
    }
    const resumen = cursos.map((curso) => {
        const alumnos = app.usuarios.filter((u) => u.rol === 'PADRE' && mismoCurso(u.curso, curso));
        const logins = new Set(app.usuarios.filter((u) => mismoCurso(u.curso, curso)).map((u) => u.username));
        const meta = alumnos.reduce((s, a) => s + num(a.valor_total_pagar), 0);
        const rec = totalValidado(app.pagos.filter((p) => logins.has(p.usuario)))
            + app.actividades.filter((a) => mismoCurso(a.curso, curso)).reduce((s, a) => s + num(a.valor), 0);
        return { curso, alumnos: alumnos.length, meta, rec };
    });
    setHTML('tabla-dashboard-curso', resumen.map((r) => `<tr><td class="fw-bold" style="color:#1e3c72;">${esc(r.curso)}</td>
        <td class="fw-bold">${r.alumnos}</td><td class="fw-bold text-success">${dinero(r.rec)}</td><td class="fw-bold text-info">${dinero(r.meta)}</td></tr>`).join(''));
    setHTML('lista-barras-progreso', resumen.map((r) => {
        const pct = r.meta > 0 ? Math.min(100, Math.round((r.rec / r.meta) * 100)) : 0;
        const color = pct > 80 ? 'bg-success' : pct > 40 ? 'bg-warning text-dark' : 'bg-danger';
        return `<div class="mb-3"><div class="d-flex justify-content-between align-items-end mb-1">
            <span class="fw-bold text-dark" style="font-size:.9rem;">${esc(r.curso)}</span>
            <span class="fw-bold text-muted" style="font-size:.8rem;">${dinero(r.rec)} / ${dinero(r.meta)}</span></div>
            <div class="progress barra-progreso"><div class="progress-bar ${color} fw-bold" role="progressbar" style="width:${pct}%" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">${pct > 5 ? pct + '%' : ''}</div></div></div>`;
    }).join(''));
}

/* ══════════ Panel Padre ══════════ */
function renderPadre() {
    const yo = app.usuarios.find((u) => u.username === app.usuario.username) || app.usuario;
    const misPagos = app.pagos.filter((p) => p.usuario === yo.username);
    const validados = misPagos.filter((p) => p.estado === 'VALIDADO');
    const cuota = num(yo.valor_total_pagar);
    const pagado = validados.reduce((s, p) => s + num(p.valor), 0);
    const pendiente = cuota - pagado;

    setTxt('lbl-total-pagar', dinero(cuota));
    setTxt('lbl-pagado', dinero(pagado));
    setTxt('lbl-pendiente-titulo', pendiente < 0 ? 'Saldo a Favor' : 'Saldo Pendiente');
    setTxt('lbl-pendiente', dinero(Math.abs(pendiente)));
    const card = $id('card-pendiente');
    if (card) { card.classList.toggle('bg-danger', pendiente > 0); card.classList.toggle('bg-success', pendiente <= 0); }

    // Libro Mayor: la deuda inicial siempre va primero; luego los abonos validados por fecha.
    const movs = [...validados].sort((a, b) => fechaCorta(a.fecha).localeCompare(fechaCorta(b.fecha)) || num(a.id) - num(b.id));
    let saldo = 0;
    const filas = [];
    if (cuota > 0) {
        saldo -= cuota;
        filas.push(filaLedger('Inicial', '-', 'Total Gastos Asignados', 0, cuota, saldo));
    }
    movs.forEach((p) => {
        saldo += num(p.valor);
        filas.push(filaLedger(fechaCorta(p.fecha), p.voucher || '-', 'Abono / Transferencia', num(p.valor), 0, saldo));
    });
    setHTML('tabla-ledger', filas.length ? filas.join('') : filaVacia(6, 'No hay movimientos en tu cuenta.'));

    // Todos mis pagos, incluidos los que aún esperan aprobación
    setHTML('tabla-pagos-padre', misPagos.length === 0 ? filaVacia(5, 'Aún no has registrado pagos.') : misPagos.map((p) => {
        const ok = p.estado === 'VALIDADO';
        const btn = p.tiene_voucher ? `<button class="btn btn-sm btn-outline-info fw-bold" data-accion="voucher" data-id="${num(p.id)}"><i class="bi bi-image me-1"></i>Ver</button>` : '-';
        return `<tr><td>${esc(fechaCorta(p.fecha))}</td><td>${esc(p.voucher)}</td><td class="fw-bold">${dinero(p.valor)}</td>
            <td><span class="badge ${ok ? 'bg-success' : 'bg-warning text-dark'}">${ok ? 'VALIDADO' : 'EN REVISIÓN'}</span></td><td>${btn}</td></tr>`;
    }).join(''));

    // Transparencia de gastos
    setHTML('tabla-egresos-padre', app.egresos.length === 0 ? filaVacia(5, 'No hay gastos registrados por el comité.') : app.egresos.map((e) => {
        const pagadoE = (e.estado_pago || 'PENDIENTE') === 'PAGADO';
        const btn = e.tiene_doc ? `<button class="btn btn-sm btn-outline-danger fw-bold shadow-sm" data-accion="doc-egreso" data-id="${num(e.id)}"><i class="bi bi-file-pdf-fill me-1"></i>Ver</button>` : '-';
        return `<tr><td>${esc(fechaCorta(e.fecha))}</td><td class="fw-bold text-dark">${esc(e.descripcion)}</td>
            <td class="fw-bold ${pagadoE ? 'text-success' : 'text-danger'}">${pagadoE ? '' : '-'}${dinero(e.valor)}</td>
            <td><span class="badge ${pagadoE ? 'bg-success' : 'bg-warning text-dark'} px-2 py-1">${pagadoE ? 'PAGADO' : 'PENDIENTE'}</span></td><td>${btn}</td></tr>`;
    }).join(''));

    // Documentos
    setTxt('lbl-curso-padre', yo.curso ? `(Tu Curso: ${yo.curso})` : '');
    const visibles = app.contratos.filter((c) => Number(c.visible));
    setHTML('tabla-docs-padre', visibles.length === 0 ? filaVacia(3, 'No hay contratos públicos habilitados.') : visibles.map((c) =>
        `<tr><td>${esc(fechaCorta(c.fecha))}</td><td class="fw-bold text-dark">${esc(c.descripcion)}</td>
        <td><button class="btn btn-sm btn-outline-primary fw-bold shadow-sm" data-accion="doc-contrato" data-id="${num(c.id)}"><i class="bi bi-file-pdf-fill me-1"></i>Ver PDF</button></td></tr>`).join(''));

    const misActs = app.actividades.filter((a) => mismoCurso(a.curso, yo.curso) || esTodos(a.curso));
    setHTML('tabla-actividades-padre', misActs.length === 0 ? filaVacia(3, 'No hay fondos recaudados en tu curso.') : misActs.map((a) => {
        const btn = a.tiene_doc ? `<button class="btn btn-sm btn-outline-success fw-bold shadow-sm" data-accion="doc-actividad" data-id="${num(a.id)}"><i class="bi bi-file-pdf-fill me-1"></i>Ver Respaldo</button>` : '-';
        return `<tr><td>${esc(fechaCorta(a.fecha))}</td><td class="fw-bold text-dark">${esc(a.descripcion)}<br><small class="text-success">+${dinero(a.valor)}</small></td><td>${btn}</td></tr>`;
    }).join(''));

    setHTML('tabla-actas-padre', app.actas.length === 0 ? filaVacia(3, 'No hay actas de reuniones disponibles.') : app.actas.map((a) =>
        `<tr><td>${esc(fechaCorta(a.fecha))}</td><td class="fw-bold text-dark">${esc(a.descripcion)}</td>
        <td><button class="btn btn-sm btn-dark fw-bold shadow-sm" data-accion="doc-acta" data-id="${num(a.id)}"><i class="bi bi-file-pdf-fill me-1"></i>Abrir Acta</button></td></tr>`).join(''));
}

function filaLedger(fecha, comprobante, concepto, ingreso, gasto, saldo) {
    return `<tr><td>${esc(fecha)}</td><td>${esc(comprobante)}</td><td class="fw-bold">${esc(concepto)}</td>
        <td class="text-success fw-bold">${ingreso > 0 ? dinero(ingreso) : '-'}</td>
        <td class="text-danger fw-bold">${gasto > 0 ? '-' + dinero(gasto) : '-'}</td>
        <td class="fw-bold ${saldo >= 0 ? 'text-success' : 'text-danger'}">${dinero(saldo)}</td></tr>`;
}

/* ══════════ Acciones: pagos ══════════ */
function abrirModalPago() {
    const sel = $id('pago-usuario');
    $id('form-pago').reset();
    limpiarFeedbackArchivos();
    if (app.usuario.rol === 'PADRE') {
        sel.innerHTML = `<option value="${esc(app.usuario.username)}">${esc(app.usuario.nombre)}</option>`;
        sel.value = app.usuario.username;
        sel.disabled = true;
    } else {
        sel.disabled = false;
    }
    abrirModal('modalPago');
}

async function registrarPago(e) {
    await manejarEnvio(e, async () => {
        const file = $id('pago-voucher-file').files[0];
        if (!file) throw new ApiFail('Debes adjuntar el voucher (imagen JPG).');
        const voucher_b64 = await leerImagenJPG(file);
        await api('/pagos', {
            method: 'POST',
            body: {
                usuario: $id('pago-usuario').value, fecha: $id('pago-fecha').value,
                voucher: $id('pago-voucher').value.trim(), valor: num($id('pago-valor').value), voucher_b64
            }
        });
        $id('form-pago').reset();
        limpiarFeedbackArchivos();
        await cerrarModal('modalPago');
        mostrarAlerta(esStaff() ? 'Pago registrado. Queda pendiente de aprobación.' : 'Pago registrado. El comité lo revisará pronto.');
        await refrescar();
    });
}

async function validarPago(id) {
    if (!confirm('¿Aprobar esta transferencia? El valor se descontará de la deuda del padre y esta acción no se puede deshacer.')) return;
    try {
        await api('/pagos/validar', { method: 'POST', body: { id: Number(id) } });
        mostrarAlerta('Transferencia aprobada.');
    } catch (e) { if (!e.sesion) mostrarAlerta(e.message, '❌'); }
    await refrescar();
}

/* ══════════ Acciones: documentos y egresos ══════════ */
async function registrarActividad(e) {
    await manejarEnvio(e, async () => {
        const file = $id('act-file').files[0];
        if (!file) throw new ApiFail('Debes adjuntar el PDF de respaldo.');
        const archivoData = await leerPDF(file);
        await api('/actividades', {
            method: 'POST',
            body: {
                curso: $id('act-curso').value.trim(), descripcion: $id('act-desc').value.trim(),
                fecha: $id('act-fecha').value, valor: num($id('act-valor').value), archivoNombre: file.name, archivoData
            }
        });
        $id('form-actividad').reset(); limpiarFeedbackArchivos();
        await cerrarModal('modalActividad');
        mostrarAlerta('Ingreso por actividad guardado correctamente.');
        await refrescar();
    });
}

async function registrarEgreso(e) {
    await manejarEnvio(e, async () => {
        const file = $id('egreso-file').files[0];
        const archivoData = file ? await leerPDF(file) : '';
        await api('/egresos', {
            method: 'POST',
            body: {
                fecha: $id('egreso-fecha').value, descripcion: $id('egreso-desc').value.trim(),
                proveedor: $id('egreso-prov').value.trim(), valor: num($id('egreso-valor').value),
                archivoNombre: file ? file.name : '', archivoData
            }
        });
        $id('form-egreso').reset(); limpiarFeedbackArchivos();
        await cerrarModal('modalEgreso');
        mostrarAlerta('Egreso registrado correctamente.');
        await refrescar();
    });
}

async function marcarEgresoEstado(id, estado) {
    try {
        await api('/egresos/estado', { method: 'POST', body: { id: Number(id), estado } });
        mostrarAlerta(`Egreso marcado como ${estado}.`);
    } catch (e) { if (!e.sesion) mostrarAlerta(e.message, '❌'); }
    await refrescar();
}

async function subirActa(e) {
    await manejarEnvio(e, async () => {
        const file = $id('acta-file').files[0];
        if (!file) throw new ApiFail('Por favor, selecciona un documento PDF.');
        const archivoData = await leerPDF(file);
        await api('/actas', {
            method: 'POST',
            body: { fecha: $id('acta-fecha').value, descripcion: $id('acta-desc').value.trim(), archivoNombre: file.name, archivoData }
        });
        $id('form-acta').reset(); limpiarFeedbackArchivos();
        await cerrarModal('modalActa');
        mostrarAlerta('Acta subida correctamente.');
        await refrescar();
    });
}

async function subirContrato(e) {
    await manejarEnvio(e, async () => {
        const file = $id('ctr-file').files[0];
        if (!file) throw new ApiFail('Por favor, selecciona un documento PDF.');
        const archivoData = await leerPDF(file);
        await api('/documentos', {
            method: 'POST',
            body: {
                tipo: 'CONTRATO', fecha: $id('ctr-fecha').value, desc: $id('ctr-desc').value.trim(),
                prov: $id('ctr-prov').value.trim(), valor: num($id('ctr-valor').value),
                archivoNombre: file.name, archivoData, visible: $id('ctr-visible').checked ? 1 : 0
            }
        });
        $id('form-contrato').reset(); limpiarFeedbackArchivos();
        await cerrarModal('modalContrato');
        mostrarAlerta('Contrato subido y guardado exitosamente.');
        await refrescar();
    });
}

async function toggleVisibleDoc(id, visible) {
    try { await api('/documentos/visible', { method: 'POST', body: { id: Number(id), visible: visible ? 1 : 0 } }); }
    catch (e) { if (!e.sesion) mostrarAlerta(e.message, '❌'); }
    await refrescar();
}

/* ══════════ Acciones: usuarios y cuotas ══════════ */
function abrirModalUsuario(username = null) {
    $id('form-usuario').reset();
    const editar = !!username;
    const u = editar ? app.usuarios.find((x) => x.username === username) : null;
    if (editar && !u) return;

    $id('usu-modo').value = editar ? 'EDITAR' : 'CREAR';
    $id('usu-id').readOnly = editar;
    $id('usu-id').value = editar ? u.username : '';
    $id('usu-nombre').value = editar ? u.nombre : '';
    $id('usu-rol').value = editar ? u.rol : 'PADRE';
    $id('usu-curso').value = editar ? (u.curso || '') : '';
    $id('usu-fiesta').value = editar ? (u.asiste_fiesta || 'NO') : 'NO';
    $id('usu-adultos').value = editar ? num(u.adultos_fiesta) : 0;
    $id('usu-ninos').value = editar ? num(u.ninos_fiesta) : 0;
    $id('usu-clave').required = !editar;
    setTxt('lbl-usu-clave', editar ? 'Restablecer contraseña (opcional)' : 'Contraseña');
    setTxt('ayuda-usu-clave', editar
        ? 'Déjela vacía para no cambiarla. Si escribe una, el usuario deberá cambiarla en su próximo ingreso.'
        : 'Mínimo 6 caracteres. El usuario deberá cambiarla en su primer ingreso.');
    setTxt('titulo-modal-usuario', editar ? 'Modificar Usuario' : 'Nuevo Usuario');
    abrirModal('modalUsuario');
}

async function guardarUsuario(e) {
    await manejarEnvio(e, async () => {
        const editar = $id('usu-modo').value === 'EDITAR';
        const username = $id('usu-id').value.trim();
        const clave = $id('usu-clave').value;
        await api('/usuarios', {
            method: editar ? 'PUT' : 'POST',
            body: {
                username, nombre: $id('usu-nombre').value.trim(), rol: $id('usu-rol').value,
                curso: $id('usu-curso').value.trim(), password: clave,
                asiste_fiesta: $id('usu-fiesta').value,
                adultos_fiesta: parseInt($id('usu-adultos').value, 10) || 0,
                ninos_fiesta: parseInt($id('usu-ninos').value, 10) || 0
            }
        });
        if (editar && clave) {
            const r = await api('/usuarios/clave', { method: 'POST', body: { username, password: clave } });
            if (r.token) { app.token = r.token; sessionStorage.setItem(TOKEN_KEY, r.token); }
        }
        await cerrarModal('modalUsuario');
        mostrarAlerta('Usuario guardado en la base de datos.');
        await refrescar();
    });
}

async function toggleEstadoUsuario(username) {
    const u = app.usuarios.find((x) => x.username === username);
    if (!u) return;
    const nuevo = u.estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO';
    if (nuevo === 'INACTIVO' && !confirm(`¿Desactivar a ${u.nombre}? No podrá iniciar sesión.`)) return;
    try { await api('/usuarios/estado', { method: 'POST', body: { username, estado: nuevo } }); }
    catch (err) { if (!err.sesion) mostrarAlerta(err.message, '❌'); }
    await refrescar();
}

function abrirModalCuota(username, valor) {
    $id('cuota-usu').value = username;
    $id('nueva-cuota-input').value = num(valor).toFixed(2);
    abrirModal('modalAsignarCuota');
}

async function guardarNuevaCuota(e) {
    await manejarEnvio(e, async () => {
        await api('/usuarios/cuota', {
            method: 'POST',
            body: { username: $id('cuota-usu').value, valor: num($id('nueva-cuota-input').value) }
        });
        await cerrarModal('modalAsignarCuota');
        mostrarAlerta('Cuota actualizada.');
        await refrescar();
    });
}

/* ══════════ Eventos ══════════ */
function limpiarFeedbackArchivos() {
    document.querySelectorAll('input[type="file"]').forEach((input) => {
        input.value = '';
        input.classList.remove('is-valid');
        $id('feedback-' + input.id)?.classList.add('oculto');
    });
}

const ACCIONES = {
    'nav-admin': (id, el) => cambiarModuloAdmin(id, el),
    'nav-padre': (id, el) => cambiarVistaPadre(id, el),
    'salir': () => cerrarSesion(),
    'nuevo-usuario': () => abrirModalUsuario(),
    'editar-usuario': (id) => abrirModalUsuario(id),
    'toggle-usuario': (id) => toggleEstadoUsuario(id),
    'nuevo-pago': () => abrirModalPago(),
    'aprobar-pago': (id) => validarPago(id),
    'voucher': (id) => abrirVoucher(id),
    'nuevo-egreso': () => abrirModal('modalEgreso'),
    'egreso-estado': (id, el) => marcarEgresoEstado(id, el.dataset.estado),
    'nueva-actividad': () => abrirModal('modalActividad'),
    'nuevo-contrato': () => abrirModal('modalContrato'),
    'nueva-acta': () => abrirModal('modalActa'),
    'editar-cuota': (id, el) => abrirModalCuota(id, el.dataset.valor),
    'doc-contrato': (id) => verDocumentoPDF(id),
    'doc-acta': (id) => verActaPDF(id),
    'doc-egreso': (id) => verEgresoPDF(id),
    'doc-actividad': (id) => verActividadPDF(id)
};

function registrarEventos() {
    // Un solo listener para todos los botones generados dinámicamente (sin onclick inline).
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-accion]');
        const fn = el && ACCIONES[el.dataset.accion];
        if (!fn) return;
        e.preventDefault();
        fn(el.dataset.id, el);
    });
    document.addEventListener('change', (e) => {
        if (e.target.dataset.cambio === 'toggle-visible') toggleVisibleDoc(e.target.dataset.id, e.target.checked);
    });

    $id('form-login').addEventListener('submit', iniciarSesion);
    $id('form-forzar-clave').addEventListener('submit', guardarClaveForzada);
    $id('form-usuario').addEventListener('submit', guardarUsuario);
    $id('form-pago').addEventListener('submit', registrarPago);
    $id('form-cuota').addEventListener('submit', guardarNuevaCuota);
    $id('form-contrato').addEventListener('submit', subirContrato);
    $id('form-egreso').addEventListener('submit', registrarEgreso);
    $id('form-acta').addEventListener('submit', subirActa);
    $id('form-actividad').addEventListener('submit', registrarActividad);
    $id('select-filtro-curso').addEventListener('change', (e) => { app.cursoFiltro = e.target.value; renderAdmin(); });

    // Fecha de hoy por defecto en los formularios
    document.addEventListener('show.bs.modal', (ev) =>
        ev.target.querySelectorAll('input[type="date"]').forEach((i) => { if (!i.value) i.value = hoy(); }));

    // Confirmación visual al adjuntar archivos
    document.querySelectorAll('input[type="file"]').forEach((input) => {
        input.addEventListener('change', () => {
            const fb = $id('feedback-' + input.id);
            if (!fb) return;
            if (input.files.length > 0) {
                fb.innerHTML = `<i class="bi bi-check-circle-fill me-1"></i> Archivo adjuntado: <strong>${esc(input.files[0].name)}</strong>`;
                fb.classList.remove('oculto');
                input.classList.add('is-valid');
            } else {
                fb.classList.add('oculto');
                input.classList.remove('is-valid');
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    registrarEventos();
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) { mostrarLogin(); return; }
    app.token = token;
    try {
        // El rol y el estado se confirman con el servidor: no se confía en datos guardados en el navegador.
        const s = await api('/sesion');
        await entrarSesion(s.usuario);
    } catch (e) {
        if (!e.sesion) { app.token = null; sessionStorage.removeItem(TOKEN_KEY); mostrarLogin(); mostrarAlerta(e.message, '❌'); }
    }
});
