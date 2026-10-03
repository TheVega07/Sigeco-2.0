"""
SIGECO 28 - API (Flask sobre Vercel Serverless)
Desarrollado por SmartFastSolution LATAM - infosfs@sfslatams.com

Variables de entorno requeridas (Vercel -> Settings -> Environment Variables):
    DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT (opcional, 3306)
    SECRET_KEY  -> cadena larga y aleatoria, usada para firmar las sesiones
"""
import base64
import datetime
import hashlib
import hmac
import logging
import math
import os
import re
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from functools import wraps

import mysql.connector
from flask import Flask, g, jsonify, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
# Vercel rechaza cuerpos > 4.5 MB; devolvemos un JSON claro antes de eso.
app.config["MAX_CONTENT_LENGTH"] = 4_500_000
logging.basicConfig(level=logging.INFO)

STAFF = ("ADMIN", "COMITE")
ROLES = ("ADMIN", "COMITE", "PADRE")
TOKEN_MAX_AGE = 12 * 3600          # la sesión dura 12 horas
MAX_ADJUNTO = 4_200_000            # caracteres Base64 máximos por archivo
MIN_CLAVE = 6


# ───────────────────────── Utilidades base ─────────────────────────
class ApiError(Exception):
    def __init__(self, status, mensaje):
        super().__init__(mensaje)
        self.status = status
        self.mensaje = mensaje


@app.errorhandler(ApiError)
def _api_error(e):
    return jsonify({"exito": False, "mensaje": e.mensaje}), e.status


@app.errorhandler(Exception)
def _error_generico(e):
    if isinstance(e, HTTPException):
        msg = "El archivo es demasiado grande." if e.code == 413 else (e.description or "Error")
        return jsonify({"exito": False, "mensaje": msg}), e.code
    app.logger.exception("Error no controlado")
    # No se filtra el detalle interno (host, SQL, etc.) al navegador.
    return jsonify({"exito": False, "mensaje": "Error interno del servidor."}), 500


@app.after_request
def _no_cache(resp):
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# Valores por defecto de la base en Clever Cloud. Si existen variables de entorno
# en Vercel (DB_HOST, DB_USER, ...), ESAS tienen prioridad sobre estos valores.
_DEFECTOS = {
    "DB_HOST": "bofka0yvxs4omirhgxov-mysql.services.clever-cloud.com",
    "DB_USER": "uqhndfmb7n4qeitj",
    "DB_PASSWORD": "pCgS8AdKvbLpLdCSpvqK",
    "DB_NAME": "bofka0yvxs4omirhgxov",
    "DB_PORT": "3306",
}


def _env(nombre, defecto=None):
    valor = os.environ.get(nombre) or _DEFECTOS.get(nombre) or defecto
    if valor in (None, "") and nombre == "SECRET_KEY":
        # Sin SECRET_KEY propia, se deriva una a partir de la clave de la base.
        valor = hashlib.sha256(("sigeco28:" + _env("DB_PASSWORD")).encode()).hexdigest()
    if valor in (None, ""):
        raise RuntimeError(f"Falta la variable de entorno {nombre}")
    return valor


def get_conn():
    return mysql.connector.connect(
        host=_env("DB_HOST"),
        user=_env("DB_USER"),
        password=_env("DB_PASSWORD"),
        database=_env("DB_NAME"),
        port=int(_env("DB_PORT", "3306")),
        charset="utf8mb4",
        connection_timeout=10,
    )


@contextmanager
def db(escritura=False):
    """with db() as (conn, cur): ...  -> cierra siempre; confirma si escritura=True."""
    conn = get_conn()
    cur = conn.cursor(dictionary=True)
    try:
        yield conn, cur
        if escritura:
            conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        try:
            cur.close()
        finally:
            conn.close()


def limpiar(valor):
    if isinstance(valor, Decimal):
        return float(valor)
    if isinstance(valor, (datetime.date, datetime.datetime)):
        return str(valor)
    if isinstance(valor, (bytes, bytearray)):
        try:
            return bytes(valor).decode("utf-8")
        except UnicodeDecodeError:
            return ""
    return valor


def limpiar_fila(fila):
    return {k: limpiar(v) for k, v in fila.items()} if fila else fila


def limpiar_filas(filas):
    return [limpiar_fila(f) for f in (filas or [])]


# ───────────────────────── Validaciones ─────────────────────────
def cuerpo():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError(400, "Solicitud inválida.")
    return data


def texto(valor, campo, maximo=200, obligatorio=True):
    s = "" if valor is None else str(valor).strip()
    if obligatorio and not s:
        raise ApiError(400, f"El campo «{campo}» es obligatorio.")
    if len(s) > maximo:
        raise ApiError(400, f"El campo «{campo}» no puede superar {maximo} caracteres.")
    return s


def numero(valor, campo, minimo=0, maximo=1_000_000, positivo=False):
    try:
        n = Decimal(str(valor)).quantize(Decimal("0.01"))
        if not math.isfinite(float(n)):
            raise InvalidOperation
    except (InvalidOperation, ValueError, TypeError):
        raise ApiError(400, f"«{campo}» no es un número válido.")
    if positivo and n <= 0:
        raise ApiError(400, f"«{campo}» debe ser mayor que cero.")
    if n < minimo or n > maximo:
        raise ApiError(400, f"«{campo}» está fuera del rango permitido.")
    return n


def entero(valor, campo, minimo=0, maximo=99):
    try:
        n = int(valor)
    except (ValueError, TypeError):
        raise ApiError(400, f"«{campo}» no es un número entero válido.")
    if n < minimo or n > maximo:
        raise ApiError(400, f"«{campo}» está fuera del rango permitido.")
    return n


def fecha_iso(valor, campo="Fecha"):
    try:
        return datetime.date.fromisoformat(str(valor)).isoformat()
    except ValueError:
        raise ApiError(400, f"«{campo}» no es una fecha válida (AAAA-MM-DD).")


_ADJUNTOS = {
    "pdf": ("data:application/pdf;base64,", "JVBER"),
    "jpg": ("data:image/jpeg;base64,", "/9j/"),
}


def adjunto(valor, tipo, obligatorio=False):
    """Valida un archivo Base64 (data URL): tipo real, tamaño y firma del archivo."""
    s = "" if valor is None else str(valor)
    if not s:
        if obligatorio:
            raise ApiError(400, "Debe adjuntar el archivo de respaldo.")
        return ""
    prefijo, firma = _ADJUNTOS[tipo]
    if len(s) > MAX_ADJUNTO:
        raise ApiError(413, "El archivo supera el tamaño máximo permitido (3 MB).")
    if not s.startswith(prefijo) or not s[len(prefijo):].startswith(firma):
        nombre = "PDF" if tipo == "pdf" else "imagen JPG"
        raise ApiError(400, f"El archivo debe ser un {nombre} válido.")
    try:
        base64.b64decode(s[len(prefijo):len(prefijo) + 64], validate=False)
    except Exception:
        raise ApiError(400, "El archivo está dañado.")
    return s


# ───────────────────────── Contraseñas ─────────────────────────
_PREFIJOS_HASH = ("pbkdf2:", "scrypt:")
_clave_col_ok = None


def columna_clave_ok():
    """True si usuarios.password es lo bastante ancha para guardar un hash."""
    global _clave_col_ok
    if _clave_col_ok is None:
        try:
            with db() as (_, cur):
                cur.execute(
                    "SELECT CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' "
                    "AND COLUMN_NAME = 'password'"
                )
                fila = cur.fetchone()
            n = (fila or {}).get("n") or (fila or {}).get("CHARACTER_MAXIMUM_LENGTH")
            _clave_col_ok = True if n is None else int(n) >= 110
        except Exception:
            _clave_col_ok = True
    return _clave_col_ok


def hashear(clave):
    if not columna_clave_ok():
        raise ApiError(
            500,
            "La columna usuarios.password es demasiado corta. "
            "Ejecute migracion.sql en la base de datos.",
        )
    return generate_password_hash(clave, method="pbkdf2:sha256")


def verificar_clave(guardada, ingresada):
    """Devuelve (coincide, es_formato_antiguo). Soporta claves aún en texto plano."""
    guardada = guardada or ""
    if guardada.startswith(_PREFIJOS_HASH):
        return check_password_hash(guardada, ingresada), False
    return hmac.compare_digest(guardada.encode(), ingresada.encode()), True


def huella(clave_guardada):
    return hashlib.sha256((clave_guardada or "").encode()).hexdigest()[:12]


def validar_clave_nueva(clave, username=""):
    clave = "" if clave is None else str(clave)
    if len(clave) < MIN_CLAVE:
        raise ApiError(400, f"La contraseña debe tener al menos {MIN_CLAVE} caracteres.")
    if len(clave) > 100:
        raise ApiError(400, "La contraseña es demasiado larga.")
    if username and clave.lower() == username.lower():
        raise ApiError(400, "La contraseña no puede ser igual al usuario.")
    return clave


# ───────────────────────── Sesión y permisos ─────────────────────────
def _serializer():
    return URLSafeTimedSerializer(_env("SECRET_KEY"), salt="sigeco-auth")


def emitir_token(user):
    return _serializer().dumps({"u": user["username"], "h": huella(user.get("password"))})


def usuario_publico(user):
    pub = limpiar_fila(dict(user))
    pub.pop("password", None)
    return pub


def autenticar():
    cab = request.headers.get("Authorization", "")
    if not cab.startswith("Bearer "):
        raise ApiError(401, "Debe iniciar sesión.")
    try:
        datos = _serializer().loads(cab[7:], max_age=TOKEN_MAX_AGE)
    except SignatureExpired:
        raise ApiError(401, "Su sesión expiró. Inicie sesión nuevamente.")
    except BadSignature:
        raise ApiError(401, "Sesión inválida. Inicie sesión nuevamente.")
    with db() as (_, cur):
        cur.execute("SELECT * FROM usuarios WHERE username = %s", (datos.get("u"),))
        user = cur.fetchone()
    if (not user or user.get("estado") == "INACTIVO"
            or not hmac.compare_digest(datos.get("h", ""), huella(user.get("password")))):
        raise ApiError(401, "Sesión inválida. Inicie sesión nuevamente.")
    return user


def requiere(*roles):
    def deco(fn):
        @wraps(fn)
        def envoltura(*a, **kw):
            user = autenticar()
            if roles and user["rol"] not in roles:
                raise ApiError(403, "No tiene permisos para realizar esta acción.")
            g.user = user
            return fn(*a, **kw)
        return envoltura
    return deco


def es_staff():
    return g.user["rol"] in STAFF


def mismo_curso_sql(columna):
    return f"REPLACE(UPPER({columna}), ' ', '') = REPLACE(UPPER(%s), ' ', '')"


# ───────────────────────── Login / sesión ─────────────────────────
@app.route("/api/login", methods=["POST"])
def login():
    data = cuerpo()
    username = texto(data.get("username"), "Usuario", 50)
    clave = texto(data.get("password"), "Contraseña", 100)

    with db() as (_, cur):
        cur.execute("SELECT * FROM usuarios WHERE username = %s", (username,))
        user = cur.fetchone()

    ok, antigua = verificar_clave(user["password"], clave) if user else (False, False)
    if not ok:
        raise ApiError(401, "Credenciales incorrectas")
    if user.get("estado") == "INACTIVO":
        return jsonify({"exito": False, "mensaje": "Usuario inactivo. Contacte al administrador."}), 403

    if antigua and columna_clave_ok():      # migración transparente a hash
        try:
            user["password"] = generate_password_hash(clave, method="pbkdf2:sha256")
            with db(escritura=True) as (_, cur):
                cur.execute("UPDATE usuarios SET password = %s WHERE username = %s",
                            (user["password"], username))
        except Exception:
            app.logger.exception("No se pudo migrar la contraseña a hash")
            user["password"] = clave

    return jsonify({"exito": True, "mensaje": "Login exitoso",
                    "token": emitir_token(user), "usuario": usuario_publico(user)})


@app.route("/api/sesion", methods=["GET"])
@requiere()
def sesion():
    return jsonify({"exito": True, "usuario": usuario_publico(g.user)})


# ───────────────────────── Datos para el frontend ─────────────────────────
# Nunca se envían contraseñas ni archivos Base64 aquí: solo banderas tiene_*.
@app.route("/api/datos", methods=["GET"])
@requiere()
def obtener_datos():
    u = g.user
    staff = es_staff()
    resp = {"usuarios": [], "pagos": [], "ingresos": [], "egresos": [],
            "contratos": [], "actas": [], "actividades": []}

    with db() as (_, cur):
        if staff:
            cur.execute("SELECT * FROM usuarios ORDER BY nombre")
            resp["usuarios"] = [usuario_publico(r) for r in cur.fetchall()]
        else:
            resp["usuarios"] = [usuario_publico(u)]

        sql_pagos = ("SELECT id, usuario, fecha, voucher, valor, estado, "
                     "(voucher_b64 IS NOT NULL AND voucher_b64 <> '') AS tiene_voucher FROM pagos")
        if staff:
            cur.execute(sql_pagos + " ORDER BY fecha DESC, id DESC")
        else:
            cur.execute(sql_pagos + " WHERE usuario = %s ORDER BY fecha DESC, id DESC", (u["username"],))
        resp["pagos"] = limpiar_filas(cur.fetchall())

        if staff:
            try:
                cur.execute("SELECT * FROM ingresos")
                resp["ingresos"] = limpiar_filas(cur.fetchall())
            except mysql.connector.Error:
                resp["ingresos"] = []      # la tabla ingresos es opcional

        cur.execute("SELECT id, fecha, descripcion, proveedor, valor, archivoNombre, estado_pago, "
                    "(archivoData IS NOT NULL AND archivoData <> '') AS tiene_doc "
                    "FROM egresos ORDER BY fecha DESC, id DESC")
        resp["egresos"] = limpiar_filas(cur.fetchall())

        sql_docs = ("SELECT id, fecha, descripcion, proveedor, valor, archivoNombre, visible, "
                    "(archivoData IS NOT NULL AND archivoData <> '') AS tiene_doc FROM documentos")
        cur.execute(sql_docs + ("" if staff else " WHERE visible = 1") + " ORDER BY fecha DESC, id DESC")
        resp["contratos"] = limpiar_filas(cur.fetchall())

        cur.execute("SELECT id, fecha, descripcion, archivoNombre, "
                    "(archivoData IS NOT NULL AND archivoData <> '') AS tiene_doc "
                    "FROM actas ORDER BY fecha DESC, id DESC")
        resp["actas"] = limpiar_filas(cur.fetchall())

        sql_act = ("SELECT id, curso, descripcion, fecha, valor, archivoNombre, "
                   "(archivoData IS NOT NULL AND archivoData <> '') AS tiene_doc FROM actividades")
        if staff:
            cur.execute(sql_act + " ORDER BY fecha DESC, id DESC")
        else:
            cur.execute(sql_act + " WHERE UPPER(TRIM(curso)) = 'TODOS' OR "
                        + mismo_curso_sql("curso") + " ORDER BY fecha DESC, id DESC",
                        (u.get("curso") or "\0",))
        resp["actividades"] = limpiar_filas(cur.fetchall())

    return jsonify(resp)


# ───────────────────────── Usuarios (solo ADMIN) ─────────────────────────
_RE_USUARIO = re.compile(r"^[\w.@-]{3,50}$")


@app.route("/api/usuarios", methods=["POST", "PUT"])
@requiere("ADMIN")
def guardar_usuario():
    d = cuerpo()
    username = texto(d.get("username"), "Usuario", 50)
    if request.method == "POST" and not _RE_USUARIO.match(username):
        raise ApiError(400, "El usuario solo admite letras, números, punto, guion y @ (3 a 50 caracteres).")
    nombre = texto(d.get("nombre"), "Nombre", 120)
    rol = texto(d.get("rol"), "Rol", 20).upper()
    if rol not in ROLES:
        raise ApiError(400, "Rol inválido.")
    curso = texto(d.get("curso"), "Curso", 30, obligatorio=False)

    with db(escritura=True) as (_, cur):
        cur.execute("SELECT * FROM usuarios WHERE username = %s", (username,))
        existente = cur.fetchone()

        # En edición, lo que no se envía conserva su valor actual (no se pisan datos).
        def previo(campo, defecto):
            return (existente or {}).get(campo, defecto) if campo not in d else d.get(campo)

        fiesta = str(previo("asiste_fiesta", "NO") or "NO").upper()
        if fiesta not in ("SI", "NO"):
            raise ApiError(400, "«Asiste a la fiesta» debe ser SI o NO.")
        adultos = entero(previo("adultos_fiesta", 0) or 0, "Adultos")
        ninos = entero(previo("ninos_fiesta", 0) or 0, "Niños")

        if request.method == "POST":
            if existente:
                raise ApiError(409, "Ya existe un usuario con ese nombre de usuario.")
            clave = validar_clave_nueva(d.get("password"), username)
            cur.execute(
                "INSERT INTO usuarios (username, nombre, rol, curso, password, estado, valor_total_pagar, "
                "debe_cambiar_clave, asiste_fiesta, adultos_fiesta, ninos_fiesta) "
                "VALUES (%s, %s, %s, %s, %s, 'ACTIVO', 0, 1, %s, %s, %s)",
                (username, nombre, rol, curso, hashear(clave), fiesta, adultos, ninos))
        else:
            if not existente:
                raise ApiError(404, "Usuario no encontrado.")
            if username == g.user["username"] and rol != existente["rol"]:
                raise ApiError(400, "No puede cambiar su propio rol.")
            cur.execute(
                "UPDATE usuarios SET nombre=%s, rol=%s, curso=%s, asiste_fiesta=%s, "
                "adultos_fiesta=%s, ninos_fiesta=%s WHERE username=%s",
                (nombre, rol, curso, fiesta, adultos, ninos, username))
    return jsonify({"exito": True})


@app.route("/api/usuarios/estado", methods=["POST"])
@requiere("ADMIN")
def estado_usuario():
    d = cuerpo()
    username = texto(d.get("username"), "Usuario", 50)
    estado = texto(d.get("estado"), "Estado", 10).upper()
    if estado not in ("ACTIVO", "INACTIVO"):
        raise ApiError(400, "Estado inválido.")
    if username == g.user["username"]:
        raise ApiError(400, "No puede desactivar su propia cuenta.")
    with db(escritura=True) as (_, cur):
        cur.execute("SELECT username FROM usuarios WHERE username = %s", (username,))
        if not cur.fetchone():
            raise ApiError(404, "Usuario no encontrado.")
        cur.execute("UPDATE usuarios SET estado = %s WHERE username = %s", (estado, username))
    return jsonify({"exito": True})


@app.route("/api/usuarios/clave", methods=["POST"])
@requiere()
def clave_usuario():
    """Cada usuario cambia su propia clave; un ADMIN puede restablecer la de otros (obliga a cambiarla)."""
    d = cuerpo()
    username = texto(d.get("username"), "Usuario", 50)
    propia = username == g.user["username"]
    if not propia and g.user["rol"] != "ADMIN":
        raise ApiError(403, "No tiene permisos para cambiar esta contraseña.")
    clave = validar_clave_nueva(d.get("password"), username)
    forzar = 0 if propia else 1
    with db(escritura=True) as (_, cur):
        cur.execute("SELECT * FROM usuarios WHERE username = %s", (username,))
        objetivo = cur.fetchone()
        if not objetivo:
            raise ApiError(404, "Usuario no encontrado.")
        objetivo["password"] = hashear(clave)
        cur.execute("UPDATE usuarios SET password=%s, debe_cambiar_clave=%s WHERE username=%s",
                    (objetivo["password"], forzar, username))
    resp = {"exito": True}
    if propia:  # la clave cambió: se entrega un token nuevo (los anteriores quedan invalidados)
        resp["token"] = emitir_token(objetivo)
    return jsonify(resp)


@app.route("/api/usuarios/cuota", methods=["POST"])
@requiere("ADMIN")
def cuota_usuario():
    d = cuerpo()
    username = texto(d.get("username"), "Usuario", 50)
    valor = numero(d.get("valor"), "Cuota", minimo=0)
    with db(escritura=True) as (_, cur):
        cur.execute("SELECT username FROM usuarios WHERE username = %s", (username,))
        if not cur.fetchone():
            raise ApiError(404, "Usuario no encontrado.")
        cur.execute("UPDATE usuarios SET valor_total_pagar = %s WHERE username = %s", (valor, username))
    return jsonify({"exito": True})


# ───────────────────────── Pagos ─────────────────────────
@app.route("/api/pagos", methods=["POST"])
@requiere()
def registrar_pago():
    d = cuerpo()
    if g.user["rol"] == "PADRE":
        destino = g.user["username"]             # un padre solo puede abonar a su propia deuda
    else:
        destino = texto(d.get("usuario"), "Padre", 50)
    valor = numero(d.get("valor"), "Valor", positivo=True)
    fecha = fecha_iso(d.get("fecha"))
    referencia = texto(d.get("voucher"), "N° de referencia", 60)
    imagen = adjunto(d.get("voucher_b64"), "jpg")

    with db(escritura=True) as (_, cur):
        cur.execute("SELECT rol FROM usuarios WHERE username = %s", (destino,))
        fila = cur.fetchone()
        if not fila or fila["rol"] != "PADRE":
            raise ApiError(404, "El padre de familia indicado no existe.")
        cur.execute("SELECT id FROM pagos WHERE usuario = %s AND voucher = %s AND valor = %s",
                    (destino, referencia, valor))
        if cur.fetchone():
            raise ApiError(409, "Ya existe un pago con esa referencia y ese valor.")
        cur.execute("INSERT INTO pagos (usuario, fecha, voucher, valor, estado, voucher_b64) "
                    "VALUES (%s, %s, %s, %s, 'PENDIENTE', %s)",
                    (destino, fecha, referencia, valor, imagen))
    return jsonify({"exito": True})


@app.route("/api/pagos/validar", methods=["POST"])
@requiere(*STAFF)
def validar_pago():
    pago_id = entero(cuerpo().get("id"), "ID", 1, 2_000_000_000)
    with db(escritura=True) as (_, cur):
        cur.execute("SELECT estado FROM pagos WHERE id = %s", (pago_id,))
        fila = cur.fetchone()
        if not fila:
            raise ApiError(404, "Pago no encontrado.")
        if fila["estado"] == "VALIDADO":
            raise ApiError(409, "Este pago ya fue aprobado.")
        cur.execute("UPDATE pagos SET estado = 'VALIDADO' WHERE id = %s", (pago_id,))
    return jsonify({"exito": True})


def _entregar_archivo(fila, campo):
    if fila and fila.get(campo):
        return jsonify({"exito": True, "base64": limpiar(fila[campo])})
    raise ApiError(404, "Archivo no encontrado.")


@app.route("/api/pagos/ver/<int:id>", methods=["GET"])
@requiere()
def ver_voucher(id):
    with db() as (_, cur):
        cur.execute("SELECT usuario, voucher_b64 FROM pagos WHERE id = %s", (id,))
        fila = cur.fetchone()
    if fila and not es_staff() and fila["usuario"] != g.user["username"]:
        raise ApiError(403, "No tiene permisos para ver este comprobante.")
    return _entregar_archivo(fila, "voucher_b64")


# ───────────────────────── Documentos (contratos) ─────────────────────────
@app.route("/api/documentos", methods=["POST"])
@requiere(*STAFF)
def subir_documento():
    d = cuerpo()
    desc = d.get("desc", d.get("descripcion"))
    prov = d.get("prov", d.get("proveedor"))
    visible = 1 if str(d.get("visible", 1)).lower() in ("1", "true") else 0
    with db(escritura=True) as (_, cur):
        cur.execute(
            "INSERT INTO documentos (tipo, fecha, descripcion, proveedor, valor, archivoNombre, archivoData, visible) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (texto(d.get("tipo", "CONTRATO"), "Tipo", 30), fecha_iso(d.get("fecha")),
             texto(desc, "Descripción", 300), texto(prov, "Proveedor", 150),
             numero(d.get("valor"), "Valor"), texto(d.get("archivoNombre"), "Nombre del archivo", 255),
             adjunto(d.get("archivoData"), "pdf", obligatorio=True), visible))
    return jsonify({"exito": True})


@app.route("/api/documentos/visible", methods=["POST"])
@requiere(*STAFF)
def visible_documento():
    d = cuerpo()
    doc_id = entero(d.get("id"), "ID", 1, 2_000_000_000)
    visible = 1 if str(d.get("visible")).lower() in ("1", "true") else 0
    with db(escritura=True) as (_, cur):
        cur.execute("UPDATE documentos SET visible = %s WHERE id = %s", (visible, doc_id))
    return jsonify({"exito": True})


@app.route("/api/documentos/ver/<int:id>", methods=["GET"])
@requiere()
def ver_documento(id):
    with db() as (_, cur):
        cur.execute("SELECT visible, archivoData FROM documentos WHERE id = %s", (id,))
        fila = cur.fetchone()
    if fila and not es_staff() and not fila["visible"]:
        raise ApiError(403, "Este documento no está disponible.")
    return _entregar_archivo(fila, "archivoData")


# ───────────────────────── Egresos ─────────────────────────
@app.route("/api/egresos", methods=["POST"])
@requiere(*STAFF)
def registrar_egreso():
    d = cuerpo()
    archivo = adjunto(d.get("archivoData"), "pdf")
    with db(escritura=True) as (_, cur):
        cur.execute(
            "INSERT INTO egresos (fecha, descripcion, proveedor, valor, archivoNombre, archivoData, estado_pago) "
            "VALUES (%s, %s, %s, %s, %s, %s, 'PENDIENTE')",
            (fecha_iso(d.get("fecha")), texto(d.get("descripcion"), "Descripción", 300),
             texto(d.get("proveedor"), "Proveedor", 150), numero(d.get("valor"), "Valor", positivo=True),
             texto(d.get("archivoNombre"), "Nombre del archivo", 255, obligatorio=False) if archivo else "",
             archivo))
    return jsonify({"exito": True})


@app.route("/api/egresos/estado", methods=["POST"])
@requiere(*STAFF)
def estado_egreso():
    d = cuerpo()
    egreso_id = entero(d.get("id"), "ID", 1, 2_000_000_000)
    estado = texto(d.get("estado"), "Estado", 10).upper()
    if estado not in ("PENDIENTE", "PAGADO"):
        raise ApiError(400, "Estado inválido.")
    with db(escritura=True) as (_, cur):
        cur.execute("SELECT id FROM egresos WHERE id = %s", (egreso_id,))
        if not cur.fetchone():
            raise ApiError(404, "Egreso no encontrado.")
        cur.execute("UPDATE egresos SET estado_pago = %s WHERE id = %s", (estado, egreso_id))
    return jsonify({"exito": True})


@app.route("/api/egresos/ver/<int:id>", methods=["GET"])
@requiere()
def ver_egreso(id):
    with db() as (_, cur):
        cur.execute("SELECT archivoData FROM egresos WHERE id = %s", (id,))
        return _entregar_archivo(cur.fetchone(), "archivoData")


# ───────────────────────── Actas ─────────────────────────
@app.route("/api/actas", methods=["POST"])
@requiere(*STAFF)
def subir_acta():
    d = cuerpo()
    with db(escritura=True) as (_, cur):
        cur.execute("INSERT INTO actas (fecha, descripcion, archivoNombre, archivoData) VALUES (%s, %s, %s, %s)",
                    (fecha_iso(d.get("fecha")), texto(d.get("descripcion"), "Descripción", 300),
                     texto(d.get("archivoNombre"), "Nombre del archivo", 255),
                     adjunto(d.get("archivoData"), "pdf", obligatorio=True)))
    return jsonify({"exito": True})


@app.route("/api/actas/ver/<int:id>", methods=["GET"])
@requiere()
def ver_acta(id):
    with db() as (_, cur):
        cur.execute("SELECT archivoData FROM actas WHERE id = %s", (id,))
        return _entregar_archivo(cur.fetchone(), "archivoData")


# ───────────────────────── Actividades (ingresos extra) ─────────────────────────
@app.route("/api/actividades", methods=["POST"])
@requiere(*STAFF)
def subir_actividad():
    d = cuerpo()
    with db(escritura=True) as (_, cur):
        cur.execute(
            "INSERT INTO actividades (curso, descripcion, fecha, valor, archivoNombre, archivoData) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (texto(d.get("curso"), "Curso", 30), texto(d.get("descripcion"), "Descripción", 300),
             fecha_iso(d.get("fecha")), numero(d.get("valor"), "Valor", positivo=True),
             texto(d.get("archivoNombre"), "Nombre del archivo", 255),
             adjunto(d.get("archivoData"), "pdf", obligatorio=True)))
    return jsonify({"exito": True})


@app.route("/api/actividades/ver/<int:id>", methods=["GET"])
@requiere()
def ver_actividad(id):
    with db() as (_, cur):
        cur.execute("SELECT curso, archivoData FROM actividades WHERE id = %s", (id,))
        fila = cur.fetchone()
    if fila and not es_staff():
        curso = (fila["curso"] or "").replace(" ", "").upper()
        mio = (g.user.get("curso") or "").replace(" ", "").upper()
        if curso != "TODOS" and curso != mio:
            raise ApiError(403, "No tiene permisos para ver este respaldo.")
    return _entregar_archivo(fila, "archivoData")


# ───────────────────────── Dashboard ─────────────────────────
@app.route("/api/dashboard/curso", methods=["GET"])
@requiere(*STAFF)
def dashboard_curso():
    with db() as (_, cur):
        cur.execute(
            "SELECT u.curso, SUM(p.valor) AS total_recaudado FROM pagos p "
            "INNER JOIN usuarios u ON p.usuario = u.username "
            "WHERE p.estado = 'VALIDADO' GROUP BY u.curso")
        return jsonify({"exito": True, "datos": limpiar_filas(cur.fetchall())})
