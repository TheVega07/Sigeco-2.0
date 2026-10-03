-- SIGECO 28 · Ejecutar UNA vez en la base de datos (Clever Cloud → panel de MySQL / phpMyAdmin)

-- 1) Las contraseñas ahora se guardan cifradas (hash). Necesitan más espacio que antes.
ALTER TABLE usuarios MODIFY password VARCHAR(255) NOT NULL;

-- 2) Los archivos van en Base64: deben ser columnas LONGTEXT (si ya lo son, no pasa nada).
ALTER TABLE pagos       MODIFY voucher_b64  LONGTEXT;
ALTER TABLE egresos     MODIFY archivoData  LONGTEXT;
ALTER TABLE actividades MODIFY archivoData  LONGTEXT;
ALTER TABLE documentos  MODIFY archivoData  LONGTEXT;
ALTER TABLE actas       MODIFY archivoData  LONGTEXT;

-- 3) (Opcional) Índices para que las consultas sigan rápidas al crecer los datos.
CREATE INDEX idx_pagos_usuario ON pagos (usuario);
CREATE INDEX idx_pagos_estado  ON pagos (estado);
-- Si algún índice ya existía, MySQL avisará "Duplicate key name": se puede ignorar.

-- Las contraseñas actuales (texto plano) se convierten a hash AUTOMÁTICAMENTE
-- la próxima vez que cada usuario inicie sesión. No hace falta tocarlas a mano.
