# SIGECO 28 – versión corregida

## Pasos para publicar
1. En **Vercel → Settings → Environment Variables** crea: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT` (3306) y `SECRET_KEY` (texto largo y aleatorio, p. ej. 50+ caracteres).
2. **Cambia la contraseña de MySQL en Clever Cloud** (la anterior quedó expuesta) y usa la nueva en `DB_PASSWORD`.
3. Ejecuta `migracion.sql` en la base de datos (una sola vez).
4. Sube los archivos al repositorio y haz deploy.
5. Las contraseñas actuales se convierten a hash solas cuando cada usuario inicia sesión.
