# openai-oauth en Docker

Imagen para ejecutar [`openai-oauth`](https://github.com/EvanZhouDev/openai-oauth)
con login mediante device-auth o navegador.

La imagen incluye Node.js 22, `@openai/codex`, `openai-oauth`, `curl` y los
certificados CA. `curl` es necesario para que `codex login --device-auth`
pueda completar el flujo de código de dispositivo dentro del contenedor.

## Preparación

```bash
docker compose build --no-cache
```

Durante la construcción se comprueba que `curl`, `codex` y `openai-oauth`
estén instalados y sean ejecutables. El contexto Docker excluye archivos de
credenciales, `.env`, datos locales y dependencias de Node.

En `compose.yaml`, selecciona el método de autenticación:

```yaml
environment:
  LOGIN_MODE: device
```

o:

```yaml
environment:
  LOGIN_MODE: browser
```

También puedes asignar un puerto diferente a cada instancia:

```yaml
environment:
  LOGIN_MODE: device
  PORT: 10532
```

Con `network_mode: host` no debe añadirse `ports`: el servicio escuchará
directamente en `127.0.0.1` y en el puerto indicado. Cada instancia debe usar
un puerto distinto. Los primeros login mediante navegador deben realizarse de
uno en uno, porque el callback OAuth siempre utiliza el puerto `1455`.

## Modelo y comprobación programada

Estas dos opciones son opcionales y se configuran dentro de `compose.yaml`:

```yaml
environment:
  LOGIN_MODE: device
  PORT: 10531
  TZ: Europe/Madrid
  MODEL_TEST: gpt-5.4-mini
  CRON_TEST: "5 4 * * * | 2 4 * * * | 3 4 * * *"
  HEALTHCHECK_TIMEOUT_MS: 30000
```

`MODEL_TEST` solo selecciona el modelo usado por la prueba; no restringe los
modelos publicados por el proxy. `CRON_TEST` programa una petición de prueba
al endpoint local. Se pueden indicar varias expresiones separadas por `|`; el
ejemplo ejecuta la prueba diariamente a las 04:05, 04:02 y 04:03. El resultado
aparece en `docker compose logs`. Si se configura el cron dejando
`MODEL_TEST` vacío, la prueba utiliza el primer modelo devuelto por
`/v1/models`. Para desactivarla, deja `CRON_TEST: ""`.
La expresión se interpreta usando la zona horaria indicada en `TZ`.
Cada petición se cancela después de `HEALTHCHECK_TIMEOUT_MS` milisegundos para
evitar procesos cron bloqueados. Además, Docker comprueba `/health` cada 30
segundos sin consumir una petición de modelo; su estado puede consultarse con
`docker compose ps`.

## Primer arranque

Es conveniente ejecutar el primer inicio adjunto a la terminal para ver las
instrucciones del login:

```bash
docker compose up
```

- `device`: muestra el flujo de device-auth de Codex.
- `browser`: imprime una URL. Ábrela manualmente en el navegador del mismo
  equipo. No se intenta abrir un navegador dentro del contenedor.

Después del login, las credenciales quedan guardadas en el volumen
`openai-oauth-data` y el proxy queda disponible en:

```text
http://127.0.0.1:10531/v1
```

Los siguientes arranques omiten el login automáticamente. Para dejarlo en
segundo plano:

```bash
docker compose up -d
docker compose logs -f
```

## Servidor Docker remoto

Para `LOGIN_MODE=browser`, abre desde tu ordenador un túnel antes del primer
arranque:

```bash
ssh -L 1455:127.0.0.1:1455 usuario@servidor
```

Mantén el túnel abierto, ejecuta `docker compose up` en el servidor y abre en
tu navegador local la URL impresa por el contenedor.

## Publicar la imagen

```bash
docker compose build
docker login
docker compose push
```

## Reiniciar las credenciales

Primero detén el servicio. El siguiente comando elimina exclusivamente el
volumen de este proyecto y obliga a repetir el login:

```bash
docker compose down -v
```

## Seguridad

La configuración predeterminada enlaza el proxy a `127.0.0.1`. No cambies
`HOST` a `0.0.0.0` en una máquina accesible desde Internet sin colocar delante
autenticación y TLS.
